import { afterEach, describe, expect, test } from 'bun:test'
/**
 * ASP-owned continuation probe — tri-state contract (GENUINELY RED).
 *
 * T-04829 Phase 1. This file is INTENTIONALLY RED until larry implements
 * the probe and exports it from the agent-spaces package public surface.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  API contract pinned by this test (for larry's implementation):     │
 * │                                                                     │
 * │  checkContinuationArtifact(                                         │
 * │    ref: { provider: string; key: string },                          │
 * │    options?: { aspHome?: string }                                   │
 * │  ): Promise<'present' | 'missing' | 'unknown'>                     │
 * │                                                                     │
 * │  Tri-state semantics:                                               │
 * │    present  — stat(artifactPath) succeeded; file exists             │
 * │    missing  — provider rules define a deterministic path AND stat   │
 * │               shows the file is definitively absent                 │
 * │    unknown  — provider has no on-disk artifact rule, or the path    │
 * │               cannot be determined; MUST NOT be coerced to          │
 * │               missing or false                                      │
 * │                                                                     │
 * │  List path: stat-only, no file open/parse/validate                 │
 * │  Expensive validation (open + parse) is reserved for get/resume    │
 * │                                                                     │
 * │  Known providers and their artifact paths:                         │
 * │    anthropic — ${aspHome}/conversations/${key}.jsonl                │
 * │    codex / openai — CODEX_HOME/threads/${key}.jsonl                 │
 * │    <other> — unknown (no path rule exists)                          │
 * │                                                                     │
 * │  Export: re-export from agent-spaces/src/index.ts so HRC can       │
 * │  consume without reimplementing provider path rules.                │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * WHY GENUINELY RED:
 *   The import below resolves to `undefined` because the export does not
 *   yet exist in agent-spaces/src/index.ts. Every test in this file will
 *   fail with "expected undefined to be defined" or
 *   "checkContinuationArtifact is not a function" — which is the correct
 *   red failure for a missing implementation.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// GENUINE RED IMPORT — this export does not exist yet.
// larry: add checkContinuationArtifact to agent-spaces/src/ and
// re-export it from agent-spaces/src/index.ts.
import { checkContinuationArtifact } from '../index.js'

// ---------------------------------------------------------------------------
// Temporary directory helpers
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

// ---------------------------------------------------------------------------
// Existence check — immediately fails until impl ships
// ---------------------------------------------------------------------------

describe('checkContinuationArtifact export (T-04829 genuinely RED)', () => {
  test('is exported from the agent-spaces package public surface', () => {
    // This is the primary red gate. If the function is not exported,
    // this test fails with "expected undefined to be defined".
    expect(checkContinuationArtifact).toBeDefined()
    expect(typeof checkContinuationArtifact).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Tri-state contract tests
// ---------------------------------------------------------------------------

describe('tri-state contract: present | missing | unknown (T-04829)', () => {
  test('returns present when artifact file exists for anthropic provider+key', async () => {
    const aspHome = mkTempDir('asp-probe-present-')
    const key = 'claude-session-present-04829'
    // Create the expected artifact at the anthropic path
    mkdirSync(join(aspHome, 'conversations'), { recursive: true })
    writeFileSync(join(aspHome, 'conversations', `${key}.jsonl`), '{"session":"probe"}', 'utf8')

    const result = await checkContinuationArtifact({ provider: 'anthropic', key }, { aspHome })

    expect(result).toBe('present')
  })

  test('returns missing when anthropic provider path rules apply and artifact is absent', async () => {
    const aspHome = mkTempDir('asp-probe-missing-')
    // No file created — the provider path is known but empty
    const key = 'claude-session-absent-04829'

    const result = await checkContinuationArtifact({ provider: 'anthropic', key }, { aspHome })

    expect(result).toBe('missing')
  })

  test('returns unknown for a provider that has no on-disk artifact rule', async () => {
    const aspHome = mkTempDir('asp-probe-unknown-')
    // 'pi-cloud-api' has no local artifact path — cannot determine presence
    const result = await checkContinuationArtifact(
      { provider: 'pi-cloud-api', key: 'some-remote-key' },
      { aspHome }
    )

    expect(result).toBe('unknown')
  })

  test('unknown is NOT coerced to missing', async () => {
    const aspHome = mkTempDir('asp-probe-nocoerce-')

    const result = await checkContinuationArtifact(
      { provider: 'pi-cloud-api', key: 'some-remote-key' },
      { aspHome }
    )

    // Core contract: callers MUST NOT treat unknown as missing/false
    expect(result).not.toBe('missing')
    expect(result).toBe('unknown')
  })

  test('unknown is NOT falsy (guard against boolean coercion)', async () => {
    const aspHome = mkTempDir('asp-probe-truthy-')

    const result = await checkContinuationArtifact(
      { provider: 'pi-cloud-api', key: 'some-remote-key' },
      { aspHome }
    )

    // 'unknown' is a truthy string; no consumer may do `if (!result)` to skip it
    expect(result).toBeTruthy()
    expect(Boolean(result)).toBe(true)
  })

  test('result is one of the three allowed strings and nothing else', async () => {
    const aspHome = mkTempDir('asp-probe-type-')
    const key = 'claude-session-typecheck-04829'

    const result = await checkContinuationArtifact({ provider: 'anthropic', key }, { aspHome })

    expect(['present', 'missing', 'unknown']).toContain(result)
  })
})

// ---------------------------------------------------------------------------
// Stat-only / cheap list path
// ---------------------------------------------------------------------------

describe('stat-only list path: file content is never opened or parsed (T-04829)', () => {
  test('an unreadable file (mode 000) still returns present, proving stat-only access', async () => {
    // If the impl opens the file, it throws EACCES → would return missing or throw.
    // stat() succeeds even on unreadable files, so result must be present.
    const aspHome = mkTempDir('asp-probe-statonly-')
    const key = 'claude-session-statonly-04829'
    mkdirSync(join(aspHome, 'conversations'), { recursive: true })
    const filePath = join(aspHome, 'conversations', `${key}.jsonl`)
    writeFileSync(filePath, 'not-valid-jsonl', 'utf8')
    chmodSync(filePath, 0o000) // unreadable

    try {
      const result = await checkContinuationArtifact({ provider: 'anthropic', key }, { aspHome })
      expect(result).toBe('present')
    } finally {
      chmodSync(filePath, 0o644) // restore for cleanup
    }
  })

  test('a present but invalid artifact file returns present (no parse on list path)', async () => {
    const aspHome = mkTempDir('asp-probe-noparse-')
    const key = 'claude-session-noparse-04829'
    mkdirSync(join(aspHome, 'conversations'), { recursive: true })
    writeFileSync(
      join(aspHome, 'conversations', `${key}.jsonl`),
      'THIS IS NOT JSON\x00BINARY GARBAGE',
      'utf8'
    )

    const result = await checkContinuationArtifact({ provider: 'anthropic', key }, { aspHome })

    // List probe does not validate content — presence is all that matters
    expect(result).toBe('present')
  })
})

// ---------------------------------------------------------------------------
// Codex / OpenAI provider path
// ---------------------------------------------------------------------------

describe('codex/openai provider path (T-04829)', () => {
  test('returns present when codex thread JSONL exists', async () => {
    const aspHome = mkTempDir('asp-probe-codex-present-')
    const codexHome = mkTempDir('codex-home-present-')
    const key = 'thread_T04829_probe'

    // Codex artifacts live in ${CODEX_HOME}/threads/${key}.jsonl (or equivalent)
    mkdirSync(join(codexHome, 'threads'), { recursive: true })
    writeFileSync(join(codexHome, 'threads', `${key}.jsonl`), '{"thread":"probe"}', 'utf8')

    // larry: pass codexHome via options or read from env — document the choice.
    const result = await checkContinuationArtifact(
      { provider: 'codex', key },
      { aspHome, codexHome }
    )

    expect(result).toBe('present')
  })

  test('returns missing when codex thread JSONL does not exist', async () => {
    const aspHome = mkTempDir('asp-probe-codex-missing-')
    const codexHome = mkTempDir('codex-home-missing-')
    const key = 'thread_T04829_absent'

    const result = await checkContinuationArtifact(
      { provider: 'codex', key },
      { aspHome, codexHome }
    )

    expect(result).toBe('missing')
  })
})
