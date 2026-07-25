import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RUNTIME_STATE_STATUS_VALUES,
  RUNTIME_STATUS_VALUES,
  isRuntimeStateStatus,
  isRuntimeStatus,
} from '../src/index.ts'

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

const EXPECTED_HRC_RUNTIME_STATE_JSON_STATUSES = ['awaiting_input', 'stale', 'terminated'] as const

const EXPECTED_HRC_RUNTIME_ROW_STATUSES = [
  ...EXPECTED_HRC_RUNTIME_STATE_JSON_STATUSES,
  'dead',
  'adopted',
] as const

function collectSourceFiles(hrcRoot: string, root: string): string[] {
  if (!existsSync(root)) return []
  const entries = readdirSync(root)
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry)
    const rel = relative(hrcRoot, path)
    if (
      rel.includes('/__tests__/') ||
      rel.includes('/validation/') ||
      rel.includes('/docs/') ||
      rel.includes('/node_modules/')
    ) {
      continue
    }
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(hrcRoot, path))
    } else if (path.endsWith('.ts')) {
      files.push(path)
    }
  }
  return files
}

function readHrcSource(hrcRoot: string): string {
  const sourceRoots = [
    join(hrcRoot, 'packages/hrc-server/src'),
    join(hrcRoot, 'packages/hrc-core/src'),
    join(hrcRoot, 'packages/hrc-store-sqlite/src'),
  ]
  return sourceRoots
    .flatMap((root) => collectSourceFiles(hrcRoot, root))
    .map((path) => `\n// ${relative(hrcRoot, path)}\n${readFileSync(path, 'utf8')}`)
    .join('\n')
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
      const hrcSource = readHrcSource(hrcRoot)

      for (const status of EXPECTED_HRC_RUNTIME_STATE_JSON_STATUSES) {
        expect(hrcSource).toContain(`status: '${status}'`)
        expect(RUNTIME_STATE_STATUS_VALUES).toContain(status)
        expect(RUNTIME_STATUS_VALUES).toContain(status)
      }

      for (const status of EXPECTED_HRC_RUNTIME_ROW_STATUSES) {
        expect(hrcSource).toContain(`status: '${status}'`)
        expect(RUNTIME_STATUS_VALUES).toContain(status)
      }

      expect(RUNTIME_STATE_STATUS_VALUES).not.toContain('adopted')
      expect(RUNTIME_STATE_STATUS_VALUES).not.toContain('dead')
      expect(RUNTIME_STATE_STATUS_VALUES).not.toContain('zombied')
      expect(RUNTIME_STATUS_VALUES).not.toContain('zombied')
      expect(hrcSource).toContain("status: 'zombied'")
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
