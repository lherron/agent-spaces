/**
 * Characterization tests for refactor safety net T-04617/T-04618.
 *
 * These pin current observable behavior before unifying duplicate profile readers
 * and replacing placement-resolver's best-effort ref-key regexes. Some cases are
 * intentionally odd because parser tolerance is the behavior under test.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigValidationError } from '../core/errors.js'
import { resolvePlacement, resolvePlacementContext } from './placement-resolver.js'
import { resolveSpaceComposition } from './space-composition.js'

function writeAgentRoot(tempDir: string, profileToml?: string): string {
  const agentRoot = join(tempDir, 'agent-root')
  mkdirSync(agentRoot, { recursive: true })
  writeFileSync(join(agentRoot, 'SOUL.md'), '# Test Agent\n')
  if (profileToml !== undefined) {
    writeFileSync(join(agentRoot, 'agent-profile.toml'), profileToml)
  }
  return agentRoot
}

async function typedProfileResult(
  agentRoot: string
): Promise<{ kind: 'returned'; compose: string[] } | { kind: 'threw'; error: unknown }> {
  try {
    const context = await resolvePlacementContext({
      agentRoot,
      dryRun: true,
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: 'test-agent' },
    })
    return {
      kind: 'returned',
      compose: context.materialization.effectiveConfig?.compose ?? [],
    }
  } catch (error) {
    return { kind: 'threw', error }
  }
}

describe('T-04617 loadAgentProfile reader tolerance characterization', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 't04617-profile-readers-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('missing profile returns defaults through both observable paths', async () => {
    const agentRoot = writeAgentRoot(tempDir)

    await expect(
      resolveSpaceComposition({
        agentRoot,
        runMode: 'query',
        bundleSpaces: ['space:bundle@dev'],
      })
    ).resolves.toEqual([{ ref: 'space:bundle@dev', source: 'bundle' }])

    await expect(typedProfileResult(agentRoot)).resolves.toEqual({
      kind: 'returned',
      compose: [],
    })
  })

  test('partial byMode-only profile is tolerated by both readers', async () => {
    const agentRoot = writeAgentRoot(
      tempDir,
      `
schemaVersion = 2

[spaces.byMode.query]
base = ["space:query-only@dev"]
`
    )

    await expect(
      resolveSpaceComposition({
        agentRoot,
        runMode: 'query',
        bundleSpaces: ['space:bundle@dev'],
      })
    ).resolves.toEqual([
      { ref: 'space:query-only@dev', source: 'profile-by-mode' },
      { ref: 'space:bundle@dev', source: 'bundle' },
    ])

    await expect(typedProfileResult(agentRoot)).resolves.toEqual({
      kind: 'returned',
      compose: ['space:query-only@dev'],
    })
  })

  test('schema-less raw profile is accepted by composition but rejected by typed placement', async () => {
    const agentRoot = writeAgentRoot(
      tempDir,
      `
[spaces]
base = ["space:raw-base@dev"]

[spaces.byMode.query]
base = ["space:raw-query@dev"]
`
    )

    await expect(
      resolveSpaceComposition({
        agentRoot,
        runMode: 'query',
        bundleSpaces: ['space:bundle@dev'],
      })
    ).resolves.toEqual([
      { ref: 'space:raw-base@dev', source: 'profile-base' },
      { ref: 'space:raw-query@dev', source: 'profile-by-mode' },
      { ref: 'space:bundle@dev', source: 'bundle' },
    ])

    const result = await typedProfileResult(agentRoot)
    expect(result.kind).toBe('threw')
    if (result.kind === 'threw') {
      expect(result.error).toBeInstanceOf(ConfigValidationError)
      expect(String((result.error as Error).message)).toContain('/schemaVersion')
    }
  })

  test('unknown top-level keys are ignored by composition but rejected by typed placement', async () => {
    const agentRoot = writeAgentRoot(
      tempDir,
      `
schemaVersion = 2
unknown = "still parsed by raw reader"

[spaces]
base = ["space:raw-base@dev"]
`
    )

    await expect(
      resolveSpaceComposition({
        agentRoot,
        runMode: 'query',
        bundleSpaces: ['space:bundle@dev'],
      })
    ).resolves.toEqual([
      { ref: 'space:raw-base@dev', source: 'profile-base' },
      { ref: 'space:bundle@dev', source: 'bundle' },
    ])

    const result = await typedProfileResult(agentRoot)
    expect(result.kind).toBe('threw')
    if (result.kind === 'threw') {
      expect(result.error).toBeInstanceOf(ConfigValidationError)
      expect(String((result.error as Error).message)).toContain('/unknown')
    }
  })

  test('wrong-shaped spaces.base is ignored by composition but rejected by typed placement', async () => {
    const agentRoot = writeAgentRoot(
      tempDir,
      `
schemaVersion = 2

[spaces]
base = "space:not-an-array@dev"
`
    )

    await expect(
      resolveSpaceComposition({
        agentRoot,
        runMode: 'query',
        bundleSpaces: ['space:bundle@dev'],
      })
    ).resolves.toEqual([{ ref: 'space:bundle@dev', source: 'bundle' }])

    const result = await typedProfileResult(agentRoot)
    expect(result.kind).toBe('threw')
    if (result.kind === 'threw') {
      expect(result.error).toBeInstanceOf(ConfigValidationError)
      expect(String((result.error as Error).message)).toContain('/spaces/base')
    }
  })
})

describe('T-04618 deriveSpaceKey malformed-ref characterization', () => {
  let tempDir: string
  let agentRoot: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 't04618-derived-space-key-'))
    agentRoot = writeAgentRoot(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  async function derivedKeyFor(ref: string): Promise<string> {
    const result = await resolvePlacement({
      agentRoot,
      dryRun: true,
      runMode: 'query',
      bundle: { kind: 'compose', compose: [ref as never] },
    })
    return result.spaces[0]?.resolvedKey ?? '<missing>'
  }

  test.each([
    ['space:agent:private-ops', 'private-ops@agent'],
    ['space:agent:private-ops@dev', 'private-ops@agent'],
    ['space:agent:foo@bar@baz', 'foo@agent'],
    ['space:agent:', 'space:agent:'],
    ['space:project:repo-defaults', 'repo-defaults@project'],
    ['space:project:repo-defaults@stable', 'repo-defaults@project'],
    ['space:project:', 'space:project:'],
    ['space:defaults', 'defaults@dev'],
    ['space:defaults@stable', 'defaults@stable'],
    ['space:defaults@git:abc:def', 'defaults@git:abc:def'],
    ['space:foo:bar@dev', 'space:foo:bar@dev'],
    ['invalid', 'invalid'],
    ['space:', 'space:'],
    ['space:@dev', 'space:@dev'],
    ['space:agentless:foo@dev', 'space:agentless:foo@dev'],
    ['space:foo@', 'space:foo@'],
    ['space:foo@@dev', 'foo@@dev'],
    [' space:foo@dev', ' space:foo@dev'],
  ])('maps %p to current resolvedKey %p without throwing', async (ref, expectedKey) => {
    await expect(derivedKeyFor(ref)).resolves.toBe(expectedKey)
  })
})
