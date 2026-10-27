/**
 * ~/praesidium/var/agents convention fallback (T-00993, T-06927).
 *
 * The env/config/convention precedence table lives in asp-config.test.ts. This
 * file keeps the cases that depend on the host process environment: an explicit
 * env stays hermetic, and placement without env options still finds the
 * convention root.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgentsRoot } from '../store/asp-config.js'
import { resolveAgentPlacementPaths } from '../store/runtime-placement.js'

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
    writeFileSync(join(agentRoot, 'agent-profile.toml'), 'version = 4\n')

    const placement = resolveAgentPlacementPaths({ agentId: 'mable' })

    expect(placement.agentRoot).toBe(agentRoot)
  })
})
