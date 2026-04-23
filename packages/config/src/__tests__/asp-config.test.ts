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

import { getAgentsRoot } from '../store/asp-config.js'

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
