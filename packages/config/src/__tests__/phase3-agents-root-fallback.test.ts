/**
 * RED tests: Phase 3 — getAgentsRoot ~/agents convention fallback (T-00993)
 *
 * WHY: When no explicit agents-root is configured (no env var, no config.toml),
 * getAgentsRoot should fall back to ~/agents if that directory exists on disk.
 * This enables zero-config agent discovery for users who follow the convention.
 *
 * PASS CONDITIONS (all tests green when):
 * 1. getAgentsRoot returns ~/agents path when ~/agents dir exists and no explicit config
 * 2. getAgentsRoot returns undefined when ~/agents does NOT exist and no explicit config
 * 3. Explicit ASP_AGENTS_ROOT env var still takes precedence over ~/agents fallback
 * 4. config.toml agents-root still takes precedence over ~/agents fallback
 * 5. HOME env override is respected for convention path construction
 *
 * wrkq task: T-00993
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getAgentsRoot } from '../store/asp-config.js'

// ─────────────────────────────────────────────────────────────────────────────
// Helper: set up a fake HOME with optional ~/agents directory
// ─────────────────────────────────────────────────────────────────────────────

function createFakeHome(withAgentsDir: boolean): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  if (withAgentsDir) {
    mkdirSync(join(home, 'agents'), { recursive: true })
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
// T-00993 Phase 3.3: ~/agents convention fallback
// ===================================================================
describe('getAgentsRoot: ~/agents convention fallback (T-00993)', () => {
  let fakeHome: { home: string; cleanup: () => void }
  let aspHome: string

  beforeEach(() => {
    aspHome = emptyAspHome()
  })

  afterEach(() => {
    if (fakeHome) fakeHome.cleanup()
    rmSync(aspHome, { recursive: true, force: true })
  })

  test('returns ~/agents when directory exists and no explicit config', () => {
    fakeHome = createFakeHome(true)
    const result = getAgentsRoot({
      aspHome,
      env: { HOME: fakeHome.home },
    })
    expect(result).toBe(join(fakeHome.home, 'agents'))
  })

  test('returns undefined when ~/agents does NOT exist and no explicit config', () => {
    fakeHome = createFakeHome(false)
    const result = getAgentsRoot({
      aspHome,
      env: { HOME: fakeHome.home },
    })
    expect(result).toBeUndefined()
  })

  test('ASP_AGENTS_ROOT env var takes precedence over ~/agents fallback', () => {
    fakeHome = createFakeHome(true)
    const result = getAgentsRoot({
      aspHome,
      env: {
        HOME: fakeHome.home,
        ASP_AGENTS_ROOT: '/explicit/agents/root',
      },
    })
    // Env var wins — should NOT be ~/agents
    expect(result).toBe('/explicit/agents/root')
  })

  test('config.toml agents-root takes precedence over ~/agents fallback', async () => {
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
    expect(result).toBe(join(customHome, 'agents'))
  })
})
