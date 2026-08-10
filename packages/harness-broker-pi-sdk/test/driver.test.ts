import { describe, expect, test } from 'bun:test'
import type { AgentSessionEvent, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { DriverContext } from 'spaces-harness-broker'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationInput,
} from 'spaces-harness-broker-protocol'
import { type PiSdkSession, type PiSdkSessionFactoryInput, createPiSdkDriver } from '../src/driver'

type CapturedEvent = Pick<InvocationEventEnvelope, 'type' | 'payload'>

describe('pi SDK driver structured output', () => {
  test('re-validates tool args and synthesizes canonical JSON after one retry', async () => {
    const events: CapturedEvent[] = []
    let scheduled: (() => void) | undefined
    let factoryInput: PiSdkSessionFactoryInput | undefined
    let listener: ((event: AgentSessionEvent) => void) | undefined
    let promptCount = 0

    const session: PiSdkSession = {
      sessionFile: '/tmp/pi-driver-test.jsonl',
      isStreaming: false,
      agent: { state: { tools: [{ name: 'bash', parameters: {} }] } },
      subscribe(nextListener) {
        listener = nextListener
        return () => {
          listener = undefined
        }
      },
      async prompt() {
        promptCount += 1
        const params = promptCount === 1 ? { count: 'wrong' } : { count: 2, answer: 'ok' }
        listener?.(piEvent({ type: 'agent_start' }))
        listener?.(
          piEvent({
            type: 'tool_execution_start',
            toolCallId: `structured-${promptCount}`,
            toolName: 'respond_structured',
            args: params,
          })
        )
        const tool = requireFactoryInput(factoryInput).structuredTool
        const result = await executeTool(tool, params)
        listener?.(
          piEvent({
            type: 'tool_execution_end',
            toolCallId: `structured-${promptCount}`,
            toolName: 'respond_structured',
            result,
            isError: false,
          })
        )
        listener?.(piEvent({ type: 'agent_settled' }))
      },
      async steer() {},
      async abort() {},
      async waitForIdle() {},
      getActiveToolNames() {
        return this.agent.state.tools.map((tool) => tool.name)
      },
      setActiveToolsByName(names) {
        this.agent.state.tools.splice(
          0,
          this.agent.state.tools.length,
          ...names.map((name) => ({ name, parameters: {} }))
        )
      },
      dispose() {},
    }
    const driver = createPiSdkDriver({
      schedule(task) {
        scheduled = task
      },
      async createSession(input) {
        factoryInput = input
        session.agent.state.tools.push({ name: 'respond_structured', parameters: {} })
        return session
      },
    })
    await driver.start(spec(), createContext(events))
    await driver.applyInputNow(structuredInput())
    const activeStructuredTool = session.agent.state.tools.find(
      (tool) => tool.name === 'respond_structured'
    )
    expect(activeStructuredTool?.parameters).toEqual(structuredInput().responseFormat?.schema)

    scheduled?.()
    await waitForEvent(events, 'turn.completed')

    expect(promptCount).toBe(2)
    const final = events.find(
      (event) =>
        event.type === 'assistant.message.completed' &&
        (event.payload as { final?: boolean }).final === true
    )
    expect(final?.payload).toMatchObject({
      content: [{ type: 'text', text: '{"answer":"ok","count":2}' }],
      final: true,
    })
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn.failed')).toHaveLength(0)
  })
})

async function executeTool(tool: ToolDefinition, params: unknown): Promise<unknown> {
  return tool.execute('structured', params, undefined, undefined, {} as never)
}

function requireFactoryInput(
  input: PiSdkSessionFactoryInput | undefined
): PiSdkSessionFactoryInput {
  if (input === undefined) throw new Error('session factory input missing')
  return input
}

function structuredInput(): InvocationInput {
  return {
    inputId: 'input-1',
    kind: 'user',
    content: [{ type: 'text', text: 'answer' }],
    responseFormat: {
      kind: 'json_schema',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['answer', 'count'],
        properties: {
          answer: { type: 'string' },
          count: { type: 'integer' },
        },
      },
    },
  }
}

function spec(): HarnessInvocationSpec {
  return {
    specVersion: 'harness-broker.invocation/v1',
    invocationId: 'invocation-driver-test',
    harness: { frontend: 'pi', provider: 'openai', driver: 'pi-sdk' },
    driver: { kind: 'pi-sdk', permissionPolicy: { mode: 'deny' } },
    sdk: { runtime: 'pi-sdk', provider: 'openai', modelId: 'gpt-4.1-nano' },
    process: {
      command: 'in-process',
      args: [],
      cwd: '/tmp',
      harnessTransport: { kind: 'in-process' },
    },
  }
}

function createContext(events: CapturedEvent[]): DriverContext {
  const emit = ((type: string, payload: unknown) => {
    const event = { type, payload } as CapturedEvent
    events.push(event)
    return event
  }) as DriverContext['emit']
  return {
    invocationId: 'invocation-driver-test',
    clientCapabilities: {},
    emit,
    emitEvent: (() => {
      throw new Error('unused')
    }) as DriverContext['emitEvent'],
  } as DriverContext
}

function piEvent(event: Record<string, unknown>): AgentSessionEvent {
  return event as unknown as AgentSessionEvent
}

async function waitForEvent(events: CapturedEvent[], type: string): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!events.some((event) => event.type === type)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${type}`)
    await Bun.sleep(1)
  }
}
