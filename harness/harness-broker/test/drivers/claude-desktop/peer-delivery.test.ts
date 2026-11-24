/**
 * T-14466: HRC input reaches a Claude Desktop session through its
 * cross-session messaging socket, steer only, idle and mid-turn, failing open.
 * A real broker drives the real driver; the session is a unix socket that
 * records what it reads plus transcript rows shaped after live max3 sessions.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, connect, createServer } from 'node:net'
import { join } from 'node:path'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { createClaudeDesktopDriver } from '../../../src/drivers/claude-desktop/driver'
import { RECEIVER_BYPASS_PERMISSIONS } from '../../../src/drivers/claude-desktop/peer-delivery'
import {
  DESKTOP_SESSION_ID,
  assistantText,
  assistantToolUse,
  dequeue,
  enqueue,
  humanPrompt,
  peerPrompt,
  queuedCommand,
  removeQueued,
  stopHookSummary,
  toolResult,
} from './desktop-rows'
import {
  claudeHome,
  desktopBroker,
  desktopSpec,
  ofType,
  removeTempDirs,
  waitFor,
} from './observer-harness'

const SESSION_PID = 77321
const TOKEN = 'peer-token-not-a-secret'
const origin = {
  principalRef: 'agent:mable',
  scopeRef: 'mable@hrc-runtime:primary',
  envelopeId: 'EN-1',
}

const servers: Server[] = []
afterEach(() => {
  while (servers.length > 0) servers.pop()?.close()
  removeTempDirs()
})

type Frame = { type: string; token?: string; message?: { role: string; content: string } }

/** A stand-in for the session's messaging socket: it records every connection's lines. */
async function messagingSocket(): Promise<{ path: string; connections: Frame[][] }> {
  // Unix socket paths are short; the tmpdir on macOS is not.
  const path = join('/tmp', `cdp-${crypto.randomUUID().slice(0, 8)}.sock`)
  const connections: Frame[][] = []
  const server = createServer((socket) => {
    let buffered = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffered += chunk
    })
    socket.on('end', () => {
      connections.push(
        buffered
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as Frame)
      )
      socket.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  servers.push(server)
  return { path, connections }
}

/** A desktop session: fake `~/.claude` with a registry row, a socket and a broker. */
async function session(
  invocationId: string,
  options: { confirmWindowMs?: number; hookSocket?: boolean; status?: string } = {}
) {
  const home = claudeHome()
  home.write('')
  const socket = await messagingSocket()
  mkdirSync(join(home.home, 'sessions'), { recursive: true })
  writeFileSync(
    join(home.home, 'sessions', `${SESSION_PID}.json`),
    JSON.stringify({
      pid: SESSION_PID,
      sessionId: DESKTOP_SESSION_ID,
      entrypoint: 'claude-desktop',
      version: '2.1.330',
      peerProtocol: 1,
      status: options.status ?? 'idle',
      ...(options.status === 'waiting' ? { waitingFor: 'permission prompt' } : {}),
      messagingSocketPath: socket.path,
    })
  )
  const hookSocketPath = join(home.home, 'hrc-desktop', 'hook.sock')
  const { broker, events } = desktopBroker({
    claudeHome: home.home,
    captureDir: join(home.home, 'cap'),
    driver: {
      hookSocketPath: options.hookSocket === true ? hookSocketPath : false,
      delivery: {
        env: { CLAUDE_PID: String(SESSION_PID), CLAUDE_CODE_MESSAGING_TOKEN: TOKEN },
        ...(options.confirmWindowMs !== undefined
          ? { confirmWindowMs: options.confirmWindowMs }
          : {}),
      },
    },
  })
  await broker.start({ spec: desktopSpec(invocationId) })
  const steer = (body: string) =>
    broker.steer({ invocationId: invocationId as never, origin, body })
  const stop = () => broker.stop({ invocationId: invocationId as never, reason: 'test' })
  return { home, socket, broker, events, steer, stop, hookSocketPath }
}

/** The content of the n-th message the session read. */
function written(socket: { connections: Frame[][] }, index: number): string {
  const frame = socket.connections[index]?.find((candidate) => candidate.type === 'user')
  if (frame?.message === undefined) throw new Error(`no message on connection ${index}`)
  return frame.message.content
}

function terminalsFor(events: InvocationEventEnvelope[], submissionId: string) {
  return events
    .filter(
      (event) =>
        event.type.startsWith('submission.') &&
        (event.payload as { submissionId?: string }).submissionId === submissionId
    )
    .map((event) => ({
      type: event.type,
      ...((event.payload as { turnId?: string }).turnId !== undefined
        ? { turnId: (event.payload as { turnId?: string }).turnId }
        : {}),
      ...((event.payload as { reason?: string }).reason !== undefined
        ? { reason: (event.payload as { reason?: string }).reason }
        : {}),
    }))
}

async function hint(socketPath: string, hookData: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(socketPath)
    socket.on('error', reject)
    socket.on('close', () => resolve())
    socket.on('connect', () => socket.end(JSON.stringify({ hookData })))
  })
}

