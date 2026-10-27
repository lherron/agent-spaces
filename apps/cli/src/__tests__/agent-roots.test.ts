/**
 * Agent-root provenance as `asp list --json` and `asp doctor --json` report it:
 * a project-local agents root (asp-targets.toml `agents-root`) wins over the
 * canonical root from $ASP_HOME/config.toml, and both whole-agent shadows and
 * shared-file overrides are reported.
 */

import { describe, expect } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cliTest, runAsp } from './asp-cli'

async function writeAgent(root: string, id: string): Promise<void> {
  await mkdir(join(root, id), { recursive: true })
  await writeFile(join(root, id, 'agent-profile.toml'), 'version = 4\n')
}

/**
 * A temp ASP_HOME whose config.toml names a canonical agents root, and a project
 * whose asp-targets.toml declares a local `agents` root.
 */
async function withAgentRoots(
  prefix: string,
  fn: (roots: {
    base: string
    projectRoot: string
    localRoot: string
    canonicalRoot: string
  }) => Promise<void>
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), prefix))
  const projectRoot = join(base, 'project')
  const localRoot = join(projectRoot, 'agents')
  const canonicalRoot = join(base, 'canonical')
  try {
    await mkdir(localRoot, { recursive: true })
    await mkdir(canonicalRoot, { recursive: true })
    await writeFile(join(base, 'config.toml'), `agents-root = "${canonicalRoot}"\n`)
    await writeFile(join(projectRoot, 'asp-targets.toml'), 'schema = 2\nagents-root = "agents"\n')
    await fn({ base, projectRoot, localRoot, canonicalRoot })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

/**
 * The canonical root resolves from ASP_AGENTS_ROOT env FIRST, then config.toml;
 * an inherited env (the live var/agents on a dev host) would leak real agents in
 * ahead of the fixture (T-06915), so it is blanked.
 */
function aspEnv(base: string): Record<string, string> {
  return { ASP_HOME: base, ASP_AGENTS_ROOT: '' }
}

describe('agent root provenance reporting', () => {
  cliTest('asp list --json dedupes local-first agents and reports canonical shadows', () =>
    withAgentRoots('asp-agent-roots-', async ({ base, projectRoot, localRoot, canonicalRoot }) => {
      await writeAgent(localRoot, 'clod')
      await writeAgent(canonicalRoot, 'clod')
      await writeAgent(canonicalRoot, 'daedalus')

      const result = runAsp(['list', '--json', '--project', projectRoot], aspEnv(base))

      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout).agents).toEqual([
        {
          id: 'clod',
          root: join(localRoot, 'clod'),
          source: 'project',
          shadowedRoots: [join(canonicalRoot, 'clod')],
        },
        {
          id: 'daedalus',
          root: join(canonicalRoot, 'daedalus'),
          source: 'canonical',
          shadowedRoots: [],
        },
      ])
    })
  )

  cliTest('asp doctor --json reports a shared-file override separately from agent shadows', () =>
    withAgentRoots(
      'asp-agent-roots-shared-',
      async ({ base, projectRoot, localRoot, canonicalRoot }) => {
        await writeFile(join(localRoot, 'AGENT_MOTD.md'), 'local')
        await writeFile(join(canonicalRoot, 'AGENT_MOTD.md'), 'canonical')

        const result = runAsp(['doctor', '--json', '--project', projectRoot], aspEnv(base))
        const checks = (
          JSON.parse(result.stdout) as {
            checks: Array<{ name: string; status: string; message: string; detail?: string }>
          }
        ).checks

        expect(checks.filter((check) => check.name === 'shared_file_override')).toEqual([
          expect.objectContaining({
            status: 'warning',
            message: `AGENT_MOTD.md resolved from ${join(localRoot, 'AGENT_MOTD.md')}`,
            detail: `shadows ${join(canonicalRoot, 'AGENT_MOTD.md')}`,
          }),
        ])
        expect(checks.filter((check) => check.name === 'agent_shadow')).toEqual([])
      }
    )
  )
})
