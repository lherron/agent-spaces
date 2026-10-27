import { describe, expect, test } from 'bun:test'
import type { BrokerHelloResponse, InvocationCapabilities } from 'spaces-harness-broker-protocol'
import { CONSERVATIVE_LIFECYCLE_CAPABILITIES } from 'spaces-harness-broker-protocol'
import { createDefaultBroker } from '../src'
import { createDefaultCodexCliTmuxDriver } from '../src/drivers/codex-cli-tmux/driver'
import { createNoopDriver } from '../src/drivers/noop-driver'

/** The capability matrix a client reads from the default broker's hello. */
const helloDriverCapabilities = async (): Promise<Map<string, InvocationCapabilities>> => {
  const hello: BrokerHelloResponse = await createDefaultBroker(undefined, undefined, {
    additionalDrivers: [() => createNoopDriver(), () => createDefaultCodexCliTmuxDriver()],
  }).hello({
    clientInfo: { name: 'capability-matrix' },
    protocolVersions: ['harness-broker/0.2'],
  })
  return new Map(
    hello.drivers.map((driver) => {
      if (!driver.capabilities) throw new Error(`missing capabilities for ${driver.kind}`)
      return [driver.kind, driver.capabilities]
    })
  )
}

const CODEX_APP_SERVER_V0_CAPABILITIES: InvocationCapabilities = {
  admission: { classes: ['steer', 'queue', 'exclusive', 'preempt'] },
  bracketMintingMode: 'delivery-acknowledged',
  queue: { cancelHarnessLocal: false },
  preempt: { mode: 'atomic' },
  steer: { landingEvidence: 'transcript' },
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
  test('broker.hello advertises the codex-app-server v0 capability matrix exactly', async () => {
    expect((await helloDriverCapabilities()).get('codex-app-server')).toEqual(
      CODEX_APP_SERVER_V0_CAPABILITIES
    )
  })
})

describe('Claude Code tmux capability matrix', () => {
  test('broker.hello advertises Claude durable Anthropic session continuation, synthesized JSON Schema finals and operator-only attach', async () => {
    const capabilities = (await helloDriverCapabilities()).get('claude-code-tmux') as
      | (InvocationCapabilities & {
          finalResponse?:
            | {
                jsonSchema?: boolean
                perTurn?: boolean
                strict?: boolean
                parsedResult?: boolean
              }
            | undefined
        })
      | undefined
    expect(capabilities?.continuation).toEqual({
      supported: true,
      provider: 'anthropic',
      keyKind: 'session',
    })
    expect(capabilities?.finalResponse).toEqual({
      jsonSchema: true,
      perTurn: true,
      strict: false,
      parsedResult: false,
    })
    // Operator attach is supported; the driver never attaches to an existing surface itself.
    expect(capabilities?.control.attach).toBe(true)
    expect(capabilities?.control.driverAttachExistingSurface).toBe(false)
  })
})

test('broker.hello advertises Codex tmux operator attach without driver reattachment', async () => {
  const capabilities = (await helloDriverCapabilities()).get('codex-cli-tmux')
  expect(capabilities?.control.attach).toBe(true)
  expect(capabilities?.control.driverAttachExistingSurface).toBe(false)
})

describe('interrupt landing evidence capability matrix', () => {
  test('broker.hello declares the interrupt landing evidence each registered driver observes', async () => {
    const capabilities = await helloDriverCapabilities()
    expect({
      'codex-app-server': capabilities.get('codex-app-server')?.interrupt.landingEvidence,
      'claude-code-tmux': capabilities.get('claude-code-tmux')?.interrupt.landingEvidence,
      'noop-driver': capabilities.get('noop-driver')?.interrupt.landingEvidence,
    }).toEqual({
      'codex-app-server': 'ack',
      'claude-code-tmux': 'transcript',
      'noop-driver': null,
    })
  })
})
