import { describe, expect, test } from 'bun:test'
import type { InvocationCapabilities } from 'spaces-harness-broker-protocol'
import { CONSERVATIVE_LIFECYCLE_CAPABILITIES } from 'spaces-harness-broker-protocol'
import { createDefaultClaudeCodeTmuxDriver } from '../src/drivers/claude-code-tmux/driver'
import { createCodexAppServerDriver } from '../src/drivers/codex-app-server/driver'
import { createDefaultPiTuiTmuxDriver } from '../src/drivers/pi-tui-tmux/driver'

const CODEX_APP_SERVER_V0_CAPABILITIES: InvocationCapabilities = {
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
    interrupt: 'unsupported',
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
