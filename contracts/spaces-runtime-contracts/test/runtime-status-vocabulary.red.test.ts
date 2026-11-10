import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RUNTIME_STATE_STATUS_VALUES,
  RUNTIME_STATUS_VALUES,
  isRuntimeStateStatus,
  isRuntimeStatus,
} from '../src/index'

const ASP_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Resolve the hrc-runtime checkout this cross-repo drift check reads (T-06661).
 * Precedence: an explicit `HRC_REPO_ROOT` override, else the `../hrc-runtime`
 * sibling default. Returns `undefined` when the resolved path does not exist —
 * a required under-construction worktree resolves the sibling to a non-existent
 * path, and a no-source-mount room-readiness container (T-06887) has no sibling
 * at all. The caller skips the cross-repo assertion rather than failing an
 * otherwise-green ASP suite; the outside merge gate, where both repos are
 * checked out, still runs it.
 */
function resolveHrcRepoRoot(
  override: string | undefined = process.env['HRC_REPO_ROOT'],
  aspRoot: string = ASP_REPO_ROOT
): string | undefined {
  // The sibling checkout is host state, so it is read only under
  // `just smoke-live` (T-10161); an explicit override still runs anywhere.
  if ((override === undefined || override.length === 0) && process.env['ASP_LIVE_TESTS'] !== '1') {
    return undefined
  }
  const candidate =
    override !== undefined && override.length > 0
      ? resolve(override)
      : resolve(aspRoot, '..', 'hrc-runtime')
  return existsSync(candidate) ? candidate : undefined
}

const HRC_REPO_ROOT = resolveHrcRepoRoot()

if (HRC_REPO_ROOT === undefined) {
  // sibling: hrc-runtime checkout absent — greppable skip marker (roster option 2,
  // taskboard T-06898 precedent). Visible warning so the skip is never silent.
  console.warn(
    'sibling: hrc-runtime checkout absent (no HRC_REPO_ROOT override, no ../hrc-runtime) — ' +
      'skipping the cross-repo runtime-status vocabulary drift check. Set HRC_REPO_ROOT or ' +
      'run under the outside merge gate to exercise it.'
  )
}

const EXPECTED_HRC_RUNTIME_STATE_JSON_STATUSES = [
  'awaiting_input',
  'stale',
  'terminated',
  'crashed',
  'detached',
] as const

// HRC stopped producing 'adopted' when `hrc runtime adopt` was retired (T-10146,
// migration 0121). RUNTIME_STATUS_VALUES still admits it as a legacy readable
// row status, so the contract keeps covering the producer vocabulary.
const EXPECTED_HRC_RUNTIME_ROW_STATUSES = [
  ...EXPECTED_HRC_RUNTIME_STATE_JSON_STATUSES,
  'dead',
] as const

// HRC is Rust native (Lance ruling 2026-11-09, T-13147): the runtime-row
// vocabulary is crates/hrc-store/src/status.rs, and hrc-native writes the
// runtime statuses through it and `turns::set_status`.
const HRC_STATUS_VOCABULARY = 'crates/hrc-store/src/status.rs'
const HRC_NATIVE_SOURCE = 'crates/hrc-native/src'

function collectRustSources(root: string): string[] {
  if (!existsSync(root)) return []
  const files: string[] = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) files.push(...collectRustSources(path))
    else if (path.endsWith('.rs')) files.push(path)
  }
  return files
}

/** The string literals of `pub const <name>: [&str; N] = [...]`, or undefined. */
function rustStrArray(source: string, name: string): string[] | undefined {
  const match = new RegExp(`pub const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\];`).exec(source)
  return match?.[1] === undefined
    ? undefined
    : [...match[1].matchAll(/"([^"]*)"/g)].map((literal) => literal[1] as string)
}

