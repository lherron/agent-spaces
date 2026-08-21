/**
 * RED tests: Phase 3 — getAgentsRoot ~/praesidium/var/agents convention fallback (T-00993)
 *
 * WHY: When no explicit agents-root is configured (no env var, no config.toml),
 * getAgentsRoot should fall back to ~/praesidium/var/agents if that directory exists on disk.
 * This enables zero-config agent discovery for users who follow the convention.
 *
 * PASS CONDITIONS (all tests green when):
 * 1. getAgentsRoot returns ~/praesidium/var/agents path when that dir exists and no explicit config
 * 2. getAgentsRoot returns undefined when ~/praesidium/var/agents does NOT exist and no explicit config
 * 3. Explicit ASP_AGENTS_ROOT env var still takes precedence over the convention fallback
 * 4. config.toml agents-root still takes precedence over the convention fallback
 * 5. HOME env override is respected for convention path construction
 *
 * wrkq task: T-00993
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgentsRoot } from '../store/asp-config.js'
import { resolveAgentPlacementPaths } from '../store/runtime-placement.js'

// ─────────────────────────────────────────────────────────────────────────────
// Helper: set up a fake HOME with optional ~/praesidium/var/agents directory
// ─────────────────────────────────────────────────────────────────────────────

function createFakeHome(withAgentsDir: boolean): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  if (withAgentsDir) {
    mkdirSync(join(home, 'praesidium', 'var', 'agents'), { recursive: true })
  }
  return {
    home,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

// aspHome must point to a directory that has no config.toml
function emptyAspHome(): string {
  return mkdtempSync(join(tmpdir(), 'asp-home-empty-'))
}

// ===================================================================
// T-00993 Phase 3.3: ~/praesidium/var/agents convention fallback
// ===================================================================
describe('getAgentsRoot: ~/praesidium/var/agents convention fallback (T-00993)', () => {
  let fakeHome: { home: string; cleanup: () => void }
  let aspHome: string

  beforeEach(() => {
    aspHome = emptyAspHome()
  })

  afterEach(() => {
    if (fakeHome) fakeHome.cleanup()
    rmSync(aspHome, { recursive: true, force: true })
  })

  test('returns ~/praesidium/var/agents when directory exists and no explicit config', () => {
    fakeHome = createFakeHome(true)
    const result = getAgentsRoot({
      aspHome,
      env: { HOME: fakeHome.home },
    })
    expect(result).toBe(join(fakeHome.home, 'praesidium', 'var', 'agents'))
  })

  test('returns undefined when ~/praesidium/var/agents does NOT exist and no explicit config', () => {
    fakeHome = createFakeHome(false)
    const result = getAgentsRoot({
      aspHome,
      env: { HOME: fakeHome.home },
    })
    expect(result).toBeUndefined()
  })

  test('ASP_AGENTS_ROOT env var takes precedence over the convention fallback', () => {
    fakeHome = createFakeHome(true)
    const result = getAgentsRoot({
      aspHome,
      env: {
        HOME: fakeHome.home,
        ASP_AGENTS_ROOT: '/explicit/agents/root',
      },
    })
    // Env var wins over the convention path
    expect(result).toBe('/explicit/agents/root')
  })

  test('config.toml agents-root takes precedence over the convention fallback', async () => {
    fakeHome = createFakeHome(true)
    // Write a config.toml with agents-root
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(aspHome, { recursive: true })
    await writeFile(join(aspHome, 'config.toml'), 'agents-root = "/from-config"\n')

    const result = getAgentsRoot({
      aspHome,
      env: { HOME: fakeHome.home },
    })
    expect(result).toBe('/from-config')
  })

  test('HOME env override is used for convention path', () => {
    fakeHome = createFakeHome(true)
    const customHome = fakeHome.home
    const result = getAgentsRoot({
      aspHome,
      env: { HOME: customHome },
    })
    // Should use HOME env, not process.env.HOME or os.homedir()
    expect(result).toBe(join(customHome, 'praesidium', 'var', 'agents'))
  })
})

// ===========================================================================
// T-06927: callers that omit `env` still receive the convention fallback
// ===========================================================================
describe('agents-root convention fallback when options omit env (T-06927)', () => {
  let fakeHome: string
  let aspHome: string
  let originalHome: string | undefined
  let originalAspAgentsRoot: string | undefined
  let originalAspHome: string | undefined

  function restoreEnvironmentVariable(key: string, value: string | undefined): void {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key)
      return
    }
    process.env[key] = value
  }

  function conventionAgentsRoot(): string {
    return join(fakeHome, 'praesidium', 'var', 'agents')
  }

  beforeEach(() => {
    originalHome = process.env['HOME']
    originalAspAgentsRoot = process.env['ASP_AGENTS_ROOT']
    originalAspHome = process.env['ASP_HOME']

    fakeHome = mkdtempSync(join(tmpdir(), 'agents-root-options-home-'))
    aspHome = mkdtempSync(join(tmpdir(), 'agents-root-options-asp-home-'))
    process.env['HOME'] = fakeHome
    process.env['ASP_HOME'] = aspHome
    Reflect.deleteProperty(process.env, 'ASP_AGENTS_ROOT')
  })

  afterEach(() => {
    restoreEnvironmentVariable('HOME', originalHome)
    restoreEnvironmentVariable('ASP_AGENTS_ROOT', originalAspAgentsRoot)
    restoreEnvironmentVariable('ASP_HOME', originalAspHome)
    rmSync(fakeHome, { recursive: true, force: true })
    rmSync(aspHome, { recursive: true, force: true })
  })

  test('getAgentsRoot({}) uses HOME when the options object omits env', () => {
    // Regression context: runtime placement turns absent options into `{}`.
    mkdirSync(conventionAgentsRoot(), { recursive: true })

    expect(getAgentsRoot({})).toBe(conventionAgentsRoot())
  })

  test('getAgentsRoot({ aspHome }) uses HOME when the options object omits env', () => {
    // An explicit ASP home controls config lookup but must not disable HOME discovery.
    mkdirSync(conventionAgentsRoot(), { recursive: true })

    expect(getAgentsRoot({ aspHome })).toBe(conventionAgentsRoot())
  })

  test('getAgentsRoot({ env: {} }) keeps an explicitly supplied env hermetic', () => {
    // Scope guard: an env object is authoritative even when process.env.HOME has the convention.
    mkdirSync(conventionAgentsRoot(), { recursive: true })

    expect(getAgentsRoot({ aspHome, env: {} })).toBeUndefined()
  })

  test('resolveAgentPlacementPaths finds an agent through the convention root without env options', () => {
    // This is the public placement path that failed on the mini node:
    // toConfigOptions({ agentId }) produces `{}`, yet convention discovery must remain live.
    const agentRoot = join(conventionAgentsRoot(), 'mable')
    mkdirSync(agentRoot, { recursive: true })
    writeFileSync(join(agentRoot, 'agent-profile.toml'), 'version = 3\n')

    const placement = resolveAgentPlacementPaths({ agentId: 'mable' })

    expect(placement.agentRoot).toBe(agentRoot)
  })
})
