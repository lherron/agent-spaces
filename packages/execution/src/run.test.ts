/**
 * Tests for run helpers.
 *
 * WHY: Ensures the public helpers have basic coverage so bun test succeeds
 * and verifies core reference parsing behavior relied on by CLI callers.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test } from 'bun:test'
import { getProjectHarnessOutputPath, resolveEffectiveCompose } from 'spaces-config'
import type { AgentRuntimeProfile, SpaceRefString, TargetDefinition } from 'spaces-config'
import {
  ensureCodexProjectTrust,
  getProjectCodexRuntimeHomePath,
  isSpaceReference,
  migrateLegacyProjectCodexRuntimeHome,
  prepareCodexRuntimeHome,
} from './run.js'
// Agent-profile integration: import run module as namespace for testing new exports
import * as runModule from './run.js'

let tempDirs: string[] = []
const SOURCE_DIR = dirname(fileURLToPath(import.meta.url))

afterEach(async () => {
  await Promise.all(tempDirs.map((path) => rm(path, { recursive: true, force: true })))
  tempDirs = []
})

async function createTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(path)
  return path
}

describe('isSpaceReference', () => {
  test('returns true for valid space refs', () => {
    expect(isSpaceReference('space:base@dev')).toBe(true)
  })

  test('returns false for non-space strings', () => {
    expect(isSpaceReference('not-a-space-ref')).toBe(false)
  })
})

describe('ensureCodexProjectTrust', () => {
  test('appends a trusted project entry when one is missing', () => {
    const config = 'model = "gpt-5.3-codex"\n'
    const updated = ensureCodexProjectTrust(config, '/tmp/project')

    expect(updated).toContain('[projects."/tmp/project"]')
    expect(updated).toContain('trust_level = "trusted"')
  })

  test('does not duplicate an existing project trust entry', () => {
    const config = [
      'model = "gpt-5.3-codex"',
      '',
      '[projects."/tmp/project"]',
      'trust_level = "trusted"',
      '',
    ].join('\n')

    const updated = ensureCodexProjectTrust(config, '/tmp/project')
    expect(updated).toBe(config)
  })
})

describe('getProjectCodexRuntimeHomePath', () => {
  test('builds a readable runtime path from project basename and target name', () => {
    const runtimeHome = getProjectCodexRuntimeHomePath(
      '/tmp/asp-home',
      '/Users/example/Control Plane',
      'Code Review'
    )

    expect(runtimeHome).toBe('/tmp/asp-home/codex-homes/control-plane_code-review')
  })
})

describe('migrateLegacyProjectCodexRuntimeHome', () => {
  test('moves a legacy asp_modules runtime into ASP_HOME', async () => {
    const root = await createTempDir('run-migrate-')
    const aspHome = join(root, 'asp-home')
    const projectPath = join(root, 'project')
    const legacyRuntime = join(projectPath, 'asp_modules', 'animata', 'codex', 'codex.runtime')
    await mkdir(join(legacyRuntime, 'sessions'), { recursive: true })
    await writeFile(join(legacyRuntime, 'sessions', 'session.jsonl'), 'session-data\n')

    const runtimeHome = await migrateLegacyProjectCodexRuntimeHome(aspHome, projectPath, 'animata')

    expect(runtimeHome).toBe(join(aspHome, 'codex-homes', 'project_animata'))
    expect(await readFile(join(runtimeHome, 'sessions', 'session.jsonl'), 'utf-8')).toBe(
      'session-data\n'
    )
    await expect(stat(legacyRuntime)).rejects.toThrow()
  })
})

describe('prepareCodexRuntimeHome', () => {
  test('refreshes managed files into the persistent project runtime and preserves Codex state', async () => {
    const root = await createTempDir('run-runtime-')
    const aspHome = join(root, 'asp-home')
    const projectPath = join(root, 'control-plane')
    const bundleRoot = getProjectHarnessOutputPath(projectPath, 'codex', 'codex', aspHome)
    const templateHome = join(bundleRoot, 'codex.home')
    const runtimeHome = getProjectCodexRuntimeHomePath(aspHome, projectPath, 'codex')

    await mkdir(join(templateHome, 'skills', 'fresh-skill'), { recursive: true })
    await mkdir(join(templateHome, 'prompts'), { recursive: true })
    await writeFile(join(templateHome, 'AGENTS.md'), 'fresh agents\n')
    await writeFile(join(templateHome, 'config.toml'), 'model = "gpt-5.4"\n')
    await writeFile(join(templateHome, 'manifest.json'), '{"name":"codex"}\n')
    await writeFile(join(templateHome, 'skills', 'fresh-skill', 'SKILL.md'), 'fresh skill\n')
    await writeFile(join(templateHome, 'prompts', 'review.md'), 'fresh prompt\n')

    await mkdir(join(runtimeHome, 'skills', 'stale-skill'), { recursive: true })
    await mkdir(join(runtimeHome, 'sessions'), { recursive: true })
    await writeFile(join(runtimeHome, 'skills', 'stale-skill', 'SKILL.md'), 'stale skill\n')
    await writeFile(join(runtimeHome, 'sessions', 'keep.jsonl'), 'session state\n')

    const resolvedRuntime = await prepareCodexRuntimeHome(
      {
        harnessId: 'codex',
        targetName: 'codex',
        rootDir: bundleRoot,
        pluginDirs: [templateHome],
        codex: {
          homeTemplatePath: templateHome,
          configPath: join(templateHome, 'config.toml'),
          agentsPath: join(templateHome, 'AGENTS.md'),
          skillsDir: join(templateHome, 'skills'),
          promptsDir: join(templateHome, 'prompts'),
        },
      },
      {
        aspHome,
        projectPath,
      }
    )

    expect(resolvedRuntime).toBe(runtimeHome)
    expect(await readFile(join(runtimeHome, 'AGENTS.md'), 'utf-8')).toBe('fresh agents\n')
    expect(await readFile(join(runtimeHome, 'skills', 'fresh-skill', 'SKILL.md'), 'utf-8')).toBe(
      'fresh skill\n'
    )
    expect(await readFile(join(runtimeHome, 'sessions', 'keep.jsonl'), 'utf-8')).toBe(
      'session state\n'
    )
    await expect(stat(join(runtimeHome, 'skills', 'stale-skill'))).rejects.toThrow()

    const config = await readFile(join(runtimeHome, 'config.toml'), 'utf-8')
    expect(config).toContain('model = "gpt-5.4"')
    expect(config).toContain(`[projects.${JSON.stringify(projectPath)}]`)

    const metadata = JSON.parse(
      await readFile(join(runtimeHome, '.asp-runtime.json'), 'utf-8')
    ) as { mode: string; targetName: string; projectPath: string }
    expect(metadata.mode).toBe('project')
    expect(metadata.targetName).toBe('codex')
    expect(metadata.projectPath).toBe(projectPath)
  })
})

describe('system prompt threading (T-01016)', () => {
  test('run.ts threads systemPromptMode through HarnessRunOptions and RunResult', async () => {
    // Red gate for Step 4: execution must preserve replace vs append semantics
    // from runtime materialization to harness invocation and dry-run reporting.
    const source = await readFile(join(SOURCE_DIR, 'run.ts'), 'utf-8')

    expect(source).toContain('systemPromptMode')
  })
})

// ---------------------------------------------------------------------------
// Agent-profile integration tests for asp run (T-00995)
//
// RED GATE: These tests verify that `asp run` merges agent-profile.toml
// defaults into run options. They are expected to FAIL until run.ts exports
// `resolveAgentRunDefaults()` and wires it into the run() pipeline.
//
// Pass condition: Larry implements resolveAgentRunDefaults in run.ts that
// loads ~/agents/<target>/agent-profile.toml and returns merged defaults
// including yolo, model, harness, claude/codex options, and compose.
//
// See ASP_RUN_GAPS.md for full specification of each gap.
// ---------------------------------------------------------------------------

/** Helper: access resolveAgentRunDefaults from run.ts (may not exist yet). */
const resolveAgentRunDefaults = (runModule as Record<string, unknown>)['resolveAgentRunDefaults'] as
  | ((
      targetName: string,
      target: TargetDefinition | undefined,
      options?: { agentsRoot?: string }
    ) =>
      | {
          yolo?: boolean
          model?: string
          harness?: string
          claude?: Record<string, unknown>
          codex?: Record<string, unknown>
          compose?: SpaceRefString[]
        }
      | undefined)
  | undefined

