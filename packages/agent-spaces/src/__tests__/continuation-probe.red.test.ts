/**
 * ASP-owned continuation probe — tri-state contract (GENUINELY RED).
 *
 * T-04829 Phase 1 REWORK (daedalus ruling 2026-06-16). This file is
 * INTENTIONALLY RED until larry implements the probe and exports it from
 * the agent-spaces package public surface.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  API contract (daedalus-approved, authoritative for larry's impl):      │
 * │                                                                         │
 * │  checkContinuationArtifact(                                             │
 * │    ref: { provider: string; key: string },                              │
 * │    options?: {                                                           │
 * │      codexHome?: string   // CODEX_HOME override                        │
 * │      claudeHome?: string  // defaults to ~/.claude                      │
 * │      cwd?: string         // required for claude stat-mode              │
 * │      mode?: 'stat' | 'scan'  // default: 'stat' (cheap)                │
 * │    }                                                                    │
 * │  ): Promise<'present' | 'missing' | 'unknown'>                         │
 * │                                                                         │
 * │  Tri-state semantics (authoritative):                                   │
 * │    present  — artifact found by a rule valid for provider + mode        │
 * │    missing  — DEFINITIVELY absent after a deterministic stat OR         │
 * │               bounded scan completed successfully                       │
 * │    unknown  — cannot decide cheaply / provider unsupported /            │
 * │               required context absent / IO error prevents a             │
 * │               definitive answer. NEVER false, NEVER coerced to missing. │
 * │                                                                         │
 * │  REAL on-disk layouts pinned by this test:                              │
 * │                                                                         │
 * │  pi (openai/pi-sdk):                                                    │
 * │    key IS the absolute session file path → single stat()                │
 * │    present if stat succeeds, missing if ENOENT. Cheap; no mode needed. │
 * │                                                                         │
 * │  codex (openai/codex-cli):                                              │
 * │    date-sharded: ${codexHome}/sessions/YYYY/MM/DD/                      │
 * │                  rollout-<ISO-ts>-<uuid>.jsonl                          │
 * │    key = uuid embedded in filename                                      │
 * │    stat mode (cheap): a uuid key CANNOT be single-statted → unknown     │
 * │    scan mode: bounded glob sessions/** for *-${key}.jsonl →             │
 * │               present | missing | unknown (on IO error)                 │
 * │                                                                         │
 * │  anthropic (claude-code):                                               │
 * │    ${claudeHome}/projects/<encoded-cwd>/<session-id>.jsonl              │
 * │    encoded-cwd: replace every non-alphanumeric char with '-'            │
 * │    e.g. /Users/lherron/praesidium → -Users-lherron-praesidium           │
 * │    with cwd supplied: deterministic single stat → present | missing     │
 * │    without cwd (stat mode): MUST return unknown (scan needed, not cheap)│
 * │                                                                         │
 * │  unsupported provider: unknown (no path rule)                           │
 * │                                                                         │
 * │  Export: agent-spaces/src/index.ts (public surface, for HRC consumption)│
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * WHY GENUINELY RED:
 *   Bun throws SyntaxError at module load because 'checkContinuationArtifact'
 *   is not exported from agent-spaces/src/index.ts. All tests in this file
 *   fail for the correct reason: missing implementation.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// GENUINE RED IMPORT — this export does not exist yet.
// larry: implement checkContinuationArtifact and re-export from index.ts.
import { checkContinuationArtifact } from '../index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = []

function mkTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tmpDirs = []
})

/**
 * Encode an absolute path to a Claude project dir name:
 * every non-alphanumeric character → '-'.
 * e.g. /Users/lherron/praesidium → -Users-lherron-praesidium
 */
function encodePathForClaude(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-')
}

// ---------------------------------------------------------------------------
// 0. Export gate — primary red assertion
// ---------------------------------------------------------------------------

