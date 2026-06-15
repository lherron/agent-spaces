/**
 * Tests for run helpers.
 *
 * WHY: Ensures the public helpers have basic coverage so bun test succeeds
 * and verifies core reference parsing behavior relied on by CLI callers.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as spacesConfig from 'spaces-config'
import {
  getLegacyProjectHarnessOutputPath,
  getProjectHarnessOutputPath,
  resolveEffectiveCompose,
} from 'spaces-config'
import type { AgentRuntimeProfile, SpaceRefString, TargetDefinition } from 'spaces-config'
import { harnessRegistry } from './harness/index.js'
import {
  ensureCodexProjectTrust,
  getProjectCodexRuntimeHomePath,
  isSpaceReference,
  migrateLegacyProjectCodexRuntimeHome,
  migrateLegacyProjectHarnessOutput,
  prepareCodexRuntimeHome,
} from './run.js'
import * as runModule from './run.js'

let tempDirs: string[] = []

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

describe('migrateLegacyProjectHarnessOutput', () => {
  test('moves old path-hashed project target bundles into the shared scope home', async () => {
    const root = await createTempDir('run-migrate-bundle-')
    const aspHome = join(root, 'asp-home')
    const projectPath = join(root, 'agent-spaces')
    const legacyOutput = getLegacyProjectHarnessOutputPath(projectPath, 'larry', 'codex', aspHome)
    const outputPath = getProjectHarnessOutputPath(projectPath, 'larry', 'codex', aspHome)

    await mkdir(legacyOutput, { recursive: true })
    await writeFile(join(legacyOutput, 'state.json'), 'legacy-state\n')

    await migrateLegacyProjectHarnessOutput(aspHome, projectPath, 'larry', 'codex', outputPath)

    expect(await readFile(join(outputPath, 'state.json'), 'utf-8')).toBe('legacy-state\n')
    await expect(stat(legacyOutput)).rejects.toThrow()
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
    await writeFile(join(templateHome, 'config.toml'), 'model = "gpt-5.5"\n')
    await writeFile(
      join(templateHome, 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command:
                    'if [ -n "${HRC_LAUNCH_HOOK_CLI:-}" ]; then bun "$HRC_LAUNCH_HOOK_CLI"; fi',
                  statusMessage: 'capturing Codex turn',
                },
              ],
            },
          ],
        },
      })
    )
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
    expect(config).toContain('model = "gpt-5.5"')
    expect(config).toContain(`[projects.${JSON.stringify(projectPath)}]`)
    const runtimeHookKey = `${await realpath(join(runtimeHome, 'hooks.json'))}:stop:0:0`
    const templateHookKey = `${await realpath(join(templateHome, 'hooks.json'))}:stop:0:0`
    expect(config).toContain(`[hooks.state.${JSON.stringify(runtimeHookKey)}]`)
    expect(config).toContain('trusted_hash = "sha256:')
    expect(config).not.toContain(templateHookKey)

    const metadata = JSON.parse(
      await readFile(join(runtimeHome, '.asp-runtime.json'), 'utf-8')
    ) as { mode: string; targetName: string; projectPath: string }
    expect(metadata.mode).toBe('project')
    expect(metadata.targetName).toBe('codex')
    expect(metadata.projectPath).toBe(projectPath)
  })

  test('uses codexRuntimeTargetName for stable project runtime homes outside project-target output', async () => {
    const root = await createTempDir('run-agent-project-runtime-')
    const aspHome = join(root, 'asp-home')
    const projectPath = join(root, 'agent-spaces')
    const bundleRoot = join(aspHome, 'snapshots', 'abc123', 'codex')
    const templateHome = join(bundleRoot, 'codex.home')
    const runtimeHome = getProjectCodexRuntimeHomePath(aspHome, projectPath, 'cody')

    await mkdir(join(templateHome, 'skills'), { recursive: true })
    await mkdir(join(templateHome, 'prompts'), { recursive: true })
    await writeFile(join(templateHome, 'AGENTS.md'), 'fresh agents\n')
    await writeFile(join(templateHome, 'config.toml'), 'model = "gpt-5.5"\n')
    await writeFile(join(templateHome, 'manifest.json'), '{"name":"cody"}\n')

    const resolvedRuntime = await prepareCodexRuntimeHome(
      {
        harnessId: 'codex',
        targetName: 'placement-cody',
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
        codexRuntimeTargetName: 'cody',
      }
    )

    expect(resolvedRuntime).toBe(runtimeHome)

    const metadata = JSON.parse(
      await readFile(join(runtimeHome, '.asp-runtime.json'), 'utf-8')
    ) as { mode: string; targetName: string; projectPath: string }
    expect(metadata.mode).toBe('project')
    expect(metadata.targetName).toBe('cody')
    expect(metadata.projectPath).toBe(projectPath)
  })

  test('keeps ad-hoc codex runtime home path keyed by cwd hash', async () => {
    const root = await createTempDir('run-adhoc-runtime-')
    const aspHome = join(root, 'asp-home')
    const cwd = join(root, 'scratch')
    const bundleRoot = join(aspHome, 'snapshots', 'abc123', 'codex')
    const templateHome = join(bundleRoot, 'codex.home')
    await mkdir(join(templateHome, 'skills'), { recursive: true })
    await mkdir(join(templateHome, 'prompts'), { recursive: true })
    await writeFile(join(templateHome, 'AGENTS.md'), 'fresh agents\n')
    await writeFile(join(templateHome, 'config.toml'), 'model = "gpt-5.5"\n')
    await writeFile(join(templateHome, 'manifest.json'), '{"name":"scratch"}\n')

    const resolvedRuntime = await prepareCodexRuntimeHome(
      {
        harnessId: 'codex',
        targetName: 'scratch',
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
        cwd,
      }
    )

    const key = createHash('sha256')
      .update(`codex-runtime-v1\0scratch\0${resolve(cwd)}`)
      .digest('hex')
      .slice(0, 24)
    expect(resolvedRuntime).toBe(join(aspHome, 'codex-homes', key, 'home'))
  })

  // T-03939: the materialized system prompt + session reminder reach codex via
  // the home AGENTS.md (NOT the visible launch message). Two tasks share one
  // CODEX_HOME; the now-static (task-id-free) system prompt must land exactly
  // once, and a changed prompt must self-heal the stale block.
  test('writes the praesidium block into AGENTS.md and reuses one home across tasks', async () => {
    const root = await createTempDir('run-praesidium-home-')
    const aspHome = join(root, 'asp-home')
    const projectPath = join(root, 'agent-spaces')
    const bundleRoot = join(aspHome, 'snapshots', 'abc123', 'codex')
    const templateHome = join(bundleRoot, 'codex.home')
    const runtimeHome = getProjectCodexRuntimeHomePath(aspHome, projectPath, 'cody')

    await mkdir(join(templateHome, 'skills'), { recursive: true })
    await mkdir(join(templateHome, 'prompts'), { recursive: true })
    await writeFile(join(templateHome, 'AGENTS.md'), '<!-- Generated by agent-spaces. -->\n')
    await writeFile(join(templateHome, 'config.toml'), 'model = "gpt-5.5"\n')
    await writeFile(join(templateHome, 'manifest.json'), '{"name":"cody"}\n')

    const bundle = {
      harnessId: 'codex' as const,
      targetName: 'placement-cody',
      rootDir: bundleRoot,
      pluginDirs: [templateHome],
      codex: {
        homeTemplatePath: templateHome,
        configPath: join(templateHome, 'config.toml'),
        agentsPath: join(templateHome, 'AGENTS.md'),
        skillsDir: join(templateHome, 'skills'),
        promptsDir: join(templateHome, 'prompts'),
      },
    }
    const staticSystemPrompt =
      '# Praesidium Platform\nYou are cody.\n## Runtime scope\n- ScopeRef: agent:cody:project:agent-spaces'
    const reminder = '## Agent memory\nwrkq has 3 open tasks.'

    // Task A (e.g. cody@agent-spaces:T-1).
    await prepareCodexRuntimeHome(bundle, {
      aspHome,
      projectPath,
      codexRuntimeTargetName: 'cody',
      systemPrompt: staticSystemPrompt,
      reminderContent: reminder,
    })

    const afterA = await readFile(join(runtimeHome, 'AGENTS.md'), 'utf-8')
    expect(afterA).toContain('<!-- Generated by agent-spaces. -->')
    expect(afterA).toContain('You are cody.')
    expect(afterA).toContain('wrkq has 3 open tasks.')
    // Exactly one praesidium block.
    expect((afterA.match(/<!-- BEGIN praesidium-context -->/g) ?? []).length).toBe(1)
    // No task-scoped identity ever lands in the shared home.
    expect(afterA).not.toContain(':task:')
    expect(afterA).not.toMatch(/Handle:/)

    // Mark session state to prove the fingerprint-bust rebuild never nukes it.
    await mkdir(join(runtimeHome, 'sessions'), { recursive: true })
    await writeFile(join(runtimeHome, 'sessions', 'keep.jsonl'), 'session state\n')

    // Task B reuses the SAME home with the SAME (static) prompt: fingerprint
    // matches → no rewrite → still exactly one block, identical bytes.
    await prepareCodexRuntimeHome(bundle, {
      aspHome,
      projectPath,
      codexRuntimeTargetName: 'cody',
      systemPrompt: staticSystemPrompt,
      reminderContent: reminder,
    })
    const afterB = await readFile(join(runtimeHome, 'AGENTS.md'), 'utf-8')
    expect(afterB).toBe(afterA)
    expect((afterB.match(/<!-- BEGIN praesidium-context -->/g) ?? []).length).toBe(1)

    // A changed prompt busts the fingerprint → the stale block self-heals
    // (old content gone, exactly one fresh block) WITHOUT destroying session state.
    await prepareCodexRuntimeHome(bundle, {
      aspHome,
      projectPath,
      codexRuntimeTargetName: 'cody',
      systemPrompt: '# Praesidium Platform\nYou are cody, revised.',
      reminderContent: reminder,
    })
    const afterC = await readFile(join(runtimeHome, 'AGENTS.md'), 'utf-8')
    expect(afterC).toContain('You are cody, revised.')
    expect(afterC).not.toContain('You are cody.\n')
    expect((afterC.match(/<!-- BEGIN praesidium-context -->/g) ?? []).length).toBe(1)
    expect(await readFile(join(runtimeHome, 'sessions', 'keep.jsonl'), 'utf-8')).toBe(
      'session state\n'
    )
  })
})

describe('system prompt threading (T-01016)', () => {
  test('RunResult exposes systemPromptMode, reminderContent, and maxChars', () => {
    // Structural gate: the RunResult type must keep these prompt-threading
    // fields. Removing one would fail this construction at typecheck time.
    const result: runModule.RunResult = {
      build: {
        pluginDirs: [],
        warnings: [],
        lock: {
          lockfileVersion: 1,
          resolverVersion: 1,
          generatedAt: '2026-01-01T00:00:00Z',
          registry: { type: 'git', url: 'local' },
          spaces: {},
          targets: {},
        },
      },
      exitCode: 0,
      systemPromptMode: 'append',
      reminderContent: 'reminder',
      maxChars: 8192,
    }
    expect(result.systemPromptMode).toBe('append')
    expect(result.reminderContent).toBe('reminder')
    expect(result.maxChars).toBe(8192)
  })
})

describe('run() install selection field sets (T-04621)', () => {
  async function writeProject(projectPath: string, body: string): Promise<void> {
    await mkdir(projectPath, { recursive: true })
    await writeFile(join(projectPath, 'asp-targets.toml'), body)
    await writeFile(
      join(projectPath, 'asp-lock.json'),
      JSON.stringify(
        {
          lockfileVersion: 1,
          resolverVersion: 1,
          generatedAt: '2026-06-15T00:00:00.000Z',
          registry: {
            type: 'git',
            url: 'local',
            defaultBranch: 'main',
          },
          spaces: {},
          targets: {
            dev: {
              compose: ['space:project@dev'],
              roots: [],
              loadOrder: [],
              envHash: 'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
            },
          },
        },
        null,
        2
      )
    )
  }

  function makeAdapter() {
    return {
      id: 'claude',
      name: 'T-04621 adapter',
      models: [{ id: 'claude-test', default: true }],
      detect: async () => ({ available: true, path: '/bin/echo' }),
      validateSpace: () => ({ ok: true }),
      materializeSpace: async () => ({ artifactPath: '/unused' }),
      composeTarget: async () => ({ bundle: { harnessId: 'claude', targetName: 'dev' } }),
      buildRunArgs: () => ['run'],
      getTargetOutputPath: (root: string, targetName: string) =>
        join(root, targetName, 'claude-output'),
      loadTargetBundle: async (outputDir: string, targetName: string) => ({
        harnessId: 'claude',
        targetName,
        rootDir: outputDir,
        pluginDirs: [],
      }),
      getRunEnv: () => ({ HARNESS_ENV: '1' }),
      getDefaultRunOptions: () => ({}),
    }
  }

  test('compose installs pass the narrow materializeFromRefs field set', async () => {
    const root = await createTempDir('run-install-compose-')
    const aspHome = join(root, 'asp-home')
    const projectPath = join(root, 'project-compose')
    const agentsDir = join(root, 'agents')
    await writeAgentProfile(
      agentsDir,
      'dev',
      `
schema_version = 2

[spaces]
base = ["space:agent@dev"]
`
    )
    await writeFile(join(agentsDir, 'dev', 'SOUL.md'), 'T-04621 test soul\n')
    await writeProject(
      projectPath,
      `
schema = 1
agents-root = "${agentsDir}"

[targets.dev]
compose = ["space:project@dev"]
compose_mode = "merge"
`
    )

    const adapter = makeAdapter()
    const installCalls: Record<string, unknown>[] = []
    const materializeCalls: Record<string, unknown>[] = []
    const harnessSpy = spyOn(harnessRegistry, 'getOrThrow').mockImplementation(
      () => adapter as never
    )
    const installSpy = spyOn(spacesConfig, 'install').mockImplementation(
      async (options: Record<string, unknown>) => {
        installCalls.push(options)
        return { materializations: [{ target: 'dev', outputPath: '/materialized/install/dev' }] }
      }
    )
    const materializeSpy = spyOn(spacesConfig, 'materializeFromRefs').mockImplementation(
      async (options: Record<string, unknown>) => {
        materializeCalls.push(options)
        return { materialization: { outputPath: '/materialized/compose/dev' } }
      }
    )

    try {
      await runModule.run('dev', {
        projectPath,
        aspHome,
        refresh: true,
        inheritProject: true,
        inheritUser: false,
        prompt: 'caller prompt must not leak into materialize options',
        interactive: false,
        dryRun: true,
      })
    } finally {
      harnessSpy.mockRestore()
      installSpy.mockRestore()
      materializeSpy.mockRestore()
    }

    expect(installCalls).toHaveLength(0)
    expect(materializeCalls).toHaveLength(1)

    const selection = materializeCalls[0]!
    expect(Object.keys(selection).sort()).toEqual(
      [
        'adapter',
        'agentRoot',
        'aspHome',
        'fetchRegistry',
        'harness',
        'inheritProject',
        'inheritUser',
        'lockPath',
        'materializationIdentity',
        'projectPath',
        'projectRoot',
        'refresh',
        'refs',
        'registryPath',
        'targetName',
      ].sort()
    )
    expect(selection).toMatchObject({
      targetName: 'dev',
      refs: ['space:agent@dev', 'space:project@dev'],
      lockPath: join(projectPath, 'asp-lock.json'),
      projectPath,
      harness: 'claude',
      adapter,
      fetchRegistry: false,
      agentRoot: join(agentsDir, 'dev'),
      materializationIdentity: {
        agentId: 'dev',
        projectId: 'project-compose',
        frontend: 'claude',
      },
      aspHome,
      refresh: true,
      inheritProject: true,
      inheritUser: false,
      projectRoot: projectPath,
    })
  })

  test('non-compose installs pass the broader configInstall field set', async () => {
    const root = await createTempDir('run-install-non-compose-')
    const aspHome = join(root, 'asp-home')
    const projectPath = join(root, 'project-install')
    await writeProject(
      projectPath,
      `
schema = 1

[targets.dev]
compose = ["space:project@dev"]
`
    )

    const adapter = makeAdapter()
    const installCalls: Record<string, unknown>[] = []
    const materializeCalls: Record<string, unknown>[] = []
    const harnessSpy = spyOn(harnessRegistry, 'getOrThrow').mockImplementation(
      () => adapter as never
    )
    const installSpy = spyOn(spacesConfig, 'install').mockImplementation(
      async (options: Record<string, unknown>) => {
        installCalls.push(options)
        return { materializations: [{ target: 'dev', outputPath: '/materialized/install/dev' }] }
      }
    )
    const materializeSpy = spyOn(spacesConfig, 'materializeFromRefs').mockImplementation(
      async (options: Record<string, unknown>) => {
        materializeCalls.push(options)
        return { materialization: { outputPath: '/materialized/compose/dev' } }
      }
    )

    try {
      await runModule.run('dev', {
        projectPath,
        aspHome,
        refresh: true,
        inheritProject: true,
        inheritUser: false,
        prompt: 'caller prompt stays on install options',
        interactive: false,
        dryRun: true,
      })
    } finally {
      harnessSpy.mockRestore()
      installSpy.mockRestore()
      materializeSpy.mockRestore()
    }

    expect(materializeCalls).toHaveLength(0)
    expect(installCalls).toHaveLength(1)

    const selection = installCalls[0]!
    expect(Object.keys(selection).sort()).toEqual(
      [
        'adapter',
        'aspHome',
        'dryRun',
        'fetchRegistry',
        'harness',
        'inheritProject',
        'inheritUser',
        'interactive',
        'projectPath',
        'prompt',
        'refresh',
        'registryPath',
        'targets',
      ].sort()
    )
    expect(selection).toMatchObject({
      projectPath,
      aspHome,
      refresh: true,
      inheritProject: true,
      inheritUser: false,
      prompt: 'caller prompt stays on install options',
      interactive: false,
      dryRun: true,
      harness: 'claude',
      targets: ['dev'],
      registryPath: expect.any(String),
      adapter,
      fetchRegistry: false,
    })
  })
})

describe('placement runtime planner (T-01097)', () => {
  test('planPlacementRuntime is exported and callable', async () => {
    const planPlacementRuntime = (runModule as Record<string, unknown>)['planPlacementRuntime']
    expect(planPlacementRuntime).toBeDefined()
    expect(typeof planPlacementRuntime).toBe('function')
  })

  test('planPlacementRuntime resolves frontend, harness, model, and runOptions', async () => {
    const aspHome = await createTempDir('placement-plan-')
    const placement = {
      bundle: { kind: 'agent-project' as const, agentName: 'test-agent' },
    } as unknown as Parameters<typeof runModule.planPlacementRuntime>[0]['placement']
    const placementContext = {
      materialization: { manifest: undefined, effectiveConfig: undefined },
      resolvedBundle: { cwd: aspHome },
    } as unknown as Parameters<typeof runModule.planPlacementRuntime>[0]['placementContext']

    const plan = await runModule.planPlacementRuntime({
      placement,
      placementContext,
      frontend: 'claude-code',
      aspHome,
    })

    expect(plan.frontend).toBe('claude-code')
    expect(plan.harnessId).toBe('claude')
    expect(plan.cwd).toBe(aspHome)
    expect(plan.runOptions.aspHome).toBe(aspHome)
    expect(plan.runOptions.projectPath).toBe(aspHome)
    expect(plan.runOptions.cwd).toBe(aspHome)
    // Model resolution returns the discriminated union shape
    expect(plan.model.ok === true || plan.model.ok === false).toBe(true)
  })

  test('planPlacementRuntime throws on unknown frontend', async () => {
    const aspHome = await createTempDir('placement-plan-bad-')
    const placement = {
      bundle: { kind: 'agent-project' as const, agentName: 'x' },
    } as unknown as Parameters<typeof runModule.planPlacementRuntime>[0]['placement']
    const placementContext = {
      materialization: { manifest: undefined, effectiveConfig: undefined },
      resolvedBundle: { cwd: aspHome },
    } as unknown as Parameters<typeof runModule.planPlacementRuntime>[0]['placementContext']

    await expect(
      runModule.planPlacementRuntime({
        placement,
        placementContext,
        frontend: 'no-such-frontend' as never,
        aspHome,
      })
    ).rejects.toThrow(/Unknown harness frontend/)
  })
})

describe('project-target runtime planner (T-01099)', () => {
  test('planProjectTargetRuntime resolves a project target into a runtime plan', async () => {
    const { planProjectTargetRuntime } = await import('./run/placement-plan.js')
    const aspHome = await createTempDir('proj-target-plan-')
    const manifest = {
      schema: 1 as const,
      targets: {
        my_target: {
          compose: ['space:defaults@stable' as SpaceRefString],
          priming_prompt: 'hello',
        },
      },
    }

    const plan = planProjectTargetRuntime(manifest, 'my_target', {
      aspHome,
      harness: 'claude',
    })

    expect(plan.harnessId).toBe('claude')
    expect(plan.adapter.id).toBe('claude')
    expect(plan.target).toEqual(manifest.targets.my_target)
    expect(plan.defaultPrompt).toBe('hello')
  })

  test('combinePrompts merges priming prompt and user prompt', async () => {
    const { combinePrompts } = await import('./run/util.js')

    expect(combinePrompts('priming', 'user')).toBe('priming\n\nuser')
    expect(combinePrompts('priming', undefined)).toBe('priming')
    expect(combinePrompts(undefined, 'user')).toBe('user')
    expect(combinePrompts(undefined, undefined)).toBeUndefined()
  })

  test('resolveRunEnvFlags enables compiler by default with explicit escape hatch', async () => {
    const { resolveRunEnvFlags } = await import('./run/util.js')

    expect(resolveRunEnvFlags({}).viaCompiler).toBe(true)
    expect(resolveRunEnvFlags({ ASP_RUN_VIA_COMPILER: '0' }).viaCompiler).toBe(false)
    expect(resolveRunEnvFlags({ ASP_RUN_VIA_COMPILER: 'false' }).viaCompiler).toBe(false)
    expect(resolveRunEnvFlags({ ASP_RUN_VIA_COMPILER: '1' }).viaCompiler).toBe(true)
    expect(resolveRunEnvFlags({ ASP_RUN_VIA_COMPILER: 'true' }).viaCompiler).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Agent-local skills/commands discovery threading (T-01067)
//
// RED GATE: execution must detect agent-root `skills/` and `commands/`
// directories and thread that payload into materializeFromRefs().
//
// Pass condition:
// - run.ts exports detectAgentLocalComponents(agentRoot)
// - helper returns undefined when neither directory exists
// - helper reports hasSkills/hasCommands and absolute paths for each combo
// - run() computes `agentLocalComponents` and passes it to materializeFromRefs
// ---------------------------------------------------------------------------

const detectAgentLocalComponents = (runModule as Record<string, unknown>)[
  'detectAgentLocalComponents'
] as
  | ((agentRoot: string) => Promise<
      | {
          agentRoot: string
          agentName: string
          hasSkills: boolean
          hasCommands: boolean
          hasTools: boolean
          skillsDir: string
          commandsDir: string
          toolsDir: string
          toolsBinDir: string
          agentVarDir: string
        }
      | undefined
    >)
  | undefined

describe('agent-local component discovery (T-01067)', () => {
  test('detectAgentLocalComponents is exported from run.ts', () => {
    expect(detectAgentLocalComponents).toBeDefined()
    expect(typeof detectAgentLocalComponents).toBe('function')
  })

  test('returns undefined when agent root has neither skills nor commands', async () => {
    const agentRoot = await createTempDir('smokey-agent-local-none-')

    expect(detectAgentLocalComponents).toBeDefined()
    await expect(detectAgentLocalComponents!(agentRoot)).resolves.toBeUndefined()
  })

  test('detects skills-only agent roots', async () => {
    const agentRoot = await createTempDir('smokey-agent-local-skills-')
    await mkdir(join(agentRoot, 'skills', 'review-code'), { recursive: true })
    await writeFile(join(agentRoot, 'skills', 'review-code', 'SKILL.md'), '# review\n')

    expect(detectAgentLocalComponents).toBeDefined()
    await expect(detectAgentLocalComponents!(agentRoot)).resolves.toEqual({
      agentRoot,
      agentName: basename(agentRoot),
      hasSkills: true,
      hasCommands: false,
      hasTools: false,
      skillsDir: join(agentRoot, 'skills'),
      commandsDir: join(agentRoot, 'commands'),
      toolsDir: join(agentRoot, 'tools'),
      toolsBinDir: join(agentRoot, 'tools', 'bin'),
      agentVarDir: join(agentRoot, 'var'),
    })
  })

  test('detects commands-only agent roots', async () => {
    const agentRoot = await createTempDir('smokey-agent-local-commands-')
    await mkdir(join(agentRoot, 'commands'), { recursive: true })
    await writeFile(join(agentRoot, 'commands', 'deploy.md'), '# deploy\n')

    expect(detectAgentLocalComponents).toBeDefined()
    await expect(detectAgentLocalComponents!(agentRoot)).resolves.toEqual({
      agentRoot,
      agentName: basename(agentRoot),
      hasSkills: false,
      hasCommands: true,
      hasTools: false,
      skillsDir: join(agentRoot, 'skills'),
      commandsDir: join(agentRoot, 'commands'),
      toolsDir: join(agentRoot, 'tools'),
      toolsBinDir: join(agentRoot, 'tools', 'bin'),
      agentVarDir: join(agentRoot, 'var'),
    })
  })

  test('detects agent roots with both skills and commands', async () => {
    const agentRoot = await createTempDir('smokey-agent-local-both-')
    await mkdir(join(agentRoot, 'skills', 'triage'), { recursive: true })
    await mkdir(join(agentRoot, 'commands'), { recursive: true })
    await writeFile(join(agentRoot, 'skills', 'triage', 'SKILL.md'), '# triage\n')
    await writeFile(join(agentRoot, 'commands', 'deploy.md'), '# deploy\n')

    expect(detectAgentLocalComponents).toBeDefined()
    await expect(detectAgentLocalComponents!(agentRoot)).resolves.toEqual({
      agentRoot,
      agentName: basename(agentRoot),
      hasSkills: true,
      hasCommands: true,
      hasTools: false,
      skillsDir: join(agentRoot, 'skills'),
      commandsDir: join(agentRoot, 'commands'),
      toolsDir: join(agentRoot, 'tools'),
      toolsBinDir: join(agentRoot, 'tools', 'bin'),
      agentVarDir: join(agentRoot, 'var'),
    })
  })

  test('detects tools-only agent roots', async () => {
    const agentRoot = await createTempDir('smokey-agent-local-tools-')
    await mkdir(join(agentRoot, 'tools', 'bin'), { recursive: true })

    expect(detectAgentLocalComponents).toBeDefined()
    const components = await detectAgentLocalComponents!(agentRoot)
    expect(components).toMatchObject({
      agentRoot,
      agentName: basename(agentRoot),
      hasSkills: false,
      hasCommands: false,
      hasTools: true,
      skillsDir: join(agentRoot, 'skills'),
      commandsDir: join(agentRoot, 'commands'),
      toolsDir: join(agentRoot, 'tools'),
      toolsBinDir: join(agentRoot, 'tools', 'bin'),
      agentVarDir: join(agentRoot, 'var'),
    })
  })

  test('does not detect var-only agent roots', async () => {
    const agentRoot = await createTempDir('smokey-agent-local-var-')
    await mkdir(join(agentRoot, 'var', 'state'), { recursive: true })

    await expect(detectAgentLocalComponents!(agentRoot)).resolves.toBeUndefined()
  })

  test('does not detect tools/bin when it is a file', async () => {
    const agentRoot = await createTempDir('smokey-agent-local-tools-file-')
    await mkdir(join(agentRoot, 'tools'), { recursive: true })
    await writeFile(join(agentRoot, 'tools', 'bin'), '')

    await expect(detectAgentLocalComponents!(agentRoot)).resolves.toBeUndefined()
  })

  test('detectAgentLocalComponents has the signature run() expects', async () => {
    // Structural gate: run() in run.ts threads the detector's return value
    // into materializeFromRefs as `agentLocalComponents`. That call site
    // requires a Promise<{ hasSkills, hasCommands, ... } | undefined>.
    const agentRoot = await createTempDir('agent-local-signature-')
    await mkdir(join(agentRoot, 'skills'), { recursive: true })

    expect(detectAgentLocalComponents).toBeDefined()
    const components = await detectAgentLocalComponents!(agentRoot)
    expect(components).toBeDefined()
    expect(components!.agentRoot).toBe(agentRoot)
    expect(typeof components!.hasSkills).toBe('boolean')
    expect(typeof components!.hasCommands).toBe('boolean')
    expect(typeof components!.hasTools).toBe('boolean')
    expect(typeof components!.skillsDir).toBe('string')
    expect(typeof components!.commandsDir).toBe('string')
    expect(typeof components!.toolsDir).toBe('string')
    expect(typeof components!.toolsBinDir).toBe('string')
    expect(typeof components!.agentVarDir).toBe('string')
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
      codex: { model: 'gpt-5.5-codex' },
    }

    expect(resolveAgentRunDefaults).toBeDefined()
    const defaults = resolveAgentRunDefaults!('animata', target, { agentsRoot: agentsDir })
    expect(defaults).toBeDefined()
    expect(defaults!.codex).toBeDefined()
    // Target model wins
    expect(defaults!.codex!['model']).toBe('gpt-5.5-codex')
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
