import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'
import { getProjectHarnessOutputPath } from 'spaces-config'

import { useTempDirs } from '../test/temp-dirs.js'
import {
  ensureCodexProjectTrust,
  getProjectCodexRuntimeHomePath,
  migrateLegacyProjectCodexRuntimeHome,
  prepareCodexRuntimeHome,
} from './run-codex.js'

const createTempDir = useTempDirs()

/** The materialized codex bundle prepareCodexRuntimeHome consumes. */
function codexBundle(bundleRoot: string, targetName: string) {
  const templateHome = join(bundleRoot, 'codex.home')
  return {
    harnessId: 'codex' as const,
    targetName,
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
}

/** Write a codex home template with empty skills/ and prompts/ dirs. */
async function writeCodexTemplate(
  templateHome: string,
  files: { agents: string; config: string; manifest?: string }
): Promise<void> {
  await mkdir(join(templateHome, 'skills'), { recursive: true })
  await mkdir(join(templateHome, 'prompts'), { recursive: true })
  await writeFile(join(templateHome, 'AGENTS.md'), files.agents)
  await writeFile(join(templateHome, 'config.toml'), files.config)
  if (files.manifest !== undefined) {
    await writeFile(join(templateHome, 'manifest.json'), files.manifest)
  }
}

async function readRuntimeMetadata(
  runtimeHome: string
): Promise<{ mode: string; targetName: string; projectPath: string }> {
  return JSON.parse(await readFile(join(runtimeHome, '.asp-runtime.json'), 'utf-8'))
}

function countPraesidiumBlocks(agents: string): number {
  return (agents.match(/<!-- BEGIN praesidium-context -->/g) ?? []).length
}

describe('ensureCodexProjectTrust', () => {
  test('appends a trusted project entry when one is missing', () => {
    const config = 'model = "gpt-5.3-codex"\n'
    const updated = ensureCodexProjectTrust(config, '/tmp/project')

    expect(updated).toContain('[projects."/tmp/project"]')
    expect(updated).toContain('trust_level = "trusted"')
  })

  test('does not duplicate an existing trusted project entry', () => {
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
    const bundle = codexBundle(
      getProjectHarnessOutputPath(projectPath, 'codex', 'codex', aspHome),
      'codex'
    )
    const templateHome = bundle.codex.homeTemplatePath
    const runtimeHome = getProjectCodexRuntimeHomePath(aspHome, projectPath, 'codex')

    await writeCodexTemplate(templateHome, {
      agents: 'fresh agents\n',
      config: 'model = "gpt-5.5"\n',
      manifest: '{"name":"codex"}\n',
    })
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
    await mkdir(join(templateHome, 'skills', 'fresh-skill'), { recursive: true })
    await writeFile(join(templateHome, 'skills', 'fresh-skill', 'SKILL.md'), 'fresh skill\n')
    await writeFile(join(templateHome, 'prompts', 'review.md'), 'fresh prompt\n')

    await mkdir(join(runtimeHome, 'skills', 'stale-skill'), { recursive: true })
    await mkdir(join(runtimeHome, 'sessions'), { recursive: true })
    await writeFile(join(runtimeHome, 'skills', 'stale-skill', 'SKILL.md'), 'stale skill\n')
    await writeFile(join(runtimeHome, 'sessions', 'keep.jsonl'), 'session state\n')

    const resolvedRuntime = await prepareCodexRuntimeHome(bundle, { aspHome, projectPath })

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

    const metadata = await readRuntimeMetadata(runtimeHome)
    expect(metadata.mode).toBe('project')
    expect(metadata.targetName).toBe('codex')
    expect(metadata.projectPath).toBe(projectPath)
  })

  test('publishes concurrent symlinked managed skills as complete versions', async () => {
    const root = await createTempDir('run-runtime-concurrent-managed-dir-')
    const aspHome = join(root, 'asp-home')
    const projectPath = join(root, 'agent-spaces')
    const bundleRoot = join(aspHome, 'snapshots', 'concurrent', 'codex')
    const templateHome = join(bundleRoot, 'codex.home')
    const runtimeHome = getProjectCodexRuntimeHomePath(aspHome, projectPath, 'cody')
    const linkedSkill = join(root, 'linked-explainer')

    await writeCodexTemplate(templateHome, {
      agents: 'agents\n',
      config: 'model = "gpt-5.6-terra"\n',
    })
    await mkdir(linkedSkill, { recursive: true })
    await writeFile(join(linkedSkill, 'SKILL.md'), 'linked skill\n')
    await symlink(linkedSkill, join(templateHome, 'skills', 'explainer'))

    // Every caller uses the same stable agent@project home but a different
    // prompt fingerprint, reproducing the T-08580 collision shape. A managed
    // directory must be a complete published version throughout; its linked
    // entry is deliberately the same kind of symlink as the escaped EEXIST.
    const worker = `
      const { prepareCodexRuntimeHome } = await import(process.env.T08580_RUN_CODEX)
      const aspHome = process.env.T08580_ASP_HOME
      const projectPath = process.env.T08580_PROJECT_PATH
      const templateHome = process.env.T08580_TEMPLATE_HOME
      const bundleRoot = process.env.T08580_BUNDLE_ROOT
      const index = process.env.T08580_WORKER_INDEX
      await prepareCodexRuntimeHome({
        harnessId: 'codex', targetName: 'placement-cody', rootDir: bundleRoot,
        pluginDirs: [templateHome],
        codex: {
          homeTemplatePath: templateHome,
          configPath: templateHome + '/config.toml',
          agentsPath: templateHome + '/AGENTS.md',
          skillsDir: templateHome + '/skills', promptsDir: templateHome + '/prompts',
        },
      }, {
        aspHome, projectPath, codexRuntimeTargetName: 'cody',
        systemPrompt: 'task-static-prompt-' + index,
      })
    `
    const workers = Array.from({ length: 8 }, (_, index) =>
      Bun.spawn({
        cmd: [process.execPath, '--eval', worker],
        cwd: process.cwd(),
        env: {
          ...process.env,
          T08580_RUN_CODEX: new URL('./run-codex.ts', import.meta.url).href,
          T08580_ASP_HOME: aspHome,
          T08580_PROJECT_PATH: projectPath,
          T08580_TEMPLATE_HOME: templateHome,
          T08580_BUNDLE_ROOT: bundleRoot,
          T08580_WORKER_INDEX: String(index),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
    )
    for (const process of workers) {
      expect(await process.exited, await new Response(process.stderr).text()).toBe(0)
    }

    expect((await lstat(join(runtimeHome, 'skills'))).isSymbolicLink()).toBe(true)
    expect((await lstat(join(runtimeHome, 'skills', 'explainer'))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(runtimeHome, 'skills', 'explainer', 'SKILL.md'), 'utf-8')).toBe(
      'linked skill\n'
    )
    expect(await readFile(join(runtimeHome, 'AGENTS.md'), 'utf-8')).toMatch(
      /task-static-prompt-[0-7]/
    )
  })

  test('refreshes the stable home when composed config.toml changes', async () => {
    const root = await createTempDir('run-runtime-config-refresh-')
    const aspHome = join(root, 'asp-home')
    const projectPath = join(root, 'agent-spaces')
    const bundle = codexBundle(
      getProjectHarnessOutputPath(projectPath, 'smokey', 'codex', aspHome),
      'smokey'
    )
    const templateHome = bundle.codex.homeTemplatePath
    const runtimeHome = getProjectCodexRuntimeHomePath(aspHome, projectPath, 'smokey')

    await writeCodexTemplate(templateHome, {
      agents: 'agents\n',
      config: 'model = "gpt-5.6-terra"\n',
    })
    const runOptions = { aspHome, projectPath }

    await prepareCodexRuntimeHome(bundle, runOptions)
    await mkdir(join(runtimeHome, 'sessions'), { recursive: true })
    await writeFile(join(runtimeHome, 'sessions', 'keep.jsonl'), 'session state\n')
    expect(await readFile(join(runtimeHome, 'config.toml'), 'utf-8')).not.toContain(
      'model_reasoning_summary'
    )

    await writeFile(
      join(templateHome, 'config.toml'),
      'model = "gpt-5.6-terra"\nmodel_reasoning_summary = "detailed"\n'
    )
    await prepareCodexRuntimeHome(bundle, runOptions)

    expect(await readFile(join(runtimeHome, 'config.toml'), 'utf-8')).toContain(
      'model_reasoning_summary = "detailed"'
    )
    expect(await readFile(join(runtimeHome, 'sessions', 'keep.jsonl'), 'utf-8')).toBe(
      'session state\n'
    )
  })

  test('uses codexRuntimeTargetName for stable project runtime homes outside project-target output', async () => {
    const root = await createTempDir('run-agent-project-runtime-')
    const aspHome = join(root, 'asp-home')
    const projectPath = join(root, 'agent-spaces')
    const bundle = codexBundle(join(aspHome, 'snapshots', 'abc123', 'codex'), 'placement-cody')
    const runtimeHome = getProjectCodexRuntimeHomePath(aspHome, projectPath, 'cody')

    await writeCodexTemplate(bundle.codex.homeTemplatePath, {
      agents: 'fresh agents\n',
      config: 'model = "gpt-5.5"\n',
      manifest: '{"name":"cody"}\n',
    })

    const resolvedRuntime = await prepareCodexRuntimeHome(bundle, {
      aspHome,
      projectPath,
      codexRuntimeTargetName: 'cody',
    })

    expect(resolvedRuntime).toBe(runtimeHome)

    const metadata = await readRuntimeMetadata(runtimeHome)
    expect(metadata.mode).toBe('project')
    expect(metadata.targetName).toBe('cody')
    expect(metadata.projectPath).toBe(projectPath)
  })

  test('keeps ad-hoc codex runtime home path keyed by cwd hash', async () => {
    const root = await createTempDir('run-adhoc-runtime-')
    const aspHome = join(root, 'asp-home')
    const cwd = join(root, 'scratch')
    const bundle = codexBundle(join(aspHome, 'snapshots', 'abc123', 'codex'), 'scratch')
    await writeCodexTemplate(bundle.codex.homeTemplatePath, {
      agents: 'fresh agents\n',
      config: 'model = "gpt-5.5"\n',
      manifest: '{"name":"scratch"}\n',
    })

    const resolvedRuntime = await prepareCodexRuntimeHome(bundle, { aspHome, cwd })

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
    const bundle = codexBundle(join(aspHome, 'snapshots', 'abc123', 'codex'), 'placement-cody')
    const runtimeHome = getProjectCodexRuntimeHomePath(aspHome, projectPath, 'cody')

    await writeCodexTemplate(bundle.codex.homeTemplatePath, {
      agents: '<!-- Generated by agent-spaces. -->\n',
      config: 'model = "gpt-5.5"\n',
      manifest: '{"name":"cody"}\n',
    })
    const staticSystemPrompt =
      '# Praesidium Platform\nYou are cody.\n## Runtime scope\n- ScopeRef: agent:cody:project:agent-spaces'
    const reminder = '## Agent memory\nwrkq has 3 open tasks.'
    const prepareForTask = (systemPrompt: string) =>
      prepareCodexRuntimeHome(bundle, {
        aspHome,
        projectPath,
        codexRuntimeTargetName: 'cody',
        systemPrompt,
        reminderContent: reminder,
      })

    // Task A (e.g. cody@agent-spaces:T-1).
    await prepareForTask(staticSystemPrompt)

    const afterA = await readFile(join(runtimeHome, 'AGENTS.md'), 'utf-8')
    expect(afterA).toContain('<!-- Generated by agent-spaces. -->')
    expect(afterA).toContain('You are cody.')
    expect(afterA).toContain('wrkq has 3 open tasks.')
    // Exactly one praesidium block.
    expect(countPraesidiumBlocks(afterA)).toBe(1)
    // No task-scoped identity ever lands in the shared home.
    expect(afterA).not.toContain(':task:')
    expect(afterA).not.toMatch(/Handle:/)

    // Mark session state to prove the fingerprint-bust rebuild never nukes it.
    await mkdir(join(runtimeHome, 'sessions'), { recursive: true })
    await writeFile(join(runtimeHome, 'sessions', 'keep.jsonl'), 'session state\n')

    // Task B reuses the SAME home with the SAME (static) prompt: fingerprint
    // matches → no rewrite → still exactly one block, identical bytes.
    await prepareForTask(staticSystemPrompt)
    const afterB = await readFile(join(runtimeHome, 'AGENTS.md'), 'utf-8')
    expect(afterB).toBe(afterA)
    expect(countPraesidiumBlocks(afterB)).toBe(1)

    // A changed prompt busts the fingerprint → the stale block self-heals
    // (old content gone, exactly one fresh block) WITHOUT destroying session state.
    await prepareForTask('# Praesidium Platform\nYou are cody, revised.')
    const afterC = await readFile(join(runtimeHome, 'AGENTS.md'), 'utf-8')
    expect(afterC).toContain('You are cody, revised.')
    expect(afterC).not.toContain('You are cody.\n')
    expect(countPraesidiumBlocks(afterC)).toBe(1)
    expect(await readFile(join(runtimeHome, 'sessions', 'keep.jsonl'), 'utf-8')).toBe(
      'session state\n'
    )
  })
})
