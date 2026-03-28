/**
 * RED tests for T-00900: SOUL.md must be materialized into harness plugin directory.
 *
 * Bug: validateAgentRoot() reads SOUL.md and HEARTBEAT.md content, but the
 * placement pipeline (placementToSpec → materializeSpec → buildProcessInvocationSpec)
 * never writes that content into the materialized plugin directory. The agent
 * responds as generic Claude instead of its persona.
 *
 * PASS CONDITIONS:
 * 1. After buildProcessInvocationSpec, the base plugin directory contains a CLAUDE.md
 *    (or equivalent) with the SOUL.md content from the agent root.
 * 2. In heartbeat mode, CLAUDE.md contains both SOUL.md and HEARTBEAT.md content.
 * 3. In query mode, CLAUDE.md contains only SOUL.md content, not HEARTBEAT.md.
 * 4. Empty SOUL.md still creates the plugin directory entry.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Create a temp agent root with SOUL.md and optionally HEARTBEAT.md + agent-profile.toml.
 */
function createTempAgentRoot(opts: {
  soulContent: string
  heartbeatContent?: string
}): { agentRoot: string; aspHome: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'soul-mat-'))
  const agentRoot = join(base, 'agent-root')
  const aspHome = join(base, 'asp-home')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })

  writeFileSync(join(agentRoot, 'SOUL.md'), opts.soulContent, 'utf8')

  if (opts.heartbeatContent !== undefined) {
    writeFileSync(join(agentRoot, 'HEARTBEAT.md'), opts.heartbeatContent, 'utf8')
  }

  // Minimal agent-profile.toml so placement resolution doesn't fail
  writeFileSync(join(agentRoot, 'agent-profile.toml'), '[spaces]\nbase = []\n', 'utf8')

  return {
    agentRoot,
    aspHome,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

// ===================================================================
// T-00900: SOUL.md content appears in materialized output
// ===================================================================
describe('SOUL.md materialization (T-00900)', () => {
  test('SOUL.md content appears in base plugin CLAUDE.md after buildProcessInvocationSpec', async () => {
    const { agentRoot, aspHome, cleanup } = createTempAgentRoot({
      soulContent: '# Alice\n\nYou are Alice, a helpful coding assistant.',
      heartbeatContent: '# Heartbeat\n\nCheck system status.',
    })

    try {
      const { createAgentSpacesClient } = await import('../index.js')
      const client = createAgentSpacesClient({ aspHome })

      const response = await client.buildProcessInvocationSpec({
        placement: {
          agentRoot,
          runMode: 'query',
          bundle: { kind: 'agent-default' },
        },
        provider: 'anthropic',
        frontend: 'claude-code',
        interactionMode: 'headless',
        ioMode: 'pipes',
      } as any)

      // Find the base plugin directory from argv (--plugin-dir flag)
      // or from the materialized output path
      const argv = response.spec.argv
      const pluginDirIdx = argv.indexOf('--plugin-dir')

      // There should be at least one --plugin-dir in argv
      expect(pluginDirIdx).toBeGreaterThan(-1)

      // Check if any plugin dir contains a CLAUDE.md with SOUL.md content
      let foundSoulContent = false
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--plugin-dir' && argv[i + 1]) {
          const dir = argv[i + 1] as string
          const claudeMdPath = join(dir, 'CLAUDE.md')
          if (existsSync(claudeMdPath)) {
            const content = readFileSync(claudeMdPath, 'utf8')
            if (content.includes('You are Alice')) {
              foundSoulContent = true
              break
            }
          }
        }
      }

      expect(foundSoulContent).toBe(true)
    } finally {
      cleanup()
    }
  })
})

