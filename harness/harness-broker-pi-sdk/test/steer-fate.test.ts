import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai'
import {
  type AgentSession,
  SessionManager,
  createAgentSession,
  defineTool,
} from '@earendil-works/pi-coding-agent'
import type { DriverContext } from 'spaces-harness-broker'
import type {
  HarnessInvocationSpec,
  InvocationEvent,
  InvocationEventEnvelope,
  InvocationEventFor,
  InvocationEventPayloadMap,
  InvocationEventType,
  InvocationInput,
} from 'spaces-harness-broker-protocol'
import { createPiSdkDriver } from '../src/driver'
import { inputIdFrom, invocationIdFrom } from './ids'

// These run the driver over a REAL pi AgentSession (scripted by pi-ai's faux
// provider), because the fate a steer earns is decided by pi's own steering
// queue: drained between model rounds of a live run, left behind by an abort
// mid-stream or by a run that already settled (T-11306).

type CapturedEvent = Pick<InvocationEventEnvelope, 'seq' | 'type' | 'payload'> & {
  turnId?: string | undefined
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('pi SDK steer fate', () => {
  test('a steer drained between model rounds is absorbed into the open turn', async () => {
    const h = await harness()
    h.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('slow', {})]),
      fauxAssistantMessage('done'),
    ])

    const { turnId } = await h.driver.applyInputNow(input('prompt-1', 'first'))
    await h.toolStarted()
    await h.driver.applySteerNow?.(input('steer-1', 'STEER-MID'))
    h.releaseTool()
    await h.waitFor('turn.completed')

    const absorbed = h.events.find((event) => event.type === 'submission.absorbed')
    expect(absorbed?.payload).toEqual({ submissionId: 'steer-1', turnId })
    expect(absorbed?.turnId).toBe(turnId)
    const userMessage = h.events.find(
      (event) => event.type === 'user.message' && event.seq < (absorbed?.seq ?? 0)
    )
    expect(userMessage?.payload).toMatchObject({ content: 'STEER-MID', inputId: 'steer-1' })
    expect(h.seq('submission.absorbed')).toBeLessThan(h.seq('turn.completed'))
    expect(h.events.filter((event) => event.type.startsWith('submission.'))).toHaveLength(1)
  })

  test('a steer an abort leaves in the pi queue is withdrawn and reported cancelled', async () => {
    const h = await harness()
    let release: (() => void) | undefined
    h.faux.setResponses([
      async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return fauxAssistantMessage('late')
      },
    ])

    const { turnId } = await h.driver.applyInputNow(input('prompt-1', 'first'))
    while (release === undefined) await Bun.sleep(1)
    await h.driver.applySteerNow?.(input('steer-1', 'STEER-ABORT'))
    const interrupted = h.driver.interrupt({ reason: 'operator-interrupt' } as never)
    release()
    await interrupted
    await h.waitFor('turn.interrupted')

    const cancelled = h.events.find((event) => event.type === 'submission.cancelled')
    expect(cancelled?.payload).toEqual({ submissionId: 'steer-1', reason: 'removed' })
    expect(cancelled?.turnId).toBe(turnId)
    expect(h.seq('submission.cancelled')).toBeLessThan(h.seq('turn.interrupted'))
    expect(h.events.some((event) => event.type === 'submission.absorbed')).toBe(false)
    // Withdrawn from pi, so it cannot ride an unrelated later prompt.
    expect(h.session.getSteeringMessages?.()).toEqual([])

    h.faux.setResponses([fauxAssistantMessage('second')])
    await h.driver.applyInputNow(input('prompt-2', 'second'))
    await h.waitFor('turn.completed')
    const users = h.userTexts()
    expect(users).not.toContain('STEER-ABORT')
  })

  test('a steer with no open turn asks the broker for its own turn', async () => {
    const h = await harness()
    const error = await h.driver.applySteerNow?.(input('steer-1', 'IDLE')).then(
      () => undefined,
      (caught: unknown) => caught
    )
    expect((error as { steerRequiresOwnTurn?: unknown } | undefined)?.steerRequiresOwnTurn).toBe(
      true
    )
    expect(h.session.getSteeringMessages?.()).toEqual([])
    expect(h.events.some((event) => event.type.startsWith('submission.'))).toBe(false)
  })
})

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-steer-fate-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  // AgentSession asks its model runtime whether auth is configured; the faux
  // provider needs none.
  const modelRuntime = Object.assign(Object.create(models) as object, {
    hasConfiguredAuth: () => true,
  })

  let toolStarted = false
  let releaseTool: (() => void) | undefined
  const slow = defineTool({
    name: 'slow',
    label: 'slow',
    description: 'Blocks until the test releases it.',
    parameters: Type.Object({}),
    async execute() {
      toolStarted = true
      await new Promise<void>((resolve) => {
        releaseTool = resolve
      })
      return { content: [{ type: 'text' as const, text: 'ok' }], details: {} }
    },
  })

  let session: AgentSession | undefined
  const driver = createPiSdkDriver({
    async createSession(factoryInput) {
      const created = await createAgentSession({
        cwd: dir,
        agentDir: dir,
        modelRuntime: modelRuntime as never,
        model: faux.getModel(),
        sessionManager: SessionManager.inMemory(dir),
        noTools: 'builtin',
        customTools: [factoryInput.structuredTool, slow],
      })
      session = created.session
      return session
    },
  })
  const events: CapturedEvent[] = []
  await driver.start(spec(dir), context(events))
  cleanups.push(() => driver.dispose())

  const waitFor = async (type: string) => {
    const deadline = Date.now() + 5_000
    while (!events.some((event) => event.type === type)) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${type}: ${events.map((e) => e.type).join(',')}`)
      }
      await Bun.sleep(1)
    }
  }
  const requireSession = (): AgentSession => {
    if (session === undefined) throw new Error('session not created')
    return session
  }
  return {
    driver,
    faux,
    events,
    get session(): AgentSession {
      return requireSession()
    },
    waitFor,
    seq: (type: string) => events.find((event) => event.type === type)?.seq ?? -1,
    userTexts: () =>
      requireSession().messages.flatMap((message) => {
        if (message.role !== 'user') return []
        return typeof message.content === 'string'
          ? [message.content]
          : message.content.map((part) => (part.type === 'text' ? part.text : ''))
      }),
    async toolStarted() {
      const deadline = Date.now() + 5_000
      while (!toolStarted) {
        if (Date.now() > deadline) throw new Error('slow tool never started')
        await Bun.sleep(1)
      }
    },
    releaseTool() {
      releaseTool?.()
    },
  }
}

function input(inputId: string, text: string): InvocationInput {
  return { inputId: inputIdFrom(inputId), kind: 'user', content: [{ type: 'text', text }] }
}

function spec(cwd: string): HarnessInvocationSpec {
  return {
    specVersion: 'harness-broker.invocation/v1',
    invocationId: invocationIdFrom('invocation-steer-fate'),
    harness: { frontend: 'pi', provider: 'openai', driver: 'pi-sdk' },
    driver: { kind: 'pi-sdk', permissionPolicy: { mode: 'allow' } },
    sdk: { runtime: 'pi-sdk', provider: 'openai', modelId: 'faux', authMode: 'api-key' },
    process: { command: 'in-process', args: [], cwd, harnessTransport: { kind: 'in-process' } },
  }
}

type EmitExtra = Parameters<DriverContext['emit']>[2]

function context(events: CapturedEvent[]): DriverContext {
  const invocationId = invocationIdFrom('invocation-steer-fate')
  // Same shape as the broker's own emit: a generic signature over a correlated
  // event-name/payload implementation.
  function record<K extends InvocationEventType>(
    event: InvocationEventFor<K>,
    extra?: EmitExtra
  ): InvocationEventEnvelope<K>
  function record(event: InvocationEvent, extra?: EmitExtra): InvocationEventEnvelope {
    const envelope: InvocationEventEnvelope = {
      invocationId,
      seq: events.length + 1,
      time: new Date().toISOString(),
      ...event,
      ...(extra?.turnId !== undefined ? { turnId: extra.turnId } : {}),
    }
    events.push(envelope)
    return envelope
  }
  return {
    invocationId,
    clientCapabilities: {},
    emit<K extends InvocationEventType>(
      type: K,
      payload: InvocationEventPayloadMap[K],
      extra?: EmitExtra
    ) {
      return record({ type, payload }, extra)
    },
    emitEvent() {
      throw new Error('unused')
    },
  }
}
