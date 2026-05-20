import { describe, expect, test } from 'bun:test'
import type { InvocationCapabilities } from 'spaces-harness-broker-protocol'
import { createCodexAppServerDriver } from '../src/drivers/codex-app-server/driver'

const CODEX_APP_SERVER_V0_CAPABILITIES: InvocationCapabilities = {
  input: {
    user: true,
    steer: false,
    appendContext: false,
    localImages: true,
    fileRefs: false,
    queue: false,
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
}

describe('Codex app-server v0 capability matrix', () => {
  test('driver capabilities deep-equal the spec fixture exactly', () => {
    expect(createCodexAppServerDriver().capabilities()).toEqual(CODEX_APP_SERVER_V0_CAPABILITIES)
  })
})