describe('claude-desktop peer delivery (T-14466)', () => {
  test('declares steer as its one door, with transcript landing evidence', () => {
    const driver = createClaudeDesktopDriver({ sessionId: DESKTOP_SESSION_ID, claudeHome: '/none' })
    expect(driver.capabilities().admission.classes).toEqual(['steer'])
    expect(driver.capabilities().steer.landingEvidence).toBe('transcript')
    expect(driver.steerLandingEvidence).toBe('transcript')
    // The session starts its own turn when it reads the message.
    expect(driver.steerNeverStartsTurn).toBe(true)
  })

  test('idle: the message is written once, opens its own turn and executes on its marker', async () => {
    const run = await session('inv-idle')
    const steered = await run.steer('Status please.')
    expect(steered.admission).toBe('admitted')
    const id = steered.submissionId
    await waitFor(() => run.socket.connections.length === 1)

    // Auth line, then the message: HRC sender line, the body, the marker.
    expect(run.socket.connections[0]?.[0]).toEqual({ type: 'auth', token: TOKEN })
    const body = written(run.socket, 0)
    expect(body).toBe(
      `[HRC delivery from mable@hrc-runtime:primary, envelope EN-1]\nStatus please.\n\n[hrc:input ${id}]`
    )
    // The session wakes and records the message as a peer turn.
    run.home.append(
      enqueue(body) +
        dequeue() +
        peerPrompt('p-idle', body, 4242) +
        assistantText('msg-idle', 'All green.') +
        stopHookSummary('p-idle')
    )
    await waitFor(() => ofType(run.events, 'turn.completed', 'turn_p-idle').length === 1)

    expect(terminalsFor(run.events, id)).toEqual([
      { type: 'submission.executed', turnId: 'turn_p-idle' },
    ])
    const attributed = ofType(run.events, 'turn.attributed', 'turn_p-idle')[0]
    expect(attributed?.payload).toMatchObject({ ownership: 'own', inputId: id, origin: 'broker' })
    expect(run.socket.connections).toHaveLength(1)
    expect(ofType(run.events, 'capture.warning')).toEqual([])
    await run.stop()
  })

  test('busy: the message is written mid-turn and absorbed into the running turn', async () => {
    const run = await session('inv-busy')
    run.home.append(
      enqueue('run the probes') +
        dequeue() +
        humanPrompt('p-busy', 'run the probes') +
        assistantToolUse('msg-busy-1', 'tool-busy')
    )
    await waitFor(() => ofType(run.events, 'turn.started', 'turn_p-busy').length === 1)

    const id = (await run.steer('Also check the logs.')).submissionId
    await waitFor(() => run.socket.connections.length === 1)
    const body = written(run.socket, 0)
    // Claude reads it between tool calls and absorbs it into the turn.
    run.home.append(
      enqueue(body) +
        removeQueued(body) +
        queuedCommand(body) +
        toolResult('tool-busy', 'probe ok') +
        assistantText('msg-busy-2', 'Probes ran; logs are clean.') +
        stopHookSummary('p-busy')
    )
    await waitFor(() => ofType(run.events, 'turn.completed', 'turn_p-busy').length === 1)

    expect(terminalsFor(run.events, id)).toEqual([
      { type: 'submission.absorbed', turnId: 'turn_p-busy' },
    ])
    expect(ofType(run.events, 'turn.started')).toHaveLength(1)
    expect(run.socket.connections).toHaveLength(1)
    await run.stop()
  })

  test('busy, as live: a long tool call outlasts the window once the body is queued', async () => {
    const run = await session('inv-busy-live', { confirmWindowMs: 150 })
    run.home.append(
      enqueue('run the ticks') +
        dequeue() +
        humanPrompt('p-ticks', 'run the ticks') +
        assistantToolUse('msg-ticks-1', 'tool-ticks')
    )
    await waitFor(() => ofType(run.events, 'turn.started', 'turn_p-ticks').length === 1)
    const id = (await run.steer('Mid-turn.')).submissionId
    await waitFor(() => run.socket.connections.length === 1)
    const body = written(run.socket, 0)
    // Claude queues the message at once, then holds it until the tool returns.
    run.home.append(enqueue(body))
    await waitFor(() =>
      ofType(run.events, 'driver.notice').some(
        (event) =>
          event.type === 'driver.notice' && event.payload.code === 'CLAUDE_DESKTOP_DELIVERY_QUEUED'
      )
    )
    await Bun.sleep(400)
    expect(terminalsFor(run.events, id)).toEqual([])
    // Live order (max3, 2026-11-24): the peer queued_command row, then its remove.
    run.home.append(
      queuedCommand(body, { kind: 'peer', from: 'unknown' }) +
        removeQueued(body) +
        toolResult('tool-ticks', 'tick 9') +
        assistantText('msg-ticks-2', 'Ticks done; saw the mid-turn message.') +
        stopHookSummary('p-ticks')
    )
    await waitFor(() => ofType(run.events, 'turn.completed', 'turn_p-ticks').length === 1)
    expect(terminalsFor(run.events, id)).toEqual([
      { type: 'submission.absorbed', turnId: 'turn_p-ticks' },
    ])
    const absorbed = ofType(run.events, 'user.message', 'turn_p-ticks').map(
      (event) => (event.payload as { content: string }).content
    )
    expect(absorbed).toEqual(['run the ticks', body])
    expect(ofType(run.events, 'capture.warning')).toEqual([])
    expect(ofType(run.events, 'turn.started')).toHaveLength(1)
    await run.stop()
  })

  test('the UserPromptSubmit prompt marker alone proves execution', async () => {
    const run = await session('inv-hook-marker', { hookSocket: true })
    const id = (await run.steer('Hook path.')).submissionId
    await waitFor(() => run.socket.connections.length === 1)
    const body = written(run.socket, 0)
    await hint(run.hookSocketPath, {
      hook_event_name: 'UserPromptSubmit',
      session_id: DESKTOP_SESSION_ID,
      prompt_id: 'p-hook',
      permission_mode: 'auto',
      prompt: body,
    })
    await waitFor(() => terminalsFor(run.events, id).length > 0)
    expect(terminalsFor(run.events, id)).toEqual([
      { type: 'submission.executed', turnId: 'turn_p-hook' },
    ])
    await run.stop()
  })

  test('bypass: a bypassPermissions receiver gets no write and submission.rejected', async () => {
    const run = await session('inv-bypass', { hookSocket: true })
    await hint(run.hookSocketPath, {
      hook_event_name: 'Stop',
      session_id: DESKTOP_SESSION_ID,
      permission_mode: 'bypassPermissions',
    })
    // The hint is applied on arrival; give the listener a moment.
    await Bun.sleep(30)
    const id = (await run.steer('Will be refused.')).submissionId
    await waitFor(() => terminalsFor(run.events, id).length > 0)

    expect(terminalsFor(run.events, id)).toEqual([
      { type: 'submission.rejected', reason: RECEIVER_BYPASS_PERMISSIONS },
    ])
    const rejected = ofType(run.events, 'input.rejected').find(
      (event) => event.inputId === (id as never)
    )
    expect(rejected?.payload).toMatchObject({ deliveryEvidence: 'not_written' })
    await Bun.sleep(30)
    expect(run.socket.connections).toHaveLength(0)

    // Delivery resumes once the session leaves bypass mode.
    run.home.append(
      enqueue('next') +
        dequeue() +
        humanPrompt('p-auto', 'next', 'auto') +
        stopHookSummary('p-auto')
    )
    await waitFor(() => ofType(run.events, 'turn.completed', 'turn_p-auto').length === 1)
    await run.steer('Now it lands.')
    await waitFor(() => run.socket.connections.length === 1)
    await run.stop()
  })

  test('unconfirmed: no marker within the window is submission.lost, and delivery continues', async () => {
    const run = await session('inv-lost', { confirmWindowMs: 150, status: 'waiting' })
    const first = (await run.steer('Never recorded.')).submissionId
    await waitFor(() => run.socket.connections.length === 1)
    await waitFor(() => terminalsFor(run.events, first).length > 0)
    expect(terminalsFor(run.events, first)).toEqual([
      { type: 'submission.lost', reason: 'turn-correlation-lost' },
    ])
    const unconfirmed = ofType(run.events, 'driver.notice').find(
      (event) =>
        event.type === 'driver.notice' &&
        event.payload.code === 'CLAUDE_DESKTOP_DELIVERY_UNCONFIRMED'
    )
    expect(unconfirmed?.payload).toMatchObject({
      data: {
        inputId: first,
        windowMs: 150,
        receiverStatus: 'waiting',
        receiverWaitingFor: 'permission prompt',
      },
    })

    // The next submission is still written, and it lands.
    const second = (await run.steer('This one lands.')).submissionId
    await waitFor(() => run.socket.connections.length === 2)
    const body = written(run.socket, 1)
    run.home.append(
      enqueue(body) + dequeue() + peerPrompt('p-second', body) + stopHookSummary('p-second')
    )
    await waitFor(() => terminalsFor(run.events, second).length > 0)
    expect(terminalsFor(run.events, second)).toEqual([
      { type: 'submission.executed', turnId: 'turn_p-second' },
    ])
    // The lost body was written once and never again.
    expect(run.socket.connections.map((_, index) => written(run.socket, index))).toEqual([
      expect.stringContaining(`[hrc:input ${first}]`),
      body,
    ])
    await run.stop()
  })

  test('one unresolved attempt per session: a second steer waits for the first to settle', async () => {
    const run = await session('inv-fence')
    const first = (await run.steer('First.')).submissionId
    const second = (await run.steer('Second.')).submissionId
    await waitFor(() => run.socket.connections.length === 1)
    await Bun.sleep(100)
    expect(run.socket.connections).toHaveLength(1)

    const firstBody = written(run.socket, 0)
    expect(firstBody).toContain(`[hrc:input ${first}]`)
    run.home.append(
      enqueue(firstBody) + dequeue() + peerPrompt('p-first', firstBody) + stopHookSummary('p-first')
    )
    await waitFor(() => run.socket.connections.length === 2)
    expect(written(run.socket, 1)).toContain(`[hrc:input ${second}]`)
    await run.stop()
  })

  test('a broker kill leaves a possibly-written attempt that the next broker never resends', async () => {
    const run = await session('inv-observer')
    await run.stop()
    // A broker life in its own process writes one message and is SIGKILLed
    // with the attempt unresolved: it never reports a terminal.
    const child = Bun.spawn(
      ['bun', join(import.meta.dir, 'kill-target.ts'), run.home.home, String(SESSION_PID), 'Hi.'],
      { stdout: 'pipe', stderr: 'inherit' }
    )
    const reader = child.stdout.getReader()
    let output = ''
    while (!output.includes('submission ')) {
      const chunk = await reader.read()
      if (chunk.done) break
      output += new TextDecoder().decode(chunk.value)
    }
    await waitFor(() => run.socket.connections.length === 1)
    child.kill('SIGKILL')
    await child.exited
    const id = /submission (\S+)/.exec(output)?.[1] as string
    const body = written(run.socket, 0)
    expect(body).toContain(`[hrc:input ${id}]`)

    // The hook respawns the joiner: a new broker life on the same session.
    const next = desktopBroker({
      claudeHome: run.home.home,
      captureDir: join(run.home.home, 'cap-next'),
      driver: { delivery: { env: { CLAUDE_PID: String(SESSION_PID) } } },
    })
    await next.broker.start({ spec: desktopSpec('inv-next-life') })
    // The session then records the message the killed life wrote.
    run.home.append(
      enqueue(body) + dequeue() + peerPrompt('p-late', body) + stopHookSummary('p-late')
    )
    await waitFor(() => ofType(next.events, 'turn.completed', 'turn_p-late').length === 1)
    await Bun.sleep(50)

    // Nothing was written again, and the new life claims no submission it never admitted.
    expect(run.socket.connections).toHaveLength(1)
    expect(terminalsFor(next.events, id)).toEqual([])
    expect(ofType(next.events, 'turn.attributed', 'turn_p-late')[0]?.payload).toMatchObject({
      ownership: 'unknown',
    })
    await next.broker.stop({ invocationId: 'inv-next-life' as never, reason: 'test' })
  })

  test('a socket that cannot be reached is refused not_written, with no attempt left open', async () => {
    const run = await session('inv-unreachable')
    servers.pop()?.close()
    await Bun.sleep(20)
    rmSync(run.socket.path, { force: true })
    const id = (await run.steer('Nobody listening.')).submissionId
    await waitFor(() => terminalsFor(run.events, id).length > 0)
    expect(terminalsFor(run.events, id)).toEqual([
      expect.objectContaining({ type: 'submission.rejected' }),
    ])
    const rejected = ofType(run.events, 'input.rejected').find(
      (event) => event.inputId === (id as never)
    )
    expect(rejected?.payload).toMatchObject({ deliveryEvidence: 'not_written' })
    await run.stop()
  })
})