/** Helper: write an agent-profile.toml into a temp agents dir. */
async function writeAgentProfile(
  agentsDir: string,
  agentName: string,
  toml: string
): Promise<void> {
  const agentDir = join(agentsDir, agentName)
  await mkdir(agentDir, { recursive: true })
  await writeFile(join(agentDir, 'agent-profile.toml'), toml)
}

describe('agent-profile integration (asp run gaps)', () => {
  // -------------------------------------------------------------------------
  // Precondition: resolveAgentRunDefaults must exist as an export from run.ts
  // -------------------------------------------------------------------------
  test('resolveAgentRunDefaults is exported from run.ts', () => {
    // RED: This function does not exist yet. run.ts must export it.
    expect(resolveAgentRunDefaults).toBeDefined()
    expect(typeof resolveAgentRunDefaults).toBe('function')
  })

  // -------------------------------------------------------------------------
  // Gap 1: yolo falls back to profile.harnessDefaults.yolo
  //
  // When target and CLI both omit yolo, asp run should read
  // profile.harnessDefaults.yolo from the agent's agent-profile.toml.
  // Regression: animan lost yolo=true after Phase 5 migration.
  // -------------------------------------------------------------------------
  test('gap 1: yolo falls back to profile.harnessDefaults.yolo when target/CLI omit it', async () => {
    const agentsDir = await createTempDir('smokey-agents-yolo-')
    await writeAgentProfile(
      agentsDir,
      'animan',
      `
schema_version = 2

[harnessDefaults]
yolo = true
`
    )

    // Target has no yolo set
    const target: TargetDefinition = {
      compose: ['space:defaults@stable' as SpaceRefString],
    }

    // RED: resolveAgentRunDefaults doesn't exist yet
    expect(resolveAgentRunDefaults).toBeDefined()
    const defaults = resolveAgentRunDefaults!('animan', target, { agentsRoot: agentsDir })
    expect(defaults).toBeDefined()
    expect(defaults!.yolo).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Gap 2: model falls back to profile.harnessDefaults.model
  //
  // Precedence: CLI --model > target-level model > profile.harnessDefaults.model
  // When no CLI or target model is set, the profile default should apply.
  // -------------------------------------------------------------------------
  test('gap 2: model falls back to profile.harnessDefaults.model when CLI/target omit it', async () => {
    const agentsDir = await createTempDir('smokey-agents-model-')
    await writeAgentProfile(
      agentsDir,
      'larry',
      `
schema_version = 2

[harnessDefaults]
model = "claude-opus-4-6"
`
    )

    // Target has no model
    const target: TargetDefinition = {
      compose: ['space:defaults@stable' as SpaceRefString],
    }

    expect(resolveAgentRunDefaults).toBeDefined()
    const defaults = resolveAgentRunDefaults!('larry', target, { agentsRoot: agentsDir })
    expect(defaults).toBeDefined()
    expect(defaults!.model).toBe('claude-opus-4-6')
  })

  test('gap 2: target-level model overrides profile.harnessDefaults.model', async () => {
    const agentsDir = await createTempDir('smokey-agents-model-prec-')
    await writeAgentProfile(
      agentsDir,
      'larry',
      `
schema_version = 2

[harnessDefaults]
model = "claude-opus-4-6"
`
    )

    // Target specifies a codex model — should take precedence
    const target: TargetDefinition = {
      compose: ['space:defaults@stable' as SpaceRefString],
      codex: { model: 'gpt-5.3-codex' },
    }

    expect(resolveAgentRunDefaults).toBeDefined()
    const defaults = resolveAgentRunDefaults!('larry', target, { agentsRoot: agentsDir })
    expect(defaults).toBeDefined()
    // Target codex.model should win over profile harnessDefaults.model
    expect(defaults!.model).toBe('gpt-5.3-codex')
  })

  // -------------------------------------------------------------------------
  // Gap 3: harness-specific defaults merge from profile under target overrides
  //
  // profile.harnessDefaults.codex provides defaults; target.codex overrides
  // individual fields. The result should be a field-level merge.
  // -------------------------------------------------------------------------
  test('gap 3: codex defaults from profile merge under target overrides', async () => {
    const agentsDir = await createTempDir('smokey-agents-codex-')
    await writeAgentProfile(
      agentsDir,
      'animata',
      `
schema_version = 2

[harnessDefaults.codex]
model = "gpt-5.3-codex"
model_reasoning_effort = "medium"
approval_policy = "on-failure"
sandbox_mode = "workspace-write"
`
    )

    // Target overrides only model — other codex defaults should come from profile
    const target: TargetDefinition = {
      compose: ['space:defaults@stable' as SpaceRefString],
      codex: { model: 'gpt-5.4-codex' },
    }

    expect(resolveAgentRunDefaults).toBeDefined()
    const defaults = resolveAgentRunDefaults!('animata', target, { agentsRoot: agentsDir })
    expect(defaults).toBeDefined()
    expect(defaults!.codex).toBeDefined()
    // Target model wins
    expect(defaults!.codex!['model']).toBe('gpt-5.4-codex')
    // Profile defaults fill in the rest
    expect(defaults!.codex!['model_reasoning_effort']).toBe('medium')
    expect(defaults!.codex!['approval_policy']).toBe('on-failure')
    expect(defaults!.codex!['sandbox_mode']).toBe('workspace-write')
  })

  test('gap 3: claude defaults from profile merge under target overrides', async () => {
    const agentsDir = await createTempDir('smokey-agents-claude-')
    await writeAgentProfile(
      agentsDir,
      'smokey',
      `
schema_version = 2

[harnessDefaults.claude]
model = "claude-sonnet-4-6"
permission_mode = "plan"
`
    )

    // Target overrides permission_mode only
    const target: TargetDefinition = {
      compose: ['space:defaults@stable' as SpaceRefString],
      claude: { permission_mode: 'bypassPermissions' },
    }

    expect(resolveAgentRunDefaults).toBeDefined()
    const defaults = resolveAgentRunDefaults!('smokey', target, { agentsRoot: agentsDir })
    expect(defaults).toBeDefined()
    expect(defaults!.claude).toBeDefined()
    // Target override wins
    expect(defaults!.claude!['permission_mode']).toBe('bypassPermissions')
    // Profile default fills in
    expect(defaults!.claude!['model']).toBe('claude-sonnet-4-6')
  })

  // -------------------------------------------------------------------------
  // Gap 4: identity.harness is used when no --harness flag and no target harness
  //
  // When an agent's profile specifies identity.harness = "codex", asp run
  // should select codex as the harness rather than the default ("claude").
  // -------------------------------------------------------------------------
  test('gap 4: identity.harness is used when no --harness and no target harness', async () => {
    const agentsDir = await createTempDir('smokey-agents-harness-')
    await writeAgentProfile(
      agentsDir,
      'larry',
      `
schema_version = 2

[identity]
display = "Larry"
role = "implementer"
harness = "codex"
`
    )

    const target: TargetDefinition = {
      compose: ['space:defaults@stable' as SpaceRefString],
    }

    expect(resolveAgentRunDefaults).toBeDefined()
    const defaults = resolveAgentRunDefaults!('larry', target, { agentsRoot: agentsDir })
    expect(defaults).toBeDefined()
    expect(defaults!.harness).toBe('codex')
  })

  // -------------------------------------------------------------------------
  // Gap 5: compose_mode = "merge" merges agent profile spaces with project
  //
  // When a target has compose_mode = "merge", the agent's profile spaces
  // should be combined with the project compose (deduplicated).
  // This tests resolveEffectiveCompose directly — it already works, but
  // run.ts doesn't call it. The RED test verifies the integration path.
  // -------------------------------------------------------------------------
  test('gap 5: compose_mode merge combines agent profile spaces with project compose', async () => {
    const agentsDir = await createTempDir('smokey-agents-compose-')
    await writeAgentProfile(
      agentsDir,
      'smokey',
      `
schema_version = 2

[spaces]
base = ["space:smokey@dev"]
`
    )

    const target: TargetDefinition = {
      compose: ['space:defaults@stable' as SpaceRefString, 'space:project@dev' as SpaceRefString],
      compose_mode: 'merge',
    }

    // First: verify resolveEffectiveCompose itself works correctly (this should pass)
    const profile: AgentRuntimeProfile = {
      schemaVersion: 2,
      spaces: { base: ['space:smokey@dev' as SpaceRefString] },
    }
    const merged = resolveEffectiveCompose(profile, target, 'task')
    expect(merged).toContain('space:smokey@dev' as SpaceRefString)
    expect(merged).toContain('space:defaults@stable' as SpaceRefString)
    expect(merged).toContain('space:project@dev' as SpaceRefString)

    // Second: verify that resolveAgentRunDefaults returns the merged compose
    // RED: resolveAgentRunDefaults doesn't exist yet
    expect(resolveAgentRunDefaults).toBeDefined()
    const defaults = resolveAgentRunDefaults!('smokey', target, { agentsRoot: agentsDir })
    expect(defaults).toBeDefined()
    expect(defaults!.compose).toBeDefined()
    expect(defaults!.compose).toContain('space:smokey@dev' as SpaceRefString)
    expect(defaults!.compose).toContain('space:defaults@stable' as SpaceRefString)
    expect(defaults!.compose).toContain('space:project@dev' as SpaceRefString)
  })

  // -------------------------------------------------------------------------
  // Gap 6 (T-00996): target-level harness precedence
  //
  // Precedence: CLI --harness > target.harness > profile.identity.harness > DEFAULT_HARNESS
  //
  // RED GATE: TargetDefinition does not have a `harness` field yet.
  // resolveAgentRunDefaults must thread target.harness into the result.
  //
  // Pass condition: Larry adds `harness?: string` to TargetDefinition,
  // updates mergeAgentWithProjectTarget to prefer target.harness over
  // profile.identity.harness, and run.ts already chains via
  // options.harness ?? agentDefaults.harness ?? DEFAULT_HARNESS.
  // -------------------------------------------------------------------------

  test('gap 6a: target-level harness overrides profile identity.harness', async () => {
    const agentsDir = await createTempDir('smokey-agents-tgt-harness-')
    await writeAgentProfile(
      agentsDir,
      'larry',
      `
schema_version = 2

[identity]
display = "Larry"
role = "implementer"
harness = "codex"
`
    )

    // Target explicitly sets harness = "claude-code" → should override profile's "codex"
    const target: TargetDefinition = {
      compose: ['space:defaults@stable' as SpaceRefString],
      harness: 'claude-code',
    } as TargetDefinition // cast needed: harness field does not exist on TargetDefinition yet

    expect(resolveAgentRunDefaults).toBeDefined()
    const defaults = resolveAgentRunDefaults!('larry', target, { agentsRoot: agentsDir })
    expect(defaults).toBeDefined()
    expect(defaults!.harness).toBe('claude-code')
  })

  test('gap 6b: fallback to profile identity.harness when target has no harness', async () => {
    const agentsDir = await createTempDir('smokey-agents-tgt-harness-fb-')
    await writeAgentProfile(
      agentsDir,
      'larry',
      `
schema_version = 2

[identity]
display = "Larry"
role = "implementer"
harness = "codex"
`
    )

    // Target has no harness field
    const target: TargetDefinition = {
      compose: ['space:defaults@stable' as SpaceRefString],
    }

    expect(resolveAgentRunDefaults).toBeDefined()
    const defaults = resolveAgentRunDefaults!('larry', target, { agentsRoot: agentsDir })
    expect(defaults).toBeDefined()
    // Profile identity.harness should be used as fallback
    expect(defaults!.harness).toBe('codex')
  })

  test('gap 6c: fallback to DEFAULT_HARNESS when neither target nor profile set harness', async () => {
    const agentsDir = await createTempDir('smokey-agents-tgt-harness-def-')
    await writeAgentProfile(
      agentsDir,
      'smokey',
      `
schema_version = 2

[identity]
display = "Smokey"
role = "tester"
`
    )

    // No harness on target or profile
    const target: TargetDefinition = {
      compose: ['space:defaults@stable' as SpaceRefString],
    }

    expect(resolveAgentRunDefaults).toBeDefined()
    const defaults = resolveAgentRunDefaults!('smokey', target, { agentsRoot: agentsDir })
    expect(defaults).toBeDefined()
    // Should fall back to DEFAULT_HARNESS (currently 'claude-code')
    expect(defaults!.harness).toBe('claude-code')
  })

  // NOTE: CLI --harness precedence is tested implicitly at the run() call site:
  // run.ts line ~809: options.harness ?? agentDefaults.harness ?? DEFAULT_HARNESS
  // The CLI --harness feeds options.harness, which always wins. This test validates
  // that resolveAgentRunDefaults does NOT need CLI awareness — run() handles it.
  // A full E2E test of CLI > target > profile > default requires the run() entrypoint.

  // -------------------------------------------------------------------------
  // Fallback: no agent profile → current behavior unchanged
  // -------------------------------------------------------------------------
  test('returns undefined when no agent profile exists for target', async () => {
    const agentsDir = await createTempDir('smokey-agents-empty-')
    // No agent-profile.toml written for 'clod'

    const target: TargetDefinition = {
      compose: ['space:defaults@stable' as SpaceRefString],
    }

    expect(resolveAgentRunDefaults).toBeDefined()
    const defaults = resolveAgentRunDefaults!('clod', target, { agentsRoot: agentsDir })
    expect(defaults).toBeUndefined()
  })
})