describe('T-05007 runtime status vocabulary contract', () => {
  test('exports closed const-array vocabularies and guards with the split runtime-state vs row semantics', () => {
    expect(RUNTIME_STATE_STATUS_VALUES).toEqual([
      'allocating',
      'compiling',
      'admitted',
      'starting',
      'ready',
      'busy',
      'stopping',
      'stopped',
      'failed',
      'unknown_after_restart',
      'disposed',
      'awaiting_input',
      'stale',
      'terminated',
      'crashed',
      'detached',
    ])

    expect(RUNTIME_STATUS_VALUES).toEqual([...RUNTIME_STATE_STATUS_VALUES, 'dead', 'adopted'])

    for (const value of RUNTIME_STATE_STATUS_VALUES) {
      expect(isRuntimeStateStatus(value)).toBe(true)
      expect(isRuntimeStatus(value)).toBe(true)
    }

    expect(isRuntimeStateStatus('adopted')).toBe(false)
    expect(isRuntimeStatus('adopted')).toBe(true)
    expect(isRuntimeStateStatus('dead')).toBe(false)
    expect(isRuntimeStatus('dead')).toBe(true)
    expect(isRuntimeStateStatus('detached')).toBe(true)
    expect(isRuntimeStatus('detached')).toBe(true)
    expect(isRuntimeStateStatus('zombied')).toBe(false)
    expect(isRuntimeStatus('zombied')).toBe(false)
    expect(isRuntimeStateStatus('custom-plugin-status')).toBe(false)
    expect(isRuntimeStatus('custom-plugin-status')).toBe(false)
  })

  test.skipIf(HRC_REPO_ROOT === undefined)(
    'covers the real HRC producer vocabulary without admitting adjacent result statuses',
    () => {
      // Guarded by skipIf: HRC_REPO_ROOT is defined and exists here.
      const hrcRoot = HRC_REPO_ROOT as string
      const vocabularyPath = join(hrcRoot, HRC_STATUS_VOCABULARY)
      expect(existsSync(vocabularyPath)).toBe(true)
      const nativeFiles = collectRustSources(join(hrcRoot, HRC_NATIVE_SOURCE))
      expect(nativeFiles.length).toBeGreaterThan(0)
      const nativeSource = nativeFiles.map((path) => readFileSync(path, 'utf8')).join('\n')

      // HRC sets awaiting_input on the runtime row through the turn status helper.
      expect(nativeSource).toMatch(/set_status\(\s*db,\s*&ctx\.runtime_id,\s*"awaiting_input"/)
      expect(RUNTIME_STATE_STATUS_VALUES).toContain('awaiting_input')

      // The unavailable runtime-row statuses HRC produces are exactly the
      // expected ones, and the contract admits each of them.
      const unavailable = rustStrArray(readFileSync(vocabularyPath, 'utf8'), 'UNAVAILABLE')
      expect(unavailable).toBeDefined()
      const produced = [...(unavailable ?? [])].sort()
      expect(produced).toEqual(
        EXPECTED_HRC_RUNTIME_ROW_STATUSES.filter((status) => status !== 'awaiting_input').sort()
      )
      const admitted: readonly string[] = RUNTIME_STATUS_VALUES
      for (const status of produced) expect(admitted).toContain(status)
      for (const status of EXPECTED_HRC_RUNTIME_STATE_JSON_STATUSES) {
        expect(RUNTIME_STATE_STATUS_VALUES).toContain(status)
      }

      expect(RUNTIME_STATE_STATUS_VALUES).not.toContain('adopted')
      expect(RUNTIME_STATE_STATUS_VALUES).not.toContain('dead')
      // zombied is a run sweep result HRC writes, not a runtime status.
      expect(nativeSource).toContain('"zombied"')
      expect(produced).not.toContain('zombied')
      expect(RUNTIME_STATE_STATUS_VALUES).not.toContain('zombied')
      expect(RUNTIME_STATUS_VALUES).not.toContain('zombied')
    }
  )
})

describe('HRC repo-root resolution (T-06661)', () => {
  test('honors an explicit HRC_REPO_ROOT override that exists', () => {
    // Override to a directory known to exist (the ASP repo root itself).
    expect(resolveHrcRepoRoot(ASP_REPO_ROOT, ASP_REPO_ROOT)).toBe(ASP_REPO_ROOT)
  })

  test('falls back to the ../hrc-runtime sibling default when no override is set', () => {
    const resolved = resolveHrcRepoRoot('', ASP_REPO_ROOT)
    // Without an override the sibling is host state, read only under
    // `just smoke-live` (T-10161); elsewhere the resolver reports absence.
    if (process.env['ASP_LIVE_TESTS'] !== '1') {
      expect(resolved).toBeUndefined()
      return
    }
    // Presence is environment-dependent; when the sibling exists it must be the
    // sibling path, and when it does not the resolver reports absence.
    if (resolved !== undefined) {
      expect(resolved).toBe(resolve(ASP_REPO_ROOT, '..', 'hrc-runtime'))
    } else {
      expect(existsSync(resolve(ASP_REPO_ROOT, '..', 'hrc-runtime'))).toBe(false)
    }
  })

  test('reports absence when neither the override nor the sibling exists', () => {
    const absent = join(ASP_REPO_ROOT, 'no-such-hrc-runtime-checkout-xyz')
    expect(resolveHrcRepoRoot(absent, ASP_REPO_ROOT)).toBeUndefined()
  })
})
