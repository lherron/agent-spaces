/**
 * RED tests for T-00899: ASP config.toml loading — agents-root and projects-root.
 *
 * New module `asp-config.ts` reads ASP_AGENTS_ROOT / ASP_PROJECTS_ROOT from
 * environment variables or falls back to `$ASP_HOME/config.toml`.
 *
 * PASS CONDITIONS:
 * 1. asp-config.ts exports getAgentsRoot() and getProjectsRoot().
 * 2. Env vars ASP_AGENTS_ROOT / ASP_PROJECTS_ROOT take precedence.
 * 3. Falls back to agents-root / projects-root keys in $ASP_HOME/config.toml.
 * 4. Returns undefined when neither env nor config exists.
 * 5. Handles: valid TOML with both keys, only one key, missing file, malformed TOML.
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Import from module that doesn't exist yet (RED)
// ---------------------------------------------------------------------------
import { getAgentsRoot, getProjectsRoot } from '../store/asp-config.js'

// Helper: create a temp ASP_HOME with optional config.toml
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

// ===================================================================
// getAgentsRoot
// ===================================================================
describe('getAgentsRoot (T-00899)', () => {
  test('returns ASP_AGENTS_ROOT env var when set', async () => {
    const result = getAgentsRoot({
      env: { ASP_AGENTS_ROOT: '/tmp/my-agents' },
    })
    expect(result).toBe('/tmp/my-agents')
  })

  test('reads agents-root from $ASP_HOME/config.toml when env not set', async () => {
    const { aspHome, cleanup } = await makeTempAspHome('agents-root = "/home/user/agents"\n')
    try {
      const result = getAgentsRoot({ aspHome })
      expect(result).toBe('/home/user/agents')
    } finally {
      await cleanup()
    }
  })

  test('returns undefined when neither env nor config exists', async () => {
    const { aspHome, cleanup } = await makeTempAspHome()
    try {
      const result = getAgentsRoot({ aspHome })
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

// ===================================================================
// getProjectsRoot
// ===================================================================
describe('getProjectsRoot (T-00899)', () => {
  test('returns ASP_PROJECTS_ROOT env var when set', async () => {
    const result = getProjectsRoot({
      env: { ASP_PROJECTS_ROOT: '/tmp/my-projects' },
    })
    expect(result).toBe('/tmp/my-projects')
  })

  test('reads projects-root from $ASP_HOME/config.toml when env not set', async () => {
    const { aspHome, cleanup } = await makeTempAspHome('projects-root = "/home/user/projects"\n')
    try {
      const result = getProjectsRoot({ aspHome })
      expect(result).toBe('/home/user/projects')
    } finally {
      await cleanup()
    }
  })

  test('returns undefined when neither env nor config exists', async () => {
    const { aspHome, cleanup } = await makeTempAspHome()
    try {
      const result = getProjectsRoot({ aspHome })
      expect(result).toBeUndefined()
    } finally {
      await cleanup()
    }
  })
})

// ===================================================================
// Config file parsing edge cases
// ===================================================================
describe('config.toml parsing (T-00899)', () => {
  test('valid TOML with both keys', async () => {
    const { aspHome, cleanup } = await makeTempAspHome(
      'agents-root = "/agents"\nprojects-root = "/projects"\n'
    )
    try {
      expect(getAgentsRoot({ aspHome })).toBe('/agents')
      expect(getProjectsRoot({ aspHome })).toBe('/projects')
    } finally {
      await cleanup()
    }
  })

  test('TOML with only agents-root', async () => {
    const { aspHome, cleanup } = await makeTempAspHome('agents-root = "/agents"\n')
    try {
      expect(getAgentsRoot({ aspHome })).toBe('/agents')
      expect(getProjectsRoot({ aspHome })).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  test('TOML with only projects-root', async () => {
    const { aspHome, cleanup } = await makeTempAspHome('projects-root = "/projects"\n')
    try {
      expect(getAgentsRoot({ aspHome })).toBeUndefined()
      expect(getProjectsRoot({ aspHome })).toBe('/projects')
    } finally {
      await cleanup()
    }
  })

  test('missing config file returns undefined', async () => {
    const { aspHome, cleanup } = await makeTempAspHome()
    try {
      expect(getAgentsRoot({ aspHome })).toBeUndefined()
      expect(getProjectsRoot({ aspHome })).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  test('malformed TOML returns undefined (no crash)', async () => {
    const { aspHome, cleanup } = await makeTempAspHome('{{{{ this is not valid TOML }}}}!@#$')
    try {
      // Should not throw, just return undefined
      expect(getAgentsRoot({ aspHome })).toBeUndefined()
      expect(getProjectsRoot({ aspHome })).toBeUndefined()
    } finally {
      await cleanup()
    }
  })
})
