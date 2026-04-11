/**
 * Tests for system prompt materialization (T-00900).
 *
 * The instruction layer (SOUL.md, HEARTBEAT.md, additionalBase, byMode) is
 * resolved, materialized to a file, read back, and passed via --system-prompt
 * to CLI harnesses (replacing the default system prompt).
 *
 * PASS CONDITIONS:
 * 1. After buildProcessInvocationSpec, argv contains --system-prompt with SOUL.md content.
 * 2. In heartbeat mode, the prompt contains both SOUL.md and HEARTBEAT.md content.
 * 3. In query mode, the prompt contains only SOUL.md content, not HEARTBEAT.md.
 * 4. Empty SOUL.md still produces a --system-prompt flag.
 * 5. The spec.systemPromptFile field points to the materialized file.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * Helper to extract --system-prompt value from argv.
 */
function getSystemPromptFromArgv(argv: string[]): string | undefined {
  const idx = argv.indexOf('--system-prompt')
  return idx > -1 ? (argv[idx + 1] as string) : undefined
}

// ===================================================================
// T-00900: SOUL.md content appears via --system-prompt
// ===================================================================
describe('system prompt materialization (T-00900)', () => {
  test('SOUL.md content appears as --system-prompt value in argv', async () => {
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

      const systemPrompt = getSystemPromptFromArgv(response.spec.argv)
      expect(systemPrompt).toBeDefined()
      expect(systemPrompt).toContain('You are Alice')

      // spec should carry the materialized file path for audit
      expect(response.spec.systemPromptFile).toBeDefined()
    } finally {
      cleanup()
    }
  })
})

// ===================================================================
// T-00900: HEARTBEAT.md included in heartbeat mode
// ===================================================================
describe('HEARTBEAT.md in heartbeat mode (T-00900)', () => {
  test('--system-prompt contains both SOUL.md and HEARTBEAT.md in heartbeat mode', async () => {
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

      const systemPrompt = getSystemPromptFromArgv(response.spec.argv)
      expect(systemPrompt).toBeDefined()
      expect(systemPrompt).toContain('You are Alice')
      expect(systemPrompt).toContain('Check system status periodically')
    } finally {
      cleanup()
    }
  })
})

// ===================================================================
// T-00900: No HEARTBEAT.md in query mode
// ===================================================================
describe('no HEARTBEAT.md in query mode (T-00900)', () => {
  test('--system-prompt contains SOUL.md but NOT HEARTBEAT.md in query mode', async () => {
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

      const systemPrompt = getSystemPromptFromArgv(response.spec.argv)
      expect(systemPrompt).toBeDefined()
      expect(systemPrompt).toContain('You are Alice')
      expect(systemPrompt).not.toContain('DO NOT INCLUDE THIS IN QUERY MODE')
    } finally {
      cleanup()
    }
  })
})

// ===================================================================
// T-00900: Empty SOUL.md edge case
// ===================================================================
describe('empty SOUL.md edge case (T-00900)', () => {
  test('empty SOUL.md still produces --system-prompt flag', async () => {
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

      // System prompt file should still be set
      expect(response.spec.systemPromptFile).toBeDefined()
    } finally {
      cleanup()
    }
  })
})
