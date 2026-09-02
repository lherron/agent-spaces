import { describe, expect, test } from 'bun:test'
import type { InvocationCapabilities } from 'spaces-harness-broker-protocol'
import { CONSERVATIVE_LIFECYCLE_CAPABILITIES } from 'spaces-harness-broker-protocol'
import { createDefaultAgentHarnessTmuxDriver } from '../src/drivers/agent-harness-tmux/driver'
import { createDefaultClaudeCodeTmuxDriver } from '../src/drivers/claude-code-tmux/driver'
import { createCodexAppServerDriver } from '../src/drivers/codex-app-server/driver'
import { createDefaultCodexCliTmuxDriver } from '../src/drivers/codex-cli-tmux/driver'
import { createNoopDriver } from '../src/drivers/noop-driver'
import { createDefaultPiTuiTmuxDriver } from '../src/drivers/pi-tui-tmux/driver'

const CODEX_APP_SERVER_V0_CAPABILITIES: InvocationCapabilities = {
  admission: { classes: ['steer', 'queue', 'exclusive', 'preempt'] },
  bracketMintingMode: 'delivery-acknowledged',
  queue: { cancelHarnessLocal: false },
  preempt: { mode: 'atomic' },
  steer: { landingEvidence: 'ack' },
  interrupt: { landingEvidence: 'ack' },
  input: {
    user: true,
    steer: false,
    appendContext: false,
    localImages: true,
    fileRefs: false,
    queue: true,
  },
  turns: {
    concurrency: 'single',
    interrupt: 'protocol',
  },
  continuation: {
    supported: true,
    provider: 'codex',
    keyKind: 'thread',
  },
  events: {
    assistantDeltas: true,
    toolCalls: true,
    usage: true,
    diagnostics: true,
  },
  control: {
    stop: true,
    dispose: true,
  },
  finalResponse: {
    jsonSchema: true,
    perTurn: true,
    strict: true,
    parsedResult: false,
  },
  lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
} as InvocationCapabilities & {
  finalResponse: {
    jsonSchema: boolean
    perTurn: boolean
    strict: boolean
    parsedResult: boolean
  }
}

describe('Codex app-server v0 capability matrix', () => {
  test('driver capabilities deep-equal the spec fixture exactly', () => {
    expect(createCodexAppServerDriver().capabilities()).toEqual(CODEX_APP_SERVER_V0_CAPABILITIES)
  })
})

describe('Claude Code tmux capability matrix', () => {
  test('advertises durable Anthropic session continuation and synthesized JSON Schema finals', () => {
    const capabilities =
      createDefaultClaudeCodeTmuxDriver().capabilities() as InvocationCapabilities & {
        finalResponse?:
          | {
              jsonSchema?: boolean
              perTurn?: boolean
              strict?: boolean
              parsedResult?: boolean
            }
          | undefined
      }
    expect(capabilities.continuation).toEqual({
      supported: true,
      provider: 'anthropic',
      keyKind: 'session',
    })
    expect(capabilities.finalResponse).toEqual({
      jsonSchema: true,
      perTurn: true,
      strict: false,
      parsedResult: false,
    })
  })
})

describe('Pi TUI tmux capability matrix', () => {
  test('advertises durable OpenAI session continuation and operator attach', () => {
    const capabilities = createDefaultPiTuiTmuxDriver().capabilities() as InvocationCapabilities & {
      finalResponse?: { jsonSchema?: boolean } | undefined
    }
    expect(capabilities.continuation).toEqual({
      supported: true,
      provider: 'openai',
      keyKind: 'session',
    })
    expect(capabilities.control.attach).toBe(true)
    expect(capabilities.control.driverAttachExistingSurface).toBe(false)
    expect(capabilities.finalResponse?.jsonSchema).not.toBe(true)
  })
})

describe('interrupt landing evidence capability matrix', () => {
  test('declares the evidence each broker driver actually observes', () => {
    expect({
      'agent-harness-tmux':
        createDefaultAgentHarnessTmuxDriver().capabilities().interrupt.landingEvidence,
      'codex-app-server': createCodexAppServerDriver().capabilities().interrupt.landingEvidence,
      'claude-code-tmux':
        createDefaultClaudeCodeTmuxDriver().capabilities().interrupt.landingEvidence,
      'codex-cli-tmux': createDefaultCodexCliTmuxDriver().capabilities().interrupt.landingEvidence,
      'pi-tui-tmux': createDefaultPiTuiTmuxDriver().capabilities().interrupt.landingEvidence,
      noop: createNoopDriver().capabilities().interrupt.landingEvidence,
    }).toEqual({
      'agent-harness-tmux': 'ack',
      'codex-app-server': 'ack',
      'claude-code-tmux': 'transcript',
      'codex-cli-tmux': 'asserted',
      'pi-tui-tmux': 'asserted',
      noop: null,
    })
  })
})
