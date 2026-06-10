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
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getAgentRootSearchPathForProject,
  getAgentRootsForProject,
  getAgentsRoot,
} from '../store/asp-config.js'

async function makeTempAspHome(
  configContent?: string
): Promise<{ aspHome: string; cleanup: () => Promise<void> }> {
  const aspHome = join(
    tmpdir(),
    `asp-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await mkdir(aspHome, { recursive: true })
  if (configContent !== undefined) {
    await writeFile(join(aspHome, 'config.toml'), configContent, 'utf8')
  }
  return {
    aspHome,
    cleanup: async () => {
      await rm(aspHome, { recursive: true, force: true })
    },
  }
}

describe('getAgentsRoot', () => {
  test('returns ASP_AGENTS_ROOT env var when set', async () => {
    const result = getAgentsRoot({
      env: { ASP_AGENTS_ROOT: '/tmp/my-agents' },
    })
    expect(result).toBe('/tmp/my-agents')
  })

  test('reads agents-root from $ASP_HOME/config.toml when env not set', async () => {
    const { aspHome, cleanup } = await makeTempAspHome('agents-root = "/home/user/agents"\n')
    try {
      const result = getAgentsRoot({ aspHome, env: {} })
      expect(result).toBe('/home/user/agents')
    } finally {
      await cleanup()
    }
  })

  test('returns undefined when neither env nor config exists', async () => {
    const { aspHome, cleanup } = await makeTempAspHome()
    try {
      const result = getAgentsRoot({ aspHome, env: {} })
      expect(result).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  test('env var takes precedence over config.toml', async () => {
    const { aspHome, cleanup } = await makeTempAspHome('agents-root = "/from-config"\n')
    try {
      const result = getAgentsRoot({
        aspHome,
        env: { ASP_AGENTS_ROOT: '/from-env' },
      })
      expect(result).toBe('/from-env')
    } finally {
      await cleanup()
    }
  })
})

describe('config.toml parsing', () => {
  test('valid TOML with agents-root', async () => {
    const { aspHome, cleanup } = await makeTempAspHome('agents-root = "/agents"\n')
    try {
      expect(getAgentsRoot({ aspHome, env: {} })).toBe('/agents')
    } finally {
      await cleanup()
    }
  })

  test('unknown keys are ignored (no crash on old projects-root entries)', async () => {
    const { aspHome, cleanup } = await makeTempAspHome(
      'agents-root = "/agents"\nprojects-root = "/projects-ignored"\n'
    )
    try {
      expect(getAgentsRoot({ aspHome, env: {} })).toBe('/agents')
    } finally {
      await cleanup()
    }
  })

  test('missing config file returns undefined', async () => {
    const { aspHome, cleanup } = await makeTempAspHome()
    try {
      expect(getAgentsRoot({ aspHome, env: {} })).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  test('malformed TOML returns undefined (no crash)', async () => {
    const { aspHome, cleanup } = await makeTempAspHome('{{{{ this is not valid TOML }}}}!@#$')
    try {
      expect(getAgentsRoot({ aspHome, env: {} })).toBeUndefined()
    } finally {
      await cleanup()
    }
  })
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
      await writeFile(join(projectRoot, 'asp-targets.toml'), 'schema = 1\nagents-root = "agents"\n')

      expect(
        getAgentRootsForProject(projectRoot, { env: { ASP_AGENTS_ROOT: canonicalRoot } })
      ).toEqual([localRoot, canonicalRoot])
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test('skips missing project-local agents-root with a warning and keeps canonical root', async () => {
    const base = join(
      tmpdir(),
      `asp-config-project-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    const projectRoot = join(base, 'project')
    const canonicalRoot = join(base, 'canonical')
    try {
      await mkdir(projectRoot, { recursive: true })
      await mkdir(canonicalRoot, { recursive: true })
      await writeFile(join(projectRoot, 'asp-targets.toml'), 'schema = 1\nagents-root = "agents"\n')

      const result = getAgentRootSearchPathForProject(projectRoot, {
        env: { ASP_AGENTS_ROOT: canonicalRoot },
      })
      expect(result.roots).toEqual([canonicalRoot])
      expect(result.warnings).toEqual([
        {
          code: 'declared_agents_root_missing',
          message: `Declared project agents root does not exist: ${join(projectRoot, 'agents')}`,
          root: join(projectRoot, 'agents'),
          projectRoot,
          declaredPath: 'agents',
        },
      ])
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test('project without agents-root has canonical-only search path and no warnings', async () => {
    const base = join(
      tmpdir(),
      `asp-config-project-no-key-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    const projectRoot = join(base, 'project')
    const canonicalRoot = join(base, 'canonical')
    try {
      await mkdir(projectRoot, { recursive: true })
      await mkdir(canonicalRoot, { recursive: true })
      await writeFile(join(projectRoot, 'asp-targets.toml'), 'schema = 1\n')

      const result = getAgentRootSearchPathForProject(projectRoot, {
        env: { ASP_AGENTS_ROOT: canonicalRoot },
      })
      expect(result.roots).toEqual([canonicalRoot])
      expect(result.warnings).toEqual([])
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