// ===================================================================
// T-00900: HEARTBEAT.md included in heartbeat mode
// ===================================================================
describe('HEARTBEAT.md in heartbeat mode (T-00900)', () => {
  test('CLAUDE.md contains both SOUL.md and HEARTBEAT.md in heartbeat mode', async () => {
    const { agentRoot, aspHome, cleanup } = createTempAgentRoot({
      soulContent: '# Alice\n\nYou are Alice.',
      heartbeatContent: '# Heartbeat\n\nCheck system status periodically.',
    })

    try {
      const { createAgentSpacesClient } = await import('../index.js')
      const client = createAgentSpacesClient({ aspHome })

      const response = await client.buildProcessInvocationSpec({
        placement: {
          agentRoot,
          runMode: 'heartbeat',
          bundle: { kind: 'agent-default' },
        },
        provider: 'anthropic',
        frontend: 'claude-code',
        interactionMode: 'headless',
        ioMode: 'pipes',
      } as any)

      const argv = response.spec.argv
      let foundSoul = false
      let foundHeartbeat = false

      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--plugin-dir' && argv[i + 1]) {
          const dir = argv[i + 1] as string
          const claudeMdPath = join(dir, 'CLAUDE.md')
          if (existsSync(claudeMdPath)) {
            const content = readFileSync(claudeMdPath, 'utf8')
            if (content.includes('You are Alice')) foundSoul = true
            if (content.includes('Check system status periodically')) foundHeartbeat = true
          }
        }
      }

      expect(foundSoul).toBe(true)
      expect(foundHeartbeat).toBe(true)
    } finally {
      cleanup()
    }
  })
})

// ===================================================================
// T-00900: No HEARTBEAT.md in query mode
// ===================================================================
describe('no HEARTBEAT.md in query mode (T-00900)', () => {
  test('CLAUDE.md contains SOUL.md but NOT HEARTBEAT.md in query mode', async () => {
    const { agentRoot, aspHome, cleanup } = createTempAgentRoot({
      soulContent: '# Alice\n\nYou are Alice.',
      heartbeatContent: '# Heartbeat\n\nDO NOT INCLUDE THIS IN QUERY MODE.',
    })

    try {
      const { createAgentSpacesClient } = await import('../index.js')
      const client = createAgentSpacesClient({ aspHome })

      const response = await client.buildProcessInvocationSpec({
        placement: {
          agentRoot,
          runMode: 'query',
          bundle: { kind: 'agent-default' },
        },
        provider: 'anthropic',
        frontend: 'claude-code',
        interactionMode: 'headless',
        ioMode: 'pipes',
      } as any)

      const argv = response.spec.argv
      let foundSoul = false
      let foundHeartbeat = false

      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--plugin-dir' && argv[i + 1]) {
          const dir = argv[i + 1] as string
          const claudeMdPath = join(dir, 'CLAUDE.md')
          if (existsSync(claudeMdPath)) {
            const content = readFileSync(claudeMdPath, 'utf8')
            if (content.includes('You are Alice')) foundSoul = true
            if (content.includes('DO NOT INCLUDE THIS IN QUERY MODE')) foundHeartbeat = true
          }
        }
      }

      expect(foundSoul).toBe(true)
      expect(foundHeartbeat).toBe(false)
    } finally {
      cleanup()
    }
  })
})

// ===================================================================
// T-00900: Empty SOUL.md edge case
// ===================================================================
describe('empty SOUL.md edge case (T-00900)', () => {
  test('empty SOUL.md still creates plugin directory', async () => {
    const { agentRoot, aspHome, cleanup } = createTempAgentRoot({
      soulContent: '',
    })

    try {
      const { createAgentSpacesClient } = await import('../index.js')
      const client = createAgentSpacesClient({ aspHome })

      const response = await client.buildProcessInvocationSpec({
        placement: {
          agentRoot,
          runMode: 'query',
          bundle: { kind: 'agent-default' },
        },
        provider: 'anthropic',
        frontend: 'claude-code',
        interactionMode: 'headless',
        ioMode: 'pipes',
      } as any)

      // Should succeed without error even with empty SOUL.md
      expect(response.spec).toBeDefined()
      expect(response.spec.argv.length).toBeGreaterThan(0)
    } finally {
      cleanup()
    }
  })
})
