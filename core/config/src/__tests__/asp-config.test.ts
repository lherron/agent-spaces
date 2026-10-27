/**
 * Tests for asp-config.ts: ASP_AGENTS_ROOT / agents-root loading.
 *
 * Precedence (agents-root only — projects-root was removed in favor of
 * asp-targets.toml walk-up, see runtime-placement.ts):
 * 1. ASP_AGENTS_ROOT env var
 * 2. agents-root key in $ASP_HOME/config.toml
 * 3. ~/praesidium/var/agents convention (if it exists)
 * 4. undefined
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getAgentRootSearchPathForProject,
  getAgentRootsForProject,
  getAgentsRoot,
} from '../store/asp-config.js'

describe('getAgentsRoot', () => {
  type Expected = 'env' | 'config' | 'convention' | 'undefined'
  test.each<{
    row: string
    envRoot?: string
    config?: string
    conventionDir: boolean
    expected: Expected
  }>([
    {
      row: 'env + config.toml + convention dir -> env',
      envRoot: '/from-env',
      config: 'agents-root = "/from-config"\n',
      conventionDir: true,
      expected: 'env',
    },
    {
      row: 'config.toml + convention dir -> config.toml',
      config: 'agents-root = "/from-config"\n',
      conventionDir: true,
      expected: 'config',
    },
    {
      row: 'convention dir only -> ~/praesidium/var/agents',
      conventionDir: true,
      expected: 'convention',
    },
    {
      row: 'HOME without the convention dir -> undefined',
      conventionDir: false,
      expected: 'undefined',
    },
    {
      row: 'config.toml with a legacy projects-root key -> agents-root value',
      config: 'agents-root = "/from-config"\nprojects-root = "/projects-ignored"\n',
      conventionDir: false,
      expected: 'config',
    },
    {
      row: 'malformed config.toml -> falls through to the convention dir without throwing',
      config: '{{{{ this is not valid TOML }}}}!@#$',
      conventionDir: true,
      expected: 'convention',
    },
  ])(
    'agents root resolves env first, then config.toml, then the ~/praesidium/var/agents convention: $row',
    async ({ envRoot, config, conventionDir, expected }) => {
      const base = await mkdtemp(join(tmpdir(), 'asp-config-precedence-'))
      const home = join(base, 'home')
      const aspHome = join(base, 'asp-home')
      const conventionPath = join(home, 'praesidium', 'var', 'agents')
      try {
        await mkdir(aspHome, { recursive: true })
        await mkdir(home, { recursive: true })
        if (conventionDir) await mkdir(conventionPath, { recursive: true })
        if (config !== undefined) await writeFile(join(aspHome, 'config.toml'), config, 'utf8')

        const env: Record<string, string | undefined> = { HOME: home }
        if (envRoot !== undefined) env['ASP_AGENTS_ROOT'] = envRoot

        const want = {
          env: '/from-env',
          config: '/from-config',
          convention: conventionPath,
          undefined: undefined,
        }[expected]
        expect(getAgentsRoot({ aspHome, env })).toBe(want)
      } finally {
        await rm(base, { recursive: true, force: true })
      }
    }
  )
})

describe('getAgentRootsForProject', () => {
  test('returns project-local agents-root before canonical root', async () => {
    const base = join(
      tmpdir(),
      `asp-config-project-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    const projectRoot = join(base, 'project')
    const localRoot = join(projectRoot, 'agents')
    const canonicalRoot = join(base, 'canonical')
    try {
      await mkdir(localRoot, { recursive: true })
      await mkdir(canonicalRoot, { recursive: true })
      await writeFile(join(projectRoot, 'asp-targets.toml'), 'schema = 2\nagents-root = "agents"\n')

      expect(
        getAgentRootsForProject(projectRoot, { env: { ASP_AGENTS_ROOT: canonicalRoot } })
      ).toEqual([localRoot, canonicalRoot])
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test.each<{ row: string; targets: string; warnsMissingRoot: boolean }>([
    {
      row: 'declared agents-root that does not exist -> warning',
      targets: 'schema = 2\nagents-root = "agents"\n',
      warnsMissingRoot: true,
    },
    {
      row: 'asp-targets.toml without agents-root -> no warnings',
      targets: 'schema = 2\n',
      warnsMissingRoot: false,
    },
  ])(
    'project search path keeps only the canonical root and warns only for a declared missing root: $row',
    async ({ targets, warnsMissingRoot }) => {
      const base = await mkdtemp(join(tmpdir(), 'asp-config-project-search-'))
      const projectRoot = join(base, 'project')
      const canonicalRoot = join(base, 'canonical')
      try {
        await mkdir(projectRoot, { recursive: true })
        await mkdir(canonicalRoot, { recursive: true })
        await writeFile(join(projectRoot, 'asp-targets.toml'), targets)

        const result = getAgentRootSearchPathForProject(projectRoot, {
          env: { ASP_AGENTS_ROOT: canonicalRoot },
        })
        expect(result.roots).toEqual([canonicalRoot])
        expect(result.warnings).toEqual(
          warnsMissingRoot
            ? [
                {
                  code: 'declared_agents_root_missing',
                  message: `Declared project agents root does not exist: ${join(projectRoot, 'agents')}`,
                  root: join(projectRoot, 'agents'),
                  projectRoot,
                  declaredPath: 'agents',
                },
              ]
            : []
        )
      } finally {
        await rm(base, { recursive: true, force: true })
      }
    }
  )
})