describe('checkContinuationArtifact export gate (T-04829 genuinely RED)', () => {
  test('is exported from the agent-spaces package public surface', () => {
    expect(checkContinuationArtifact).toBeDefined()
    expect(typeof checkContinuationArtifact).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// 1. pi provider — key IS the absolute file path, single stat, no mode needed
// ---------------------------------------------------------------------------

describe('pi provider: key = absolute session-file path, cheap stat (T-04829)', () => {
  test('present when the absolute key path exists on disk', async () => {
    const dir = mkTempDir('probe-pi-present-')
    const key = join(dir, 'pi-session-probe-04829.jsonl')
    writeFileSync(key, '{"session":"pi-probe"}', 'utf8')

    const result = await checkContinuationArtifact({ provider: 'pi', key })

    expect(result).toBe('present')
  })

  test('missing when the absolute key path does not exist', async () => {
    const dir = mkTempDir('probe-pi-absent-')
    const key = join(dir, 'pi-session-absent-04829.jsonl')
    // file NOT created

    const result = await checkContinuationArtifact({ provider: 'pi', key })

    expect(result).toBe('missing')
  })
})

// ---------------------------------------------------------------------------
// 2. codex provider — date-sharded sessions tree, uuid embedded in filename
//    stat mode (cheap/list): uuid key → MUST return unknown (scan required)
//    scan mode: bounded sessions/** glob → present | missing | unknown
// ---------------------------------------------------------------------------

describe('codex provider — stat mode (cheap): uuid key → unknown (T-04829)', () => {
  test('a uuid key in stat mode returns unknown, NEVER missing (scan required to find it)', async () => {
    const codexHome = mkTempDir('codex-home-stat-')
    // Even if the file exists, stat mode cannot resolve uuid → path without a scan.
    // The contract mandates unknown, not a lucky hit.
    const key = 'codex-probe-stat-T04829'

    const result = await checkContinuationArtifact(
      { provider: 'codex', key },
      { codexHome, mode: 'stat' }
    )

    expect(result).toBe('unknown')
    expect(result).not.toBe('missing')
  })
})

describe('codex provider — scan mode: date-sharded sessions tree (T-04829)', () => {
  // Real path structure: ${codexHome}/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl
  const SCAN_DATE = '2026/06/16'
  const SCAN_ISO = '2026-06-16T12:00:00.000Z'

  test('present when rollout-<ISO>-<uuid>.jsonl exists in the date-sharded sessions tree', async () => {
    const codexHome = mkTempDir('codex-home-scan-present-')
    const key = 'codex-probe-scan-present-T04829'
    const sessionDir = join(codexHome, 'sessions', ...SCAN_DATE.split('/'))
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, `rollout-${SCAN_ISO}-${key}.jsonl`),
      '{"thread":"probe"}',
      'utf8'
    )

    const result = await checkContinuationArtifact(
      { provider: 'codex', key },
      { codexHome, mode: 'scan' }
    )

    expect(result).toBe('present')
  })

  test('missing when no rollout-*-<uuid>.jsonl exists anywhere under sessions/', async () => {
    const codexHome = mkTempDir('codex-home-scan-missing-')
    // Create the date-sharded dir but no matching file
    const sessionDir = join(codexHome, 'sessions', ...SCAN_DATE.split('/'))
    mkdirSync(sessionDir, { recursive: true })
    // A file with a DIFFERENT uuid — must not match
    writeFileSync(join(sessionDir, `rollout-${SCAN_ISO}-other-uuid.jsonl`), '{}', 'utf8')
    const key = 'codex-probe-scan-absent-T04829'

    const result = await checkContinuationArtifact(
      { provider: 'codex', key },
      { codexHome, mode: 'scan' }
    )

    expect(result).toBe('missing')
  })

  test('unknown when the sessions/ dir is unreadable (IO prevents a definitive answer)', async () => {
    const codexHome = mkTempDir('codex-home-scan-ioerr-')
    const sessionsDir = join(codexHome, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    chmodSync(sessionsDir, 0o000) // unreadable — scan cannot complete
    const key = 'codex-probe-scan-ioerr-T04829'

    try {
      const result = await checkContinuationArtifact(
        { provider: 'codex', key },
        { codexHome, mode: 'scan' }
      )

      // IO error during scan must yield unknown, not a false missing
      expect(result).toBe('unknown')
    } finally {
      chmodSync(sessionsDir, 0o755)
    }
  })
})

// ---------------------------------------------------------------------------
// 3. anthropic/claude provider — ${claudeHome}/projects/<encoded-cwd>/<key>.jsonl
//    WITH cwd: deterministic single stat
//    WITHOUT cwd (stat mode): unknown (needs cross-project scan, not cheap)
// ---------------------------------------------------------------------------

describe('anthropic/claude provider — with cwd supplied (T-04829)', () => {
  test('present when ${claudeHome}/projects/<encoded-cwd>/<key>.jsonl exists', async () => {
    const claudeHome = mkTempDir('claude-home-present-')
    const cwd = mkTempDir('cwd-present-')
    const key = 'claude-session-present-04829'
    const encodedCwd = encodePathForClaude(cwd)
    const projectDir = join(claudeHome, 'projects', encodedCwd)
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, `${key}.jsonl`), '{"session":"probe"}', 'utf8')

    const result = await checkContinuationArtifact(
      { provider: 'anthropic', key },
      { claudeHome, cwd }
    )

    expect(result).toBe('present')
  })

  test('missing when ${claudeHome}/projects/<encoded-cwd>/<key>.jsonl does not exist', async () => {
    const claudeHome = mkTempDir('claude-home-missing-')
    const cwd = mkTempDir('cwd-missing-')
    const key = 'claude-session-absent-04829'
    const encodedCwd = encodePathForClaude(cwd)
    // Create the project dir but not the session file
    mkdirSync(join(claudeHome, 'projects', encodedCwd), { recursive: true })

    const result = await checkContinuationArtifact(
      { provider: 'anthropic', key },
      { claudeHome, cwd }
    )

    expect(result).toBe('missing')
  })

  test('pins the cwd encoding rule: every non-alphanumeric char → "-"', async () => {
    // Prove the encoding is applied correctly by checking that the probe
    // finds a file placed at the encoded path, not the raw cwd path.
    const claudeHome = mkTempDir('claude-home-encoding-')
    const cwd = '/Users/lherron/praesidium/agent-spaces'
    // encoded: -Users-lherron-praesidium-agent-spaces
    const expectedEncoded = '-Users-lherron-praesidium-agent-spaces'
    const key = 'claude-session-encoding-04829'
    const projectDir = join(claudeHome, 'projects', expectedEncoded)
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, `${key}.jsonl`), '{}', 'utf8')

    const result = await checkContinuationArtifact(
      { provider: 'anthropic', key },
      { claudeHome, cwd }
    )

    // Verifies the probe used the encoded path, not a raw-cwd path
    expect(result).toBe('present')
    expect(encodePathForClaude(cwd)).toBe(expectedEncoded)
  })
})

