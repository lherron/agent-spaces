import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessInvocationSpec, InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import type { DriverContext } from '../../../src/drivers/driver'

type TmuxExecCall = { argv: string[]; env?: Record<string, string | undefined> | undefined }

type HookEnvelope = {
  invocationId?: string | undefined
  generation?: number | undefined
  callbackSocket?: string | undefined
  turnId?: string | undefined
  hookData?: unknown
}

type CodexCliTmuxDriverFactory = (options: {
  tmux: {
    socketPath: string
    tmuxBin?: string | undefined
    exec: (
      argv: string[],
      options?: { env?: Record<string, string | undefined> | undefined }
    ) => Promise<{ stdout: string; stderr: string }>
  }
  hooks: {
    listen: (handler: (envelope: HookEnvelope) => Promise<void>) => Promise<{
      socketPath: string
      close: () => Promise<void>
    }>
  }
  now: () => Date
}) => {
  kind: string
  start: (spec: HarnessInvocationSpec, ctx: DriverContext) => Promise<{ ok: true }>
  stop: (req: { reason?: string | undefined }) => Promise<{ accepted: boolean; state: string }>
  dispose: () => Promise<void>
}

const now = () => new Date('2026-05-27T17:31:00.000Z')
const invocationId = 'inv_codex_tmux_driver_1'

const codexTmuxSpec = (): HarnessInvocationSpec =>
  ({
    specVersion: 'harness-broker.invocation/v1',
    invocationId,
    harness: { frontend: 'codex', provider: 'openai', driver: 'codex-cli-tmux' },
    process: {
      command: '/opt/bin/codex',
      args: ['--', 'launch'],
      cwd: process.cwd(),
      lockedEnv: { OPENAI_API_KEY: 'test-key' },
      harnessTransport: { kind: 'pty' },
      limits: { startupTimeoutMs: 5000, turnTimeoutMs: 5000, stopGraceMs: 500 },
    },
    interaction: { mode: 'interactive', turnConcurrency: 'single', inputQueue: 'fifo' },
    driver: { kind: 'codex-cli-tmux', terminalHost: 'tmux' },
    correlation: { hostSessionId: 'host-session-codex-driver', runtimeId: 'runtime-codex-driver' },
  }) as HarnessInvocationSpec

const loadFactory = async (): Promise<CodexCliTmuxDriverFactory> => {
  const target = (await import('../../../src/drivers/codex-cli-tmux/driver')) as {
    createCodexCliTmuxDriver?: CodexCliTmuxDriverFactory | undefined
  }
  if (target.createCodexCliTmuxDriver === undefined) {
    throw new Error('createCodexCliTmuxDriver export is required')
  }
  return target.createCodexCliTmuxDriver
}

const recordingExec = (calls: TmuxExecCall[]) => {
  return async (
    argv: string[],
    options?: { env?: Record<string, string | undefined> | undefined }
  ): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ argv, env: options?.env })
    if (argv.includes('list-panes')) throw new Error("can't find session")
    if (argv.includes('new-session')) {
      return { stdout: '$1\t@1\t%7\thrc-host-sessio\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
}

const createCtx = (events: InvocationEventEnvelope[], socketPath: string): DriverContext =>
  ({
    invocationId,
    clientCapabilities: {},
    runtime: { tmux: { socketPath } },
    emit(type, payload, extra) {
      const event = {
        invocationId,
        seq: events.length + 1,
        time: now().toISOString(),
        type,
        payload,
        ...extra,
      } as InvocationEventEnvelope
      events.push(event)
      return event
    },
  }) as DriverContext

const jsonl = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`
const agentMessage = (message: string): string =>
  jsonl({ type: 'event_msg', payload: { type: 'agent_message', message } })
const taskComplete = (last: string): string =>
  jsonl({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: last } })

describe('codex-cli-tmux driver: hook-ordered transcript reading', () => {
  test('the transcript reader runs before hook normalization: terminal message precedes turn.completed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-driver-tx-'))
    const transcriptPath = join(root, 'rollout.jsonl')
    writeFileSync(transcriptPath, '')
    try {
      const createDriver = await loadFactory()
      const tmuxCalls: TmuxExecCall[] = []
      let hookHandler: ((envelope: HookEnvelope) => Promise<void>) | undefined
      const events: InvocationEventEnvelope[] = []
      const socketPath = '/tmp/harness-broker/codex-tmux.sock'
      const driver = createDriver({
        tmux: { socketPath, tmuxBin: '/opt/bin/tmux', exec: recordingExec(tmuxCalls) },
        hooks: {
          listen: async (handler) => {
            hookHandler = handler
            return {
              socketPath: '/tmp/harness-broker/codex-hooks.sock',
              close: async () => undefined,
            }
          },
        },
        now,
      })

      await driver.start(codexTmuxSpec(), createCtx(events, socketPath))
      expect(hookHandler).toBeDefined()

      const env = (hookData: unknown): HookEnvelope => ({
        invocationId,
        generation: 1,
        callbackSocket: '/tmp/harness-broker/codex-hooks.sock',
        turnId: 'turn_codex_driver_1',
        hookData,
      })

      await hookHandler?.(env({ hook_event_name: 'SessionStart', transcript_path: transcriptPath }))
      await hookHandler?.(
        env({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn_codex_driver_1', prompt: 'go' })
      )
      appendFileSync(transcriptPath, agentMessage('working on it'))
      await hookHandler?.(
        env({
          hook_event_name: 'PreToolUse',
          turn_id: 'turn_codex_driver_1',
          tool_use_id: 'call_1',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
        })
      )
      await hookHandler?.(
        env({
          hook_event_name: 'PostToolUse',
          turn_id: 'turn_codex_driver_1',
          tool_use_id: 'call_1',
          tool_name: 'Bash',
          tool_response: { stdout: 'ok' },
        })
      )
      appendFileSync(transcriptPath, agentMessage('here is the answer'))
      appendFileSync(transcriptPath, taskComplete('here is the answer'))
      await hookHandler?.(
        env({
          hook_event_name: 'Stop',
          turn_id: 'turn_codex_driver_1',
          session_id: 'sess_1',
          last_assistant_message: 'here is the answer',
        })
      )

      const types = events.map((event) => event.type)
      const completed = events.filter((event) => event.type === 'assistant.message.completed')
      const finalCompleted = completed.filter((event) => event.payload['final'] === true)
      const interimCompleted = completed.filter((event) => event.payload['final'] === false)

      // Interim narration and exactly one terminal message.
      expect(interimCompleted.length).toBeGreaterThanOrEqual(1)
      expect(finalCompleted).toHaveLength(1)

      // The reader runs BEFORE normalization: the terminal final:true message is
      // emitted before this turn's turn.completed.
      const finalIdx = types.indexOf(
        'assistant.message.completed',
        types.indexOf('tool.call.completed')
      )
      const turnCompletedIdx = types.indexOf('turn.completed')
      expect(finalCompleted[0]).toMatchObject({
        turnId: 'turn_codex_driver_1',
        payload: { content: [{ type: 'text', text: 'here is the answer' }], final: true },
      })
      const finalEventIdx = events.indexOf(finalCompleted[0] as InvocationEventEnvelope)
      expect(finalEventIdx).toBeLessThan(turnCompletedIdx)
      expect(finalIdx).toBeGreaterThanOrEqual(0)

      // No intermediate appears AFTER turn.completed.
      const intermediateAfterTerminal = interimCompleted.some(
        (event) => events.indexOf(event) > turnCompletedIdx
      )
      expect(intermediateAfterTerminal).toBe(false)

      await driver.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)
})
