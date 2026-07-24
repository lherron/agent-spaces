import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildAgentRootReport } from '../agent-roots.js'

async function writeAgent(root: string, id: string): Promise<void> {
  await mkdir(join(root, id), { recursive: true })
  await writeFile(join(root, id, 'agent-profile.toml'), 'schemaVersion = 2\n')
}

describe('agent root provenance reporting', () => {
  // The canonical root resolves from ASP_AGENTS_ROOT env FIRST, then the fixture
  // config.toml. On any machine where that env is set — the maintainer host and
  // the devbox room alike — the ambient live var/agents leaks in ahead of the
  // fixture (buildAgentRootReport returned ~194 real agents instead of the two
  // seeded here). Isolate the env so these unit tests exercise only the fixture
  // roots (T-06915 room-readiness).
  // Reflect.deleteProperty (not `delete`, which biome's noDelete rejects; not
  // `= undefined`, which sets the literal string "undefined" on process.env).
  let savedAgentsRoot: string | undefined
  beforeEach(() => {
    savedAgentsRoot = process.env['ASP_AGENTS_ROOT']
    Reflect.deleteProperty(process.env, 'ASP_AGENTS_ROOT')
  })
  afterEach(() => {
    if (savedAgentsRoot === undefined) Reflect.deleteProperty(process.env, 'ASP_AGENTS_ROOT')
    else process.env['ASP_AGENTS_ROOT'] = savedAgentsRoot
  })

  test('dedupes local-first agents and reports canonical shadows', async () => {
    const base = await mkdtemp(join(tmpdir(), 'asp-agent-roots-'))
    const projectRoot = join(base, 'project')
    const localRoot = join(projectRoot, 'agents')
    const canonicalRoot = join(base, 'canonical')
    try {
      await mkdir(localRoot, { recursive: true })
      await mkdir(canonicalRoot, { recursive: true })
      await writeFile(join(base, 'config.toml'), `agents-root = "${canonicalRoot}"\n`)
      await writeFile(join(projectRoot, 'asp-targets.toml'), 'schema = 1\nagents-root = "agents"\n')
      await writeAgent(localRoot, 'clod')
      await writeAgent(canonicalRoot, 'clod')
      await writeAgent(canonicalRoot, 'daedalus')

      const report = buildAgentRootReport(projectRoot, { aspHome: base })

      expect(report.agents).toEqual([
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
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test('reports shared-file overrides separately from whole-agent shadows', async () => {
    const base = await mkdtemp(join(tmpdir(), 'asp-agent-roots-shared-'))
    const projectRoot = join(base, 'project')
    const localRoot = join(projectRoot, 'agents')
    const canonicalRoot = join(base, 'canonical')
    try {
      await mkdir(localRoot, { recursive: true })
      await mkdir(canonicalRoot, { recursive: true })
      await writeFile(join(base, 'config.toml'), `agents-root = "${canonicalRoot}"\n`)
      await writeFile(join(projectRoot, 'asp-targets.toml'), 'schema = 1\nagents-root = "agents"\n')
      await writeFile(join(localRoot, 'AGENT_MOTD.md'), 'local')
      await writeFile(join(canonicalRoot, 'AGENT_MOTD.md'), 'canonical')

      const report = buildAgentRootReport(projectRoot, { aspHome: base })

      expect(report.sharedFileOverrides).toEqual([
        {
          file: 'AGENT_MOTD.md',
          resolvedPath: join(localRoot, 'AGENT_MOTD.md'),
          shadowedPath: join(canonicalRoot, 'AGENT_MOTD.md'),
        },
      ])
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
