import { describe, expect, test } from 'bun:test'
import { readFile, rm } from 'node:fs/promises'
import { inputIdFrom, invocationIdFrom, turnIdFrom } from '../../ids'
import {
  FakeCodexRpc,
  emitTurn,
  lease,
  origin,
  setupDriver,
  waitFor,
} from './codex-tui-transport-support'

describe('codex-tui queue attribution', () => {
  test('handshakes experimentally and attributes two queued inputs without turn/start', async () => {
    const rpc = new FakeCodexRpc()
    let turnNumber = 0
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        const inputId = (params as { clientUserMessageId: string }).clientUserMessageId
        const turnId = `turn_own_${++turnNumber}`
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_test',
            turn: { id: turnId, status: 'inProgress', items: [] },
          })
          rpc.emit('item/started', {
            threadId: 'thread_test',
            turnId,
            item: {
              id: `user_${turnId}`,
              type: 'userMessage',
              clientId: inputId,
              content: [{ type: 'text', text: `prompt ${inputId}` }],
            },
          })
          setTimeout(() => {
            rpc.emit('item/started', {
              threadId: 'thread_test',
              turnId,
              item: { id: `agent_${turnId}`, type: 'agentMessage', text: '' },
            })
            rpc.emit('item/completed', {
              threadId: 'thread_test',
              turnId,
              item: {
                id: `agent_${turnId}`,
                type: 'agentMessage',
                text: `done ${inputId}`,
              },
            })
            rpc.emit('turn/completed', {
              threadId: 'thread_test',
              turn: {
                id: turnId,
                status: 'completed',
                items: [
                  {
                    id: `agent_${turnId}`,
                    type: 'agentMessage',
                    text: `done ${inputId}`,
                  },
                ],
              },
            })
          }, 5)
        })
        return { queuedSubmission: { id: `queued_${inputId}` } }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const run = await setupDriver(rpc, 'inv_codex_tui_two_queue')
    try {
      const started = await run.broker.start(
        {
          spec: run.invocationSpec,
          initialInput: {
            inputId: inputIdFrom('input_launch'),
            kind: 'user',
            content: [{ type: 'text', text: 'launch' }],
          },
        },
        {},
        { terminalSurface: lease() }
      )
      expect(started.capabilities.admission.classes).toEqual(['steer', 'queue'])
      await waitFor(
        () =>
          run.events.some(
            (event) => event.type === 'turn.completed' && event.inputId === 'input_launch'
          ),
        'launch queue input should complete'
      )
      const second = await run.broker.enqueue({
        invocationId: invocationIdFrom('inv_codex_tui_two_queue'),
        origin,
        body: 'second',
      })
      expect(second.admission).toBe('admitted')
      await waitFor(
        () => run.events.filter((event) => event.type === 'turn.completed').length === 2,
        'second queue input should complete'
      )

      const initialize = rpc.requests.find((request) => request.method === 'initialize')
      expect(initialize?.params).toEqual(
        expect.objectContaining({ capabilities: { experimentalApi: true } })
      )
      expect(rpc.notifications).toEqual([{ method: 'initialized', params: {} }])
      expect(rpc.requests.filter((request) => request.method === 'thread/queue/add')).toHaveLength(
        2
      )
      expect(rpc.requests.some((request) => request.method === 'turn/start')).toBe(false)
      expect(run.events.filter((event) => event.type === 'turn.attributed')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            ownership: 'own',
            inputId: 'input_launch',
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            ownership: 'own',
            inputId: second.submissionId,
          }),
        }),
      ])
      expect(run.events.filter((event) => event.type === 'submission.executed')).toHaveLength(2)
      expect(run.events.filter((event) => event.type === 'submission.lost')).toHaveLength(0)
      const exclusive = await run.broker.invoke({
        invocationId: invocationIdFrom('inv_codex_tui_two_queue'),
        origin,
        body: 'must refuse',
      })
      expect(exclusive).toMatchObject({
        admission: 'rejected',
        reason: 'unsupported:exclusive',
      })
      expect(rpc.requests.filter((request) => request.method === 'thread/queue/add')).toHaveLength(
        2
      )
    } finally {
      await run.broker.stop({
        invocationId: invocationIdFrom('inv_codex_tui_two_queue'),
        reason: 'test cleanup',
      })
      await run.broker.dispose({ invocationId: invocationIdFrom('inv_codex_tui_two_queue') })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('scrubs stale queue entries before resume and writes the attach token afterward', async () => {
    const rpc = new FakeCodexRpc()
    rpc.onRequest = async (method) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/queue/list') {
        return {
          data: [
            { id: 'stale_1', clientUserMessageId: 'old_input_1' },
            { id: 'stale_2', clientUserMessageId: 'old_input_2' },
          ],
        }
      }
      if (method === 'thread/queue/delete') return { deleted: true }
      if (method === 'thread/resume') return { thread: { id: 'thread_resume' } }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const run = await setupDriver(rpc, 'inv_codex_tui_resume', {
      resumeThreadId: 'thread_resume',
    })
    let socketPath = ''
    try {
      // The injected connector receives the concrete hashed socket through the
      // fake peer setup; discover it from the generated pane launch command.
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      const methods = rpc.requests.map((request) => request.method)
      expect(methods.slice(0, 6)).toEqual([
        'initialize',
        'hooks/list',
        'thread/queue/list',
        'thread/queue/delete',
        'thread/queue/delete',
        'thread/resume',
      ])
      const diagnostics = run.events.filter(
        (event) =>
          event.type === 'diagnostic' &&
          (event.payload as { message?: string }).message ===
            'Removed stale Codex queued input before resume'
      )
      expect(diagnostics).toHaveLength(2)
      expect(diagnostics.map((event) => JSON.stringify(event.payload))).toEqual([
        expect.stringContaining('old_input_1'),
        expect.stringContaining('old_input_2'),
      ])
      const launch = run.tmux.launched.find((line) => line.includes('codex-tui')) ?? ''
      const match = launch.match(/--launch-file\s+(?:'([^']+)'|"([^"]+)"|(\S+))/)
      const launchFile = match?.[1] ?? match?.[2] ?? match?.[3]
      expect(launchFile).toBeDefined()
      if (launchFile !== undefined) {
        const artifact = JSON.parse(await readFile(launchFile, 'utf8')) as {
          argv: string[]
        }
        socketPath = artifact.argv[artifact.argv.indexOf('--socket') + 1] ?? ''
        expect((await readFile(socketPath.replace(/\.app\.sock$/, '.attach'), 'utf8')).trim()).toBe(
          'thread_resume'
        )
      }
    } finally {
      await run.broker.stop({
        invocationId: invocationIdFrom('inv_codex_tui_resume'),
        reason: 'test cleanup',
      })
      await run.broker.dispose({ invocationId: invocationIdFrom('inv_codex_tui_resume') })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('keeps a queued input separate from a foreign interrupted turn and starts it explicitly', async () => {
    const rpc = new FakeCodexRpc()
    let queuedInputId = ''
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        queuedInputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_test',
            turn: { id: 'turn_human', status: 'inProgress', items: [] },
          })
          rpc.emit('item/started', {
            threadId: 'thread_test',
            turnId: 'turn_human',
            item: {
              id: 'user_turn_human',
              type: 'userMessage',
              clientId: null,
              content: [{ type: 'text', text: 'human race' }],
            },
          })
          setTimeout(
            () =>
              rpc.emit('turn/completed', {
                threadId: 'thread_test',
                turn: { id: 'turn_human', status: 'interrupted', items: [] },
              }),
            5
          )
        })
        return { queuedSubmission: { id: 'queued_after_interrupt' } }
      }
      if (method === 'thread/queue/start') {
        queueMicrotask(() => emitTurn(rpc, 'turn_broker', { clientId: queuedInputId }))
        return { turn: { id: 'turn_broker', status: 'inProgress' } }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const run = await setupDriver(rpc, 'inv_codex_tui_interrupt_race')
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      const queued = await run.broker.enqueue({
        invocationId: invocationIdFrom('inv_codex_tui_interrupt_race'),
        origin,
        body: 'queued broker input',
      })
      await waitFor(
        () => run.events.some((event) => event.type === 'submission.executed'),
        'broker input should execute after explicit queue/start'
      )
      expect(rpc.requests.map((request) => request.method)).toContain('thread/queue/start')
      expect(
        run.events.find(
          (event) => event.type === 'turn.attributed' && event.turnId === 'turn_human'
        )?.payload
      ).toMatchObject({ ownership: 'foreign', origin: 'human' })
      expect(run.events.find((event) => event.type === 'submission.executed')?.payload).toEqual({
        submissionId: queued.submissionId,
        turnId: turnIdFrom('turn_broker'),
      })
      expect(
        run.events.find((event) => event.type === 'user.message' && event.turnId === 'turn_human')
          ?.inputId
      ).toBeUndefined()
      expect(run.events.filter((event) => event.type === 'submission.lost')).toHaveLength(0)
    } finally {
      await run.broker.stop({
        invocationId: invocationIdFrom('inv_codex_tui_interrupt_race'),
        reason: 'test cleanup',
      })
      await run.broker.dispose({
        invocationId: invocationIdFrom('inv_codex_tui_interrupt_race'),
      })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('starts the next idle queue submission after an owned turn was interrupted', async () => {
    const rpc = new FakeCodexRpc()
    let queueAdds = 0
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        const inputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueAdds += 1
        if (queueAdds === 1) {
          setTimeout(
            () =>
              emitTurn(rpc, 'turn_interrupted_own', {
                clientId: inputId,
                terminal: 'interrupted',
              }),
            0
          )
        }
        return { queuedSubmission: { id: `queued_${queueAdds}` } }
      }
      if (method === 'thread/queue/start') {
        const queuedSubmissionId = (params as { queuedSubmissionId: string }).queuedSubmissionId
        expect(queuedSubmissionId).toBe('queued_2')
        const secondInputId = rpc.requests
          .filter((request) => request.method === 'thread/queue/add')
          .at(-1)?.params as { clientUserMessageId: string }
        queueMicrotask(() =>
          emitTurn(rpc, 'turn_after_interrupt', {
            clientId: secondInputId.clientUserMessageId,
          })
        )
        return { turn: { id: 'turn_after_interrupt', status: 'inProgress' } }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const run = await setupDriver(rpc, 'inv_codex_tui_owned_interrupt_then_queue')
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      const first = await run.broker.enqueue({
        invocationId: invocationIdFrom('inv_codex_tui_owned_interrupt_then_queue'),
        origin,
        body: 'first',
      })
      await waitFor(
        () =>
          run.events.some(
            (event) => event.type === 'turn.interrupted' && event.inputId === first.submissionId
          ),
        'first owned turn should interrupt'
      )
      const second = await run.broker.enqueue({
        invocationId: invocationIdFrom('inv_codex_tui_owned_interrupt_then_queue'),
        origin,
        body: 'second',
      })
      await waitFor(
        () =>
          run.events.some(
            (event) => event.type === 'turn.completed' && event.inputId === second.submissionId
          ),
        'post-interrupt queue input should execute after queue/start'
      )
      expect(
        rpc.requests.filter((request) => request.method === 'thread/queue/start')
      ).toHaveLength(1)
      expect(run.events.filter((event) => event.type === 'submission.lost')).toHaveLength(0)
    } finally {
      await run.broker.stop({
        invocationId: invocationIdFrom('inv_codex_tui_owned_interrupt_then_queue'),
        reason: 'test cleanup',
      })
      await run.broker.dispose({
        invocationId: invocationIdFrom('inv_codex_tui_owned_interrupt_then_queue'),
      })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('holds resumed launch input behind an autonomous startup turn before queue delivery', async () => {
    const rpc = new FakeCodexRpc()
    let launchInputId = ''
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/queue/list') return { data: [] }
      if (method === 'thread/resume') {
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_resume_goal',
            turn: { id: 'turn_goal_startup', status: 'inProgress', items: [] },
          })
          setTimeout(() => {
            rpc.emit('item/started', {
              threadId: 'thread_resume_goal',
              turnId: 'turn_goal_startup',
              item: { id: 'goal_agent', type: 'agentMessage', text: '' },
            })
            rpc.emit('turn/completed', {
              threadId: 'thread_resume_goal',
              turn: { id: 'turn_goal_startup', status: 'completed', items: [] },
            })
          }, 20)
        })
        return { thread: { id: 'thread_resume_goal' } }
      }
      if (method === 'thread/queue/add') {
        launchInputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueMicrotask(() => emitTurn(rpc, 'turn_launch_after_goal', { clientId: launchInputId }))
        return { queuedSubmission: { id: 'queued_launch_after_goal' } }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const run = await setupDriver(rpc, 'inv_codex_tui_resume_goal', {
      resumeThreadId: 'thread_resume_goal',
    })
    try {
      await run.broker.start(
        {
          spec: run.invocationSpec,
          initialInput: {
            inputId: inputIdFrom('input_launch_after_goal'),
            kind: 'user',
            content: [{ type: 'text', text: 'launch after goal' }],
          },
        },
        {},
        { terminalSurface: lease() }
      )
      expect(
        (
          await run.broker.seatProbe({
            invocationId: invocationIdFrom('inv_codex_tui_resume_goal'),
          })
        ).seat
      ).toEqual({ state: 'turn-observed', turnId: turnIdFrom('turn_goal_startup') })
      expect(rpc.requests.some((request) => request.method === 'thread/queue/add')).toBe(false)
      await waitFor(
        () =>
          run.events.some(
            (event) =>
              event.type === 'submission.executed' &&
              event.payload.submissionId === 'input_launch_after_goal'
          ),
        'launch input should drain after autonomous startup turn'
      )
      const goalTerminalIndex = run.events.findIndex(
        (event) => event.type === 'turn.completed' && event.turnId === 'turn_goal_startup'
      )
      const launchAcceptedIndex = run.events.findIndex(
        (event) => event.type === 'input.accepted' && event.inputId === 'input_launch_after_goal'
      )
      expect(goalTerminalIndex).toBeGreaterThanOrEqual(0)
      expect(launchAcceptedIndex).toBeGreaterThan(goalTerminalIndex)
      expect(
        run.events.find(
          (event) => event.type === 'turn.attributed' && event.turnId === 'turn_goal_startup'
        )?.payload
      ).toMatchObject({ ownership: 'foreign', origin: 'autonomous' })
      expect(
        run.events.find(
          (event) =>
            event.type === 'submission.executed' &&
            event.payload.submissionId === 'input_launch_after_goal'
        )?.payload
      ).toMatchObject({ turnId: 'turn_launch_after_goal' })
    } finally {
      await run.broker.stop({
        invocationId: invocationIdFrom('inv_codex_tui_resume_goal'),
        reason: 'test cleanup',
      })
      await run.broker.dispose({ invocationId: invocationIdFrom('inv_codex_tui_resume_goal') })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('keeps a later queued input out of a completed human race turn', async () => {
    const rpc = new FakeCodexRpc()
    let queuedInputId = ''
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        queuedInputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueMicrotask(() => {
          emitTurn(rpc, 'turn_human_completed', { clientId: null })
          emitTurn(rpc, 'turn_broker_after_human', { clientId: queuedInputId })
        })
        return { queuedSubmission: { id: 'queued_completed_race' } }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const run = await setupDriver(rpc, 'inv_codex_tui_completed_race')
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      const queued = await run.broker.enqueue({
        invocationId: invocationIdFrom('inv_codex_tui_completed_race'),
        origin,
        body: 'queued behind human',
      })
      await waitFor(
        () =>
          run.events.some(
            (event) =>
              event.type === 'submission.executed' &&
              event.payload.submissionId === queued.submissionId
          ),
        'queued input should execute in its distinct post-human turn'
      )
      const humanTurn = run.events.find(
        (event) => event.type === 'turn.attributed' && event.turnId === 'turn_human_completed'
      )
      const executed = run.events.find(
        (event) =>
          event.type === 'submission.executed' && event.payload.submissionId === queued.submissionId
      )
      expect(humanTurn?.payload).toMatchObject({
        ownership: 'foreign',
        origin: 'human',
      })
      expect(humanTurn?.inputId).toBeUndefined()
      expect(executed?.payload).toMatchObject({
        turnId: 'turn_broker_after_human',
      })
      expect(run.events.filter((event) => event.type === 'submission.lost')).toHaveLength(0)
    } finally {
      await run.broker.stop({
        invocationId: invocationIdFrom('inv_codex_tui_completed_race'),
        reason: 'test cleanup',
      })
      await run.broker.dispose({
        invocationId: invocationIdFrom('inv_codex_tui_completed_race'),
      })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })

  test('keeps a guarded broker turn owned when a human steers inside it', async () => {
    const rpc = new FakeCodexRpc()
    let queuedInputId = ''
    rpc.onRequest = async (method, params) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_test' } }
      if (method === 'thread/queue/add') {
        queuedInputId = (params as { clientUserMessageId: string }).clientUserMessageId
        queueMicrotask(() => {
          rpc.emit('turn/started', {
            threadId: 'thread_test',
            turn: { id: 'turn_guarded_own', status: 'inProgress', items: [] },
          })
          rpc.emit('item/started', {
            threadId: 'thread_test',
            turnId: 'turn_guarded_own',
            item: {
              id: 'user_guarded_own',
              type: 'userMessage',
              clientId: queuedInputId,
              content: [{ type: 'text', text: 'broker input' }],
            },
          })
        })
        return { queuedSubmission: { id: 'queued_guarded_own' } }
      }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const run = await setupDriver(rpc, 'inv_codex_tui_guarded_own')
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      const queued = await run.broker.enqueue({
        invocationId: invocationIdFrom('inv_codex_tui_guarded_own'),
        origin,
        body: 'guarded broker input',
        turnPolicy: 'guarded',
      })
      await waitFor(
        () => run.events.some((event) => event.type === 'submission.executed'),
        'guarded own turn should be attributed'
      )
      expect(
        await run.broker.steer({
          invocationId: invocationIdFrom('inv_codex_tui_guarded_own'),
          origin,
          body: 'broker steer must be refused',
        })
      ).toMatchObject({ admission: 'rejected', reason: 'guarded' })
      rpc.emit('item/started', {
        threadId: 'thread_test',
        turnId: 'turn_guarded_own',
        item: {
          id: 'user_human_steer',
          type: 'userMessage',
          clientId: null,
          content: [{ type: 'text', text: 'human steer' }],
        },
      })
      rpc.emit('turn/completed', {
        threadId: 'thread_test',
        turn: { id: 'turn_guarded_own', status: 'completed', items: [] },
      })
      expect(
        run.events.find(
          (event) =>
            event.type === 'user.message' &&
            event.turnId === 'turn_guarded_own' &&
            event.payload.content === 'human steer'
        )?.inputId
      ).toBeUndefined()
      expect(
        run.events.find(
          (event) =>
            event.type === 'submission.executed' &&
            event.payload.submissionId === queued.submissionId
        )?.payload
      ).toMatchObject({ turnId: 'turn_guarded_own' })
      expect(run.events.filter((event) => event.type === 'submission.lost')).toHaveLength(0)
    } finally {
      await run.broker.stop({
        invocationId: invocationIdFrom('inv_codex_tui_guarded_own'),
        reason: 'test cleanup',
      })
      await run.broker.dispose({ invocationId: invocationIdFrom('inv_codex_tui_guarded_own') })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  })
})
