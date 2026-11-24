import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { postEnvelopeAndRead } from '../../../src/drivers/hook-bridge-transport'
import { createEventLedger } from '../../../src/event-ledger'
import {
  assistantText,
  assistantToolUse,
  dequeue,
  enqueue,
  humanPrompt,
  peerPrompt,
  queuedCommand,
  removeQueued,
  resumedSessionPrompt,
  stopHookSummary,
  toolResult,
  turnCompanion,
  typedTurn,
} from './desktop-rows'
import {
  claudeHome,
  desktopBroker,
  desktopSpec,
  ofType,
  removeTempDirs,
  story,
  waitFor,
} from './observer-harness'

afterEach(removeTempDirs)

const completed = (events: Parameters<typeof ofType>[0], turnId: string) =>
  ofType(events, 'turn.completed', turnId).length > 0

describe('claude-desktop transcript observation', () => {
  test('a typed turn is bracketed from the transcript alone, with no hook', async () => {
    const home = claudeHome()
    home.write('')
    const { broker, events } = desktopBroker({
      claudeHome: home.home,
      captureDir: join(home.home, 'cap'),
    })
    await broker.start({ spec: desktopSpec('inv-typed') })
    home.append(typedTurn('p1', 'list the files', 'There is one file.'))
    await waitFor(() => completed(events, 'turn_p1'))

    expect(story(events)).toEqual([
      'turn_p1 turn.started',
      'turn_p1 user.message "list the files"',
      'turn_p1 turn.attributed foreign/human',
      'turn_p1 tool.call.started',
      'turn_p1 tool.call.completed',
      'turn_p1 assistant.message.completed "There is one file." final=true',
      'turn_p1 turn.completed',
    ])
    // The shared Claude modules say `claude-code-tmux`; nothing leaves the driver that way.
    const kinds = new Set(events.flatMap((event) => (event.driver ? [event.driver.kind] : [])))
    expect([...kinds]).not.toContain('claude-code-tmux')
    expect(kinds).toContain('claude-desktop')
    // Desktop-only rows are known, not reported as unclassified.
    expect(ofType(events, 'capture.warning')).toEqual([])
    await broker.stop({ invocationId: 'inv-typed' as never, reason: 'test' })
  })

  test('a peer-injected turn is its own turn, recognisable by origin.kind peer', async () => {
    const home = claudeHome()
    home.write('')
    const { broker, events } = desktopBroker({
      claudeHome: home.home,
      captureDir: join(home.home, 'cap'),
    })
    await broker.start({ spec: desktopSpec('inv-peer') })
    const body = 'HRC mail from mable: please report status [hrc:input in-1]'
    home.append(
      enqueue(body) +
        dequeue() +
        turnCompanion('p-peer') +
        peerPrompt('p-peer', body, 9761) +
        assistantText('msg-peer', 'Status: green.') +
        stopHookSummary('p-peer')
    )
    await waitFor(() => completed(events, 'turn_p-peer'))

    expect(story(events)).toEqual([
      'turn_p-peer turn.started',
      // The session's preamble and suffix are stripped back to what was sent.
      `turn_p-peer user.message ${JSON.stringify(body)}`,
      'turn_p-peer turn.attributed unknown/autonomous',
      'turn_p-peer assistant.message.completed "Status: green." final=true',
      'turn_p-peer turn.completed',
    ])
    const origin = ofType(events, 'driver.notice').find(
      (event) =>
        event.type === 'driver.notice' && event.payload.code === 'CLAUDE_DESKTOP_TURN_ORIGIN'
    )
    expect(origin?.payload).toMatchObject({
      data: { turnOrigin: 'peer', originKind: 'peer', verifiedPeerPid: 9761, promptId: 'p-peer' },
    })
    expect(ofType(events, 'capture.warning')).toEqual([])
    await broker.stop({ invocationId: 'inv-peer' as never, reason: 'test' })
  })

  test('a peer message mid-turn is absorbed into the running turn, not a new one', async () => {
    const home = claudeHome()
    home.write('')
    const { broker, events } = desktopBroker({
      claudeHome: home.home,
      captureDir: join(home.home, 'cap'),
    })
    await broker.start({ spec: desktopSpec('inv-midturn') })
    const steer = 'HRC mail: also check the logs [hrc:input in-2]'
    home.append(
      enqueue('run the probes') +
        dequeue() +
        humanPrompt('p2', 'run the probes') +
        assistantToolUse('msg-p2-1', 'tool-p2') +
        enqueue(steer) +
        removeQueued(steer) +
        queuedCommand(steer) +
        toolResult('tool-p2', 'probe ok') +
        assistantText('msg-p2-2', 'Probes ran; logs are clean.') +
        stopHookSummary('p2')
    )
    await waitFor(() => completed(events, 'turn_p2'))

    expect(story(events)).toEqual([
      'turn_p2 turn.started',
      'turn_p2 user.message "run the probes"',
      'turn_p2 turn.attributed foreign/human',
      'turn_p2 tool.call.started',
      `turn_p2 user.message ${JSON.stringify(steer)}`,
      'turn_p2 submission.absorbed',
      'turn_p2 tool.call.completed',
      'turn_p2 assistant.message.completed "Probes ran; logs are clean." final=true',
      'turn_p2 turn.completed',
    ])
    expect(ofType(events, 'turn.started')).toHaveLength(1)
    await broker.stop({ invocationId: 'inv-midturn' as never, reason: 'test' })
  })

  test('a resumed session text-block opening row opens its turn with what was typed', async () => {
    const home = claudeHome()
    home.write('')
    const { broker, events } = desktopBroker({
      claudeHome: home.home,
      captureDir: join(home.home, 'cap'),
    })
    await broker.start({ spec: desktopSpec('inv-resumed') })
    home.append(
      resumedSessionPrompt('p-resume', 'read vegacomms and answer clod') +
        assistantToolUse('msg-resume-1', 'tool-resume') +
        toolResult('tool-resume', 'ok') +
        assistantText('msg-resume-2', 'Answered clod.') +
        stopHookSummary('p-resume')
    )
    await waitFor(() => completed(events, 'turn_p-resume'))
    expect(story(events)).toEqual([
      'turn_p-resume turn.started',
      'turn_p-resume user.message "read vegacomms and answer clod"',
      'turn_p-resume turn.attributed foreign/human',
      'turn_p-resume tool.call.started',
      'turn_p-resume tool.call.completed',
      'turn_p-resume assistant.message.completed "Answered clod." final=true',
      'turn_p-resume turn.completed',
    ])
    expect(ofType(events, 'capture.warning')).toEqual([])
    await broker.stop({ invocationId: 'inv-resumed' as never, reason: 'test' })
  })

  test('turns read in one batch keep their own turn ids', async () => {
    const home = claudeHome()
    home.write('')
    const { broker, events } = desktopBroker({
      claudeHome: home.home,
      captureDir: join(home.home, 'cap'),
    })
    await broker.start({ spec: desktopSpec('inv-batch') })
    home.append(typedTurn('b1', 'one', 'first') + typedTurn('b2', 'two', 'second'))
    await waitFor(() => completed(events, 'turn_b2'))
    const answer = (turnId: string) =>
      ofType(events, 'assistant.message.completed', turnId).map(
        (event) => (event.payload as { content: Array<{ text: string }> }).content[0]?.text
      )
    expect(answer('turn_b1')).toEqual(['first'])
    expect(answer('turn_b2')).toEqual(['second'])
    expect(ofType(events, 'tool.call.started', 'turn_b2')).toHaveLength(1)
    await broker.stop({ invocationId: 'inv-batch' as never, reason: 'test' })
  })

  test('a turn with no terminal row is closed by the next opening row', async () => {
    const home = claudeHome()
    home.write('')
    const { broker, events } = desktopBroker({ claudeHome: home.home })
    await broker.start({ spec: desktopSpec('inv-next') })
    home.append(
      enqueue('first') + dequeue() + humanPrompt('n1', 'first') + assistantText('msg-n1', 'one')
    )
    await waitFor(
      () =>
        ofType(events, 'assistant.message.completed').length === 0 &&
        ofType(events, 'turn.started').length === 1
    )
    home.append(typedTurn('n2', 'second', 'two'))
    await waitFor(() => completed(events, 'turn_n2'))
    expect(story(events).filter((entry) => entry.includes('turn.'))).toEqual([
      'turn_n1 turn.started',
      'turn_n1 turn.attributed foreign/human',
      'turn_n1 turn.completed',
      'turn_n2 turn.started',
      'turn_n2 turn.attributed foreign/human',
      'turn_n2 turn.completed',
    ])
    expect(ofType(events, 'assistant.message.completed', 'turn_n1')).toHaveLength(1)
    await broker.stop({ invocationId: 'inv-next' as never, reason: 'test' })
  })

  test('first join publishes only the still-open turn, not earlier history', async () => {
    const home = claudeHome()
    home.write(
      typedTurn('h1', 'old question', 'old answer') +
        enqueue('current question') +
        dequeue() +
        humanPrompt('h2', 'current question')
    )
    const { broker, events } = desktopBroker({
      claudeHome: home.home,
      captureDir: join(home.home, 'cap'),
    })
    await broker.start({ spec: desktopSpec('inv-first-join') })
    await waitFor(() => ofType(events, 'turn.started').length > 0)
    home.append(assistantText('msg-h2', 'current answer') + stopHookSummary('h2'))
    await waitFor(() => completed(events, 'turn_h2'))
    expect(ofType(events, 'turn.started').map((event) => String(event.turnId))).toEqual(['turn_h2'])
    expect(ofType(events, 'turn.completed').map((event) => String(event.turnId))).toEqual([
      'turn_h2',
    ])
    expect(
      ofType(events, 'user.message').map((event) => (event.payload as { content: string }).content)
    ).toEqual(['current question'])
    await broker.stop({ invocationId: 'inv-first-join' as never, reason: 'test' })
  })

  // HRC mints a new invocation for each broker life (observed live on max3,
  // 2026-11-23); a same-invocation restart is the in-broker reattach path.
  test.each([
    ['a new invocation', 'inv-restart-2', 'resume-cursor'],
    ['the same invocation', 'inv-restart', 'resume'],
  ])(
    'broker restart under %s neither replays nor skips a turn, including one open across it',
    async (_label, secondInvocationId, expectedMode) => {
      const home = claudeHome()
      const captureDir = join(home.home, 'hrc-desktop', 'state')
      mkdirSync(captureDir, { recursive: true })
      const ledgerPath = join(captureDir, 'event-ledger.ndjson')
      const invocationId = 'inv-restart'
      home.write('')

      const firstLedger = createEventLedger({ path: ledgerPath })
      const first = desktopBroker({ claudeHome: home.home, captureDir, eventLedger: firstLedger })
      await first.broker.start({ spec: desktopSpec(invocationId) })
      home.append(typedTurn('r1', 'first', 'one'))
      // r2 opens and calls a tool, then the broker goes away mid-turn.
      home.append(
        enqueue('second') +
          dequeue() +
          humanPrompt('r2', 'second') +
          assistantToolUse('msg-r2-1', 'tool-r2')
      )
      await waitFor(
        () =>
          completed(first.events, 'turn_r1') &&
          ofType(first.events, 'tool.call.started', 'turn_r2').length === 1
      )
      await first.broker.stop({ invocationId: invocationId as never, reason: 'observer restart' })
      firstLedger.close()

      // While no broker runs, r2 finishes and r3 runs start to finish.
      home.append(
        toolResult('tool-r2', 'ok') + assistantText('msg-r2-2', 'two') + stopHookSummary('r2')
      )
      home.append(typedTurn('r3', 'third', 'three'))

      const secondLedger = createEventLedger({ path: ledgerPath })
      const second = desktopBroker({ claudeHome: home.home, captureDir, eventLedger: secondLedger })
      await second.broker.start({ spec: desktopSpec(secondInvocationId) })
      await waitFor(() => completed(second.events, 'turn_r3'))

      const both = [...first.events, ...second.events]
      for (const turnId of ['turn_r1', 'turn_r2', 'turn_r3']) {
        expect(ofType(both, 'turn.started', turnId)).toHaveLength(1)
        expect(ofType(both, 'turn.completed', turnId)).toHaveLength(1)
        expect(ofType(both, 'tool.call.started', turnId)).toHaveLength(1)
        expect(ofType(both, 'tool.call.completed', turnId)).toHaveLength(1)
        expect(
          ofType(both, 'assistant.message.completed', turnId).filter(
            (event) => (event.payload as { final?: boolean }).final
          )
        ).toHaveLength(1)
      }
      // The second broker carried the open turn to its end without reopening it.
      expect(ofType(second.events, 'turn.started').map((event) => String(event.turnId))).toEqual([
        'turn_r3',
      ])
      expect(ofType(second.events, 'turn.completed').map((event) => String(event.turnId))).toEqual([
        'turn_r2',
        'turn_r3',
      ])
      const attach = ofType(second.events, 'driver.notice').find(
        (event) =>
          event.type === 'driver.notice' &&
          event.payload.code === 'CLAUDE_DESKTOP_TRANSCRIPT_ATTACHED'
      )
      expect(attach?.payload).toMatchObject({ data: { mode: expectedMode } })
      await second.broker.stop({ invocationId: secondInvocationId as never, reason: 'test' })
      secondLedger.close()
    }
  )

  test('a turn that runs entirely while no broker serves is still published', async () => {
    const home = claudeHome()
    const captureDir = join(home.home, 'state')
    mkdirSync(captureDir, { recursive: true })
    home.write(typedTurn('d0', 'history', 'old'))
    const first = desktopBroker({ claudeHome: home.home, captureDir })
    await first.broker.start({ spec: desktopSpec('inv-down-1') })
    await waitFor(() => ofType(first.events, 'driver.notice').length > 0)
    await first.broker.stop({ invocationId: 'inv-down-1' as never, reason: 'gone' })
    home.append(typedTurn('d1', 'while down', 'answered'))
    const second = desktopBroker({ claudeHome: home.home, captureDir })
    await second.broker.start({ spec: desktopSpec('inv-down-2') })
    await waitFor(() => completed(second.events, 'turn_d1'))
    expect(
      ofType([...first.events, ...second.events], 'turn.started').map((event) =>
        String(event.turnId)
      )
    ).toEqual(['turn_d1'])
    await second.broker.stop({ invocationId: 'inv-down-2' as never, reason: 'test' })
  })

  test('a hook hint is acknowledged, journaled, and only wakes a read', async () => {
    const home = claudeHome()
    home.write('')
    const socketPath = join(home.home, 'hrc-desktop', 'hook.sock')
    const { broker, events } = desktopBroker({
      claudeHome: home.home,
      captureDir: join(home.home, 'cap'),
      // Polling too slow to matter: the hint is what triggers the read.
      driver: { hookSocketPath: socketPath, pollIntervalMs: 60_000 },
    })
    await broker.start({ spec: desktopSpec('inv-hint') })
    home.append(typedTurn('k1', 'hinted', 'answered'))
    expect(ofType(events, 'turn.started')).toHaveLength(0)

    const hint = {
      hookData: {
        hook_event_name: 'Stop',
        session_id: 'desktop-session-1',
        transcript_path: home.transcript,
      },
    }
    // A fire-and-forget hook writes and half-closes. Bun drops the server's
    // reply to such a client, but the hint itself still lands.
    await new Promise<void>((resolve, reject) => {
      const socket = connect(socketPath)
      socket.on('error', reject)
      socket.on('close', () => resolve())
      socket.on('connect', () => socket.end(JSON.stringify(hint)))
    })
    await waitFor(() => completed(events, 'turn_k1'))
    // A client that reads the reply gets the listener's acknowledgement.
    const reply = await postEnvelopeAndRead(socketPath, hint)
    expect(reply).toBe('ok')
    // The hint minted nothing of its own: one bracket, from the transcript rows.
    expect(ofType(events, 'turn.started')).toHaveLength(1)
    expect(ofType(events, 'turn.completed')).toHaveLength(1)
    await broker.stop({ invocationId: 'inv-hint' as never, reason: 'test' })
  })
})