describe('anthropic/claude provider — WITHOUT cwd in stat mode → unknown (T-04829)', () => {
  test('returns unknown when no cwd is supplied (cross-project scan not cheap)', async () => {
    const claudeHome = mkTempDir('claude-home-nocwd-')
    const key = 'claude-session-nocwd-04829'
    // Even if a session file exists somewhere, without cwd the path is non-deterministic
    // in stat mode → must return unknown, never missing

    const result = await checkContinuationArtifact(
      { provider: 'anthropic', key },
      { claudeHome }
      // mode defaults to 'stat'; cwd NOT supplied
    )

    expect(result).toBe('unknown')
    expect(result).not.toBe('missing')
  })
})

// ---------------------------------------------------------------------------
// 4. Unsupported provider — no path rule → unknown
// ---------------------------------------------------------------------------

describe('unsupported provider → unknown, never missing or false (T-04829)', () => {
  test('returns unknown for a provider with no on-disk artifact rule', async () => {
    const result = await checkContinuationArtifact({
      provider: 'pi-cloud-api',
      key: 'some-remote-key',
    })

    expect(result).toBe('unknown')
  })

  test('unknown is NOT coerced to missing', async () => {
    const result = await checkContinuationArtifact({
      provider: 'pi-cloud-api',
      key: 'some-remote-key',
    })

    expect(result).not.toBe('missing')
  })

  test('unknown is NOT falsy — guard against if (!result) coercion by callers', async () => {
    const result = await checkContinuationArtifact({
      provider: 'pi-cloud-api',
      key: 'some-remote-key',
    })

    expect(result).toBeTruthy()
    expect(Boolean(result)).toBe(true)
  })

  test('result is always one of the three allowed strings', async () => {
    const claudeHome = mkTempDir('claude-probe-type-')
    const cwd = mkTempDir('cwd-type-')
    const key = 'claude-session-type-04829'

    const result = await checkContinuationArtifact(
      { provider: 'anthropic', key },
      { claudeHome, cwd }
    )

    expect(['present', 'missing', 'unknown']).toContain(result)
  })
})

// ---------------------------------------------------------------------------
// 5. Stat-only / cheap list path proof
//    An existing but unreadable file (mode 000) must return present:
//    stat() succeeds even when the file cannot be opened or read.
//    This pins that the list path NEVER opens or parses file contents.
// ---------------------------------------------------------------------------

describe('stat-only proof: present is returned even for unreadable files (T-04829)', () => {
  test('pi provider: unreadable file (mode 000) → present (stat succeeds, never opens)', async () => {
    const dir = mkTempDir('probe-pi-statonly-')
    const key = join(dir, 'pi-session-unreadable-04829.jsonl')
    writeFileSync(key, 'not-valid-jsonl-binary\x00garbage', 'utf8')
    chmodSync(key, 0o000)

    try {
      const result = await checkContinuationArtifact({ provider: 'pi', key })
      // stat(key) succeeds; content is never read
      expect(result).toBe('present')
    } finally {
      chmodSync(key, 0o644)
    }
  })

  test('anthropic provider: unreadable file (mode 000) → present when cwd supplied', async () => {
    const claudeHome = mkTempDir('claude-home-statonly-')
    const cwd = mkTempDir('cwd-statonly-')
    const key = 'claude-session-statonly-04829'
    const encodedCwd = encodePathForClaude(cwd)
    const projectDir = join(claudeHome, 'projects', encodedCwd)
    mkdirSync(projectDir, { recursive: true })
    const filePath = join(projectDir, `${key}.jsonl`)
    writeFileSync(filePath, 'THIS IS NOT JSON\x00BINARY GARBAGE', 'utf8')
    chmodSync(filePath, 0o000)

    try {
      const result = await checkContinuationArtifact(
        { provider: 'anthropic', key },
        { claudeHome, cwd }
      )
      expect(result).toBe('present')
    } finally {
      chmodSync(filePath, 0o644)
    }
  })
})
