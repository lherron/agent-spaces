import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationId,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../../../src/broker'
import { CodexRpcError } from '../../../src/drivers/codex-app-server/rpc-client'
import { createCodexTranscriptModel } from '../../../src/drivers/codex-app-server/transcript'
import { createCodexDesktopDriver } from '../../../src/drivers/codex-desktop/driver'
import type { CodexDesktopQueueHelper } from '../../../src/drivers/codex-desktop/driver'
import { createEventLedger } from '../../../src/event-ledger'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function tempDir(): string {
  const path = join(tmpdir(), `codex-desktop-${crypto.randomUUID()}`)
  mkdirSync(path, { recursive: true })
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}

function row(payload: Record<string, unknown>, ordinal: number): string {
  return `${JSON.stringify({ timestamp: new Date(ordinal * 1000).toISOString(), ordinal, type: 'event_msg', payload })}\n`
}

function itemRow(
  threadId: string,
  turnId: string,
  item: Record<string, unknown>,
  ordinal: number
): string {
  return row({ type: 'item_completed', thread_id: threadId, turn_id: turnId, item }, ordinal)
}

function responseItemRow(
  payload: Record<string, unknown>,
  ordinal: number,
  timestamp = new Date(ordinal * 1000).toISOString()
): string {
  return `${JSON.stringify({
    timestamp,
    ordinal,
    type: 'response_item',
    payload,
  })}\n`
}

function customToolStartRow(
  turnId: string,
  callId: string,
  input: string,
  ordinal: number,
  timestamp = new Date(ordinal * 1000).toISOString()
): string {
  return responseItemRow(
    {
      type: 'custom_tool_call',
      id: `ctc-${callId}`,
      status: 'completed',
      call_id: callId,
      name: 'exec',
      input,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
    ordinal,
    timestamp
  )
}

function customToolOutputRow(
  turnId: string,
  callId: string,
  output: unknown,
  ordinal: number,
  timestamp = new Date(ordinal * 1000).toISOString()
): string {
  return responseItemRow(
    {
      type: 'custom_tool_call_output',
      id: `ctco-${callId}`,
      call_id: callId,
      output,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
    ordinal,
    timestamp
  )
}

function itemRowAt(
  threadId: string,
  turnId: string,
  item: Record<string, unknown>,
  ordinal: number,
  timestamp: string
): string {
  return `${JSON.stringify({
    timestamp,
    ordinal,
    type: 'event_msg',
    payload: { type: 'item_completed', thread_id: threadId, turn_id: turnId, item },
  })}\n`
}

function toolTurnRows(threadId: string, turnId: string, ordinal: number): string {
  return (
    row({ type: 'task_started', turn_id: turnId }, ordinal) +
    customToolStartRow(
      turnId,
      `call-${turnId}`,
      `text(await tools.exec_command({cmd:"echo ${turnId}"}));\n`,
      ordinal + 1
    ) +
    itemRow(
      threadId,
      turnId,
      {
        type: 'CommandExecution',
        id: `exec-${turnId}`,
        command: ['echo', turnId],
        status: 'completed',
        stdout: `${turnId}\n`,
        stderr: '',
        exit_code: 0,
      },
      ordinal + 2
    ) +
    customToolOutputRow(
      turnId,
      `call-${turnId}`,
      [{ type: 'input_text', text: `${turnId}\n` }],
      ordinal + 3
    ) +
    row({ type: 'task_complete', turn_id: turnId }, ordinal + 4)
  )
}

function spec(
  path: string,
  invocationId: string,
  threadId = 'thread-desktop'
): HarnessInvocationSpec {
  return {
    specVersion: 'harness-broker.invocation/v1',
    invocationId: invocationId as InvocationId,
    harness: { frontend: 'codex-desktop', provider: 'openai', driver: 'codex-desktop' },
    process: {
      command: 'external-codex-desktop',
      args: [],
      cwd: dirname(path),
      lockedEnv: {},
      harnessTransport: { kind: 'pipes' },
    },
    interaction: { mode: 'service', turnConcurrency: 'single', inputQueue: 'fifo' },
    continuation: { provider: 'openai', key: threadId, kind: 'thread' },
    driver: {
      kind: 'codex-desktop',
      bundleExecutable: '/Applications/ChatGPT.app/Contents/Resources/codex',
      codexHome: '/tmp/codex-home',
      sqliteHome: '/tmp/codex-home',
      threadId,
      rolloutPath: path,
      adoptionWatermark: { byteOffset: 0 },
    },
  }
}

function withDriver(
  base: HarnessInvocationSpec,
  extra: Record<string, unknown>
): HarnessInvocationSpec {
  return { ...base, driver: { ...base.driver, ...extra } }
}

function desktopProjectionIdentityForTest(event: {
  type?: unknown
  itemId?: unknown
  turnId?: unknown
  provenance?: { rawSha256?: unknown; nativeId?: unknown }
}): string | undefined {
  const rawSha256 = event.provenance?.rawSha256
  if (typeof rawSha256 !== 'string' || typeof event.type !== 'string') return undefined
  const sibling =
    (typeof event.itemId === 'string' ? event.itemId : undefined) ??
    (typeof event.provenance?.nativeId === 'string' ? event.provenance.nativeId : undefined) ??
    (typeof event.turnId === 'string' ? event.turnId : undefined) ??
    ''
  return `${rawSha256}|${event.type}|${sibling}`
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for observer')
    await Bun.sleep(10)
  }
}

type NativeQueueRow = { id: string; clientUserMessageId: string }

function queueHarness(
  options: {
    pages?: (cursor?: string) => { data: NativeQueueRow[]; nextCursor?: string }
    onAdd?: (clientUserMessageId: string) => unknown
  } = {}
) {
  const queue: NativeQueueRow[] = []
  const adds: string[] = []
  const deletes: string[] = []
  const openQueueHelper = async (): Promise<CodexDesktopQueueHelper> => ({
    async list(_threadId, cursor) {
      return options.pages?.(cursor) ?? { data: [...queue], nextCursor: null }
    },
    async add(_threadId, _input, clientUserMessageId) {
      adds.push(clientUserMessageId)
      const result = options.onAdd?.(clientUserMessageId)
      if (result instanceof Error) throw result
      if (result !== undefined) return result
      const row = { id: `native-${clientUserMessageId}`, clientUserMessageId }
      queue.push(row)
      return { queuedSubmission: row }
    },
    async delete(_threadId, queuedSubmissionId) {
      deletes.push(queuedSubmissionId)
      const index = queue.findIndex((row) => row.id === queuedSubmissionId)
      if (index >= 0) queue.splice(index, 1)
      return { deleted: index >= 0 }
    },
    close() {},
  })
  return { queue, adds, deletes, openQueueHelper }
}

function ownTurnRows(threadId: string, turnId: string, inputId: string, ordinal = 10): string {
  return [
    row({ type: 'task_started', turn_id: turnId }, ordinal),
    itemRow(
      threadId,
      turnId,
      {
        type: 'UserMessage',
        id: `user-${turnId}`,
        client_id: inputId,
        content: [{ type: 'text', text: 'broker delivery' }],
      },
      ordinal + 1
    ),
    row({ type: 'task_complete', turn_id: turnId }, ordinal + 2),
  ].join('')
}

describe('codex-desktop observation driver', () => {
  test('normalizes native turn, attribution, assistant phases, tools, usage and terminal once', async () => {
    const dir = tempDir()
    const path = join(dir, 'rollout.jsonl')
    const threadId = 'thread-desktop'
    const turnId = 'turn-1'
    writeFileSync(
      path,
      [
        row({ type: 'task_started', turn_id: turnId }, 1),
        itemRow(
          threadId,
          turnId,
          {
            type: 'UserMessage',
            id: 'user-1',
            client_id: 'human-client',
            content: [{ type: 'text', text: 'hello' }],
          },
          2
        ),
        itemRow(
          threadId,
          turnId,
          {
            type: 'AgentMessage',
            id: 'assistant-commentary',
            phase: 'commentary',
            content: [{ type: 'text', text: 'working' }],
          },
          3
        ),
        responseItemRow(
          {
            type: 'custom_tool_call',
            id: 'ctc-native-1',
            status: 'completed',
            call_id: 'call-native-1',
            name: 'exec',
            input: 'text(await tools.exec_command({cmd:"echo ok"}));\n',
            internal_chat_message_metadata_passthrough: { turn_id: turnId },
          },
          4
        ),
        itemRow(
          threadId,
          turnId,
          {
            type: 'CommandExecution',
            id: 'tool-1',
            command: ['echo', 'ok'],
            status: 'completed',
            stdout: 'ok\n',
            stderr: '',
            exit_code: 0,
          },
          5
        ),
        customToolOutputRow(
          turnId,
          'call-native-1',
          [{ type: 'input_text', text: 'Script completed\n' }],
          6
        ),
        itemRow(
          threadId,
          turnId,
          {
            type: 'AgentMessage',
            id: 'assistant-final',
            phase: 'final_answer',
            content: [{ type: 'text', text: 'done' }],
          },
          7
        ),
        `${JSON.stringify({ type: 'response_item', payload: { type: 'agent_message', id: 'assistant-final' } })}\n`,
        row({ type: 'token_count', info: { last_token_usage: { total_tokens: 12 } } }, 8),
        row({ type: 'task_complete', turn_id: turnId, last_agent_message: 'done' }, 9),
      ].join('')
    )

    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexDesktopDriver({ watchFile: false, pollIntervalMs: 10 })],
      onEvent: (event) => events.push(event),
      captureDir: dir,
    })
    await broker.start({ spec: spec(path, 'inv-desktop-basic') })
    await waitFor(() => events.some((event) => event.type === 'turn.completed'))

    const observed = events.filter((event) => event.driver?.kind === 'codex-desktop')
    expect(observed.filter((event) => event.type === 'turn.started')).toHaveLength(1)
    expect(observed.find((event) => event.type === 'turn.attributed')?.payload).toMatchObject({
      ownership: 'foreign',
      origin: 'human',
    })
    expect(observed.filter((event) => event.type === 'assistant.message.completed')).toHaveLength(2)
    expect(
      observed
        .filter((event) => event.type === 'assistant.message.completed')
        .map((event) => event.payload.final)
    ).toEqual([false, true])
    const toolStarted = observed.filter((event) => event.type === 'tool.call.started')
    const toolCompleted = observed.filter((event) => event.type === 'tool.call.completed')
    expect(toolStarted).toHaveLength(1)
    expect(toolCompleted).toHaveLength(2)
    expect(toolStarted[0]).toMatchObject({
      turnId,
      itemId: 'call-native-1',
      payload: {
        toolCallId: 'call-native-1',
        name: 'exec/orchestration',
        input: { codeMode: 'text(await tools.exec_command({cmd:"echo ok"}));\n' },
      },
      provenance: {
        sourceKind: 'provider-jsonl',
        nativeType: 'response_item:custom_tool_call',
        nativeId: 'call-native-1',
      },
    })
    expect(toolCompleted.find((event) => event.payload.name === 'command')).toMatchObject({
      turnId,
      itemId: 'tool-1',
      payload: {
        toolCallId: 'tool-1',
        name: 'command',
        result: { stdout: 'ok\n', stderr: '', exitCode: 0 },
      },
      provenance: {
        sourceKind: 'provider-jsonl',
        nativeType: 'event_msg:item_completed:CommandExecution',
        nativeId: 'tool-1',
      },
    })
    expect(
      toolCompleted.find((event) => event.payload.name === 'exec/orchestration')
    ).toMatchObject({
      turnId,
      itemId: 'call-native-1',
      payload: {
        toolCallId: 'call-native-1',
        name: 'exec/orchestration',
        result: {
          output: '[exec/orchestration output]\nScript completed\n',
          codeModeOutput: [{ type: 'input_text', text: 'Script completed\n' }],
        },
      },
      provenance: {
        sourceKind: 'provider-jsonl',
        nativeType: 'response_item:custom_tool_call_output',
        nativeId: 'call-native-1',
      },
    })
    expect(toolStarted[0]?.time).toBe('1970-01-01T00:00:04.000Z')
    expect(toolCompleted.find((event) => event.payload.name === 'command')?.time).toBe(
      '1970-01-01T00:00:05.000Z'
    )
    expect(toolCompleted.find((event) => event.payload.name === 'exec/orchestration')?.time).toBe(
      '1970-01-01T00:00:06.000Z'
    )
    expect(observed.filter((event) => event.type === 'assistant.message.started')).toHaveLength(0)
    expect(observed.filter((event) => event.type === 'usage.updated')).toHaveLength(1)
    expect(observed.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
    expect(observed.every((event) => event.provenance.rawRecordId !== undefined)).toBe(true)
  })

  test('stays ready-degraded until a delayed rollout materializes and preserves partial lines', async () => {
    const dir = tempDir()
    const path = join(dir, 'delayed.jsonl')
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexDesktopDriver({ watchFile: false, pollIntervalMs: 10 })],
      onEvent: (event) => events.push(event),
      captureDir: dir,
    })
    await broker.start({ spec: spec(path, 'inv-desktop-delayed') })
    expect(
      (
        await broker.status({
          invocationId: 'inv-desktop-delayed' as InvocationId,
          probeLiveness: true,
        })
      ).liveness?.driver
    ).toMatchObject({
      state: 'degraded',
    })

    const started = row({ type: 'task_started', turn_id: 'turn-delayed' }, 1)
    writeFileSync(path, started.slice(0, -1))
    await Bun.sleep(40)
    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(0)
    appendFileSync(path, '\n')
    await waitFor(() => events.some((event) => event.type === 'turn.started'))
    expect(
      (
        await broker.status({
          invocationId: 'inv-desktop-delayed' as InvocationId,
          probeLiveness: true,
        })
      ).liveness?.driver
    ).toEqual({
      state: 'healthy',
    })
  })

  test('does not fabricate a start when native call identity or turn identity is incomplete', async () => {
    const dir = tempDir()
    const path = join(dir, 'unreliable-start.jsonl')
    const threadId = 'thread-desktop'
    const turnId = 'turn-unreliable'
    writeFileSync(
      path,
      row({ type: 'task_started', turn_id: turnId }, 1) +
        responseItemRow(
          {
            type: 'custom_tool_call',
            id: 'ctc-without-turn',
            call_id: 'call-without-turn',
            name: 'exec',
            input: 'text(await tools.exec_command({cmd:"pwd"}));\n',
          },
          2
        ) +
        itemRow(
          threadId,
          turnId,
          {
            type: 'CommandExecution',
            id: 'exec-unpaired',
            command: ['pwd'],
            status: 'completed',
            stdout: '/tmp\n',
            stderr: '',
            exit_code: 0,
          },
          3
        ) +
        row({ type: 'task_complete', turn_id: turnId }, 4)
    )
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexDesktopDriver({ watchFile: false, pollIntervalMs: 10 })],
      onEvent: (event) => events.push(event),
      captureDir: dir,
    })
    await broker.start({ spec: spec(path, 'inv-desktop-unreliable') })
    await waitFor(() => events.some((event) => event.type === 'turn.completed'))

    expect(events.filter((event) => event.type === 'tool.call.started')).toHaveLength(0)
    expect(events.find((event) => event.type === 'tool.call.completed')).toMatchObject({
      itemId: 'exec-unpaired',
      payload: { toolCallId: 'exec-unpaired' },
    })
    expect(events.filter((event) => event.type === 'assistant.message.started')).toHaveLength(0)
  })

  test('pairs orchestration output by call_id across zero, multiple, and interleaved child commands', async () => {
    const dir = tempDir()
    const path = join(dir, 'orchestration-children.jsonl')
    const threadId = 'thread-desktop'
    const turnId = 'turn-orchestration'
    writeFileSync(
      path,
      [
        row({ type: 'task_started', turn_id: turnId }, 1),
        customToolStartRow(turnId, 'call-zero', 'text("no child");\n', 2),
        customToolStartRow(turnId, 'call-one', 'text(await tools.exec_command({cmd:"one"}));\n', 3),
        customToolOutputRow(turnId, 'call-zero', [{ type: 'input_text', text: 'zero' }], 4),
        customToolStartRow(
          turnId,
          'call-parallel',
          'const [a,b] = await Promise.all([tools.exec_command({cmd:"a"}), tools.exec_command({cmd:"b"})]); text(a); text(b);\n',
          5
        ),
        itemRow(
          threadId,
          turnId,
          {
            type: 'CommandExecution',
            id: 'exec-parallel-b',
            command: ['b'],
            status: 'completed',
            stdout: 'b\n',
            stderr: '',
            exit_code: 0,
          },
          6
        ),
        itemRow(
          threadId,
          turnId,
          {
            type: 'CommandExecution',
            id: 'exec-one',
            command: ['one'],
            status: 'completed',
            stdout: 'one\n',
            stderr: '',
            exit_code: 0,
          },
          7
        ),
        itemRow(
          threadId,
          turnId,
          {
            type: 'CommandExecution',
            id: 'exec-parallel-a',
            command: ['a'],
            status: 'completed',
            stdout: 'a\n',
            stderr: '',
            exit_code: 0,
          },
          8
        ),
        customToolOutputRow(turnId, 'call-one', [{ type: 'input_text', text: 'one' }], 9),
        customToolOutputRow(
          turnId,
          'call-parallel',
          [{ type: 'input_text', text: 'a then b' }],
          10
        ),
        row({ type: 'task_complete', turn_id: turnId }, 11),
      ].join('')
    )
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexDesktopDriver({ watchFile: false, pollIntervalMs: 10 })],
      onEvent: (event) => events.push(event),
      captureDir: dir,
    })
    await broker.start({ spec: spec(path, 'inv-desktop-orchestration') })
    await waitFor(() => events.some((event) => event.type === 'turn.completed'))

    const parents = events.filter(
      (event) => event.type === 'tool.call.completed' && event.payload.name === 'exec/orchestration'
    )
    const children = events.filter(
      (event) => event.type === 'tool.call.completed' && event.payload.name === 'command'
    )
    expect(parents.map((event) => event.payload.toolCallId)).toEqual([
      'call-zero',
      'call-one',
      'call-parallel',
    ])
    expect(children.map((event) => event.payload.toolCallId)).toEqual([
      'exec-parallel-b',
      'exec-one',
      'exec-parallel-a',
    ])
    expect(children.map((event) => event.itemId)).toEqual([
      'exec-parallel-b',
      'exec-one',
      'exec-parallel-a',
    ])
  })

  test('reproduces and repairs the frozen quasar three-start identity and timing gap', async () => {
    const dir = tempDir()
    const path = join(dir, 'quasar-native-starts.jsonl')
    const threadId = '01a086af-b567-7ea3-9812-de81aab2ec42'
    const specimens = [
      {
        turnId: '01a086af-db07-7e72-94c1-a0ce9557496f',
        callId: 'call_8hqG3YgCD59dMKH6SHb8GMsF',
        responseId: 'ctc_0e97c5bf0985e03e016aa174b6c22487d1a8dc0afb91d4c778',
        outputId: 'ctco_01a086af-ebba-76a1-8c88-99f416bee0e5',
        completionId: 'exec-4517c5b9-be5d-440a-808a-97d8e79cfa7b',
        input: 'text(await tools.exec_command({cmd:"wrkq ls",max_output_tokens:6000}));\n',
        start: '2026-09-09T15:01:11.057Z',
        childComplete: '2026-09-09T15:01:11.223Z',
        output: '2026-09-09T15:01:11.227Z',
      },
      {
        turnId: '01a086b0-2bf7-7f01-bbb1-228a42d84b9d',
        callId: 'call_uiQQd0C6KrurU94n7vD7UpSn',
        responseId: 'ctc_0e97c5bf0985e03e016aa174ca72ac87d1926b6a9cebe90402',
        outputId: 'ctco_01a086b0-3a8e-7392-8201-b5be3cc1e773',
        completionId: 'exec-5fea113d-b18e-489b-9992-0aa1dec854b1',
        input: 'text(await tools.exec_command({cmd:"asp self inspect",max_output_tokens:2000}));\n',
        start: '2026-09-09T15:01:30.770Z',
        childComplete: '2026-09-09T15:01:31.404Z',
        output: '2026-09-09T15:01:31.406Z',
      },
      {
        turnId: '01a086b0-a649-77e3-930a-adf923d1ebeb',
        callId: 'call_o8viX5NqfTUyBNPYYKBRUOMf',
        responseId: 'ctc_0e97c5bf0985e03e016aa174ec2fb487d18d799cc7926c04e6',
        outputId: 'ctco_01a086b0-bf3d-7162-834a-6de26573ce4f',
        completionId: 'exec-a0d9991d-b2cf-4c12-9df8-52c94ee233ad',
        input:
          'text(await tools.exec_command({cmd:"wrkc say EN-08655 --to astra@agent-spaces:primary"}));\n',
        start: '2026-09-09T15:02:05.238Z',
        childComplete: '2026-09-09T15:02:05.371Z',
        output: '2026-09-09T15:02:05.373Z',
      },
    ] as const
    writeFileSync(
      path,
      specimens
        .flatMap((sample, index) => {
          const ordinal = index * 4 + 1
          return [
            row({ type: 'task_started', turn_id: sample.turnId }, ordinal),
            responseItemRow(
              {
                type: 'custom_tool_call',
                id: sample.responseId,
                status: 'completed',
                call_id: sample.callId,
                name: 'exec',
                input: sample.input,
                internal_chat_message_metadata_passthrough: { turn_id: sample.turnId },
              },
              ordinal + 1,
              sample.start
            ),
            itemRowAt(
              threadId,
              sample.turnId,
              {
                type: 'CommandExecution',
                id: sample.completionId,
                command: ['/bin/zsh', '-lc', sample.input],
                status: 'completed',
                stdout: `result ${index + 1}\n`,
                stderr: '',
                aggregated_output: `result ${index + 1}\n`,
                exit_code: 0,
              },
              ordinal + 2,
              sample.childComplete
            ),
            responseItemRow(
              {
                type: 'custom_tool_call_output',
                id: sample.outputId,
                call_id: sample.callId,
                output: [{ type: 'input_text', text: `orchestration ${index + 1}\n` }],
                internal_chat_message_metadata_passthrough: { turn_id: sample.turnId },
              },
              ordinal + 3,
              sample.output
            ),
            row({ type: 'task_complete', turn_id: sample.turnId }, ordinal + 4),
          ]
        })
        .join('')
    )
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexDesktopDriver({ watchFile: false, pollIntervalMs: 10 })],
      onEvent: (event) => events.push(event),
      captureDir: dir,
    })
    await broker.start({ spec: spec(path, 'inv-desktop-quasar-frozen', threadId) })
    await waitFor(
      () => events.filter((event) => event.type === 'turn.completed').length === specimens.length
    )

    const starts = events.filter((event) => event.type === 'tool.call.started')
    const parentCompletions = events.filter(
      (event) => event.type === 'tool.call.completed' && event.payload.name === 'exec/orchestration'
    )
    const childCompletions = events.filter(
      (event) => event.type === 'tool.call.completed' && event.payload.name === 'command'
    )
    expect(starts.map((event) => event.payload.toolCallId)).toEqual(
      specimens.map((sample) => sample.callId)
    )
    expect(parentCompletions.map((event) => event.payload.toolCallId)).toEqual(
      specimens.map((sample) => sample.callId)
    )
    expect(starts.map((event) => event.time)).toEqual(specimens.map((sample) => sample.start))
    expect(parentCompletions.map((event) => event.time)).toEqual(
      specimens.map((sample) => sample.output)
    )
    expect(parentCompletions.map((event) => event.payload.result)).toEqual([
      {
        output: '[exec/orchestration output]\norchestration 1\n',
        codeModeOutput: [{ type: 'input_text', text: 'orchestration 1\n' }],
      },
      {
        output: '[exec/orchestration output]\norchestration 2\n',
        codeModeOutput: [{ type: 'input_text', text: 'orchestration 2\n' }],
      },
      {
        output: '[exec/orchestration output]\norchestration 3\n',
        codeModeOutput: [{ type: 'input_text', text: 'orchestration 3\n' }],
      },
    ])
    expect(childCompletions.map((event) => event.payload.toolCallId)).toEqual(
      specimens.map((sample) => sample.completionId)
    )
    expect(childCompletions.map((event) => event.time)).toEqual(
      specimens.map((sample) => sample.childComplete)
    )
    expect(childCompletions.map((event) => event.payload.result)).toEqual([
      {
        status: 'completed',
        stdout: 'result 1\n',
        stderr: '',
        output: 'result 1\n',
        exitCode: 0,
      },
      {
        status: 'completed',
        stdout: 'result 2\n',
        stderr: '',
        output: 'result 2\n',
        exitCode: 0,
      },
      {
        status: 'completed',
        stdout: 'result 3\n',
        stderr: '',
        output: 'result 3\n',
        exitCode: 0,
      },
    ])
    const frozenOldCompletion = {
      type: 'tool.call.completed',
      itemId: 'exec-4517c5b9-be5d-440a-808a-97d8e79cfa7b',
      provenance: {
        nativeId: 'exec-4517c5b9-be5d-440a-808a-97d8e79cfa7b',
        rawSha256: 'e4b81dbcdd1ea3c6db64f3087042e6446681c4fdec12f5ed629d0450032f13bd',
      },
    }
    const replayedSameNativeRecord = {
      ...childCompletions[0],
      provenance: {
        ...childCompletions[0]?.provenance,
        rawSha256: frozenOldCompletion.provenance.rawSha256,
      },
    }
    expect(childCompletions[0]?.itemId).toBe(frozenOldCompletion.itemId)
    expect(childCompletions[0]?.payload.toolCallId).toBe(frozenOldCompletion.itemId)
    expect(desktopProjectionIdentityForTest(replayedSameNativeRecord)).toBe(
      desktopProjectionIdentityForTest(frozenOldCompletion)
    )

    const rendered: string[] = []
    const transcript = createCodexTranscriptModel({
      invocationId: 'inv-desktop-quasar-frozen',
      emit: (line) => rendered.push(line),
      color: false,
    })
    const firstRenderedPair = events.filter(
      (event) =>
        (event.type === 'tool.call.started' || event.type === 'tool.call.completed') &&
        (event.payload.toolCallId === specimens[0]?.callId ||
          event.payload.toolCallId === specimens[0]?.completionId)
    )
    for (const event of firstRenderedPair) transcript.apply(event)
    expect(rendered.join('\n')).toContain('exec/orchestration')
    expect(rendered.join('\n')).toContain('tools.exec_command')
    expect(rendered.join('\n')).toContain('[exec/orchestration output]')
    expect(rendered.join('\n')).toContain('orchestration 1')
    expect(rendered.join('\n')).toContain('result 1')
    expect(events.filter((event) => event.type === 'assistant.message.started')).toHaveLength(0)
  })

  test('replacement and observer restart retain native dedupe and append only new history', async () => {
    const dir = tempDir()
    const path = join(dir, 'restart.jsonl')
    const turn1 = toolTurnRows('thread-desktop', 'turn-1', 1)
    writeFileSync(path, turn1)
    const ledgerPath = join(dir, 'events.ndjson')
    const firstLedger = createEventLedger({ path: ledgerPath })
    const firstEvents: InvocationEventEnvelope[] = []
    const first = createBroker({
      drivers: [createCodexDesktopDriver({ watchFile: false, pollIntervalMs: 10 })],
      onEvent: (event) => firstEvents.push(event),
      eventLedger: firstLedger,
      captureDir: dir,
    })
    await first.start({ spec: spec(path, 'inv-desktop-restart') })
    await waitFor(() => firstEvents.some((event) => event.type === 'turn.completed'))
    await first.stop({
      invocationId: 'inv-desktop-restart' as InvocationId,
      reason: 'observer restart',
    })
    firstLedger.close()

    // Same native history plus a new turn: replay must not remint turn-1.
    const turn2 = toolTurnRows('thread-desktop', 'turn-2', 5)
    writeFileSync(path, turn1 + turn2)
    const secondLedger = createEventLedger({ path: ledgerPath })
    const secondEvents: InvocationEventEnvelope[] = []
    const second = createBroker({
      drivers: [createCodexDesktopDriver({ watchFile: false, pollIntervalMs: 10 })],
      onEvent: (event) => secondEvents.push(event),
      eventLedger: secondLedger,
      captureDir: dir,
    })
    await second.start({ spec: spec(path, 'inv-desktop-restart') })
    await waitFor(() =>
      secondEvents.some(
        (event) => event.type === 'turn.completed' && event.turnId === ('turn-2' as never)
      )
    )
    expect(
      secondEvents.filter(
        (event) => event.type === 'turn.started' && event.turnId === ('turn-1' as never)
      )
    ).toHaveLength(0)
    expect(
      secondEvents.filter(
        (event) => event.type === 'turn.started' && event.turnId === ('turn-2' as never)
      )
    ).toHaveLength(1)
    expect(
      secondEvents.filter(
        (event) => event.type === 'tool.call.started' && event.turnId === ('turn-1' as never)
      )
    ).toHaveLength(0)
    expect(
      secondEvents.filter(
        (event) => event.type === 'tool.call.completed' && event.turnId === ('turn-1' as never)
      )
    ).toHaveLength(0)
    expect(
      secondEvents.filter(
        (event) => event.type === 'tool.call.started' && event.turnId === ('turn-2' as never)
      )
    ).toHaveLength(1)
    expect(
      secondEvents.filter(
        (event) => event.type === 'tool.call.completed' && event.turnId === ('turn-2' as never)
      )
    ).toHaveLength(2)
    secondLedger.close()
  })

  test('fresh recovery replays all records so HRC can dedupe committed projection identities', async () => {
    const dir = tempDir()
    const path = join(dir, 'fresh-recovery.jsonl')
    const threadId = 'thread-desktop'
    const prefix = row({ type: 'task_started', turn_id: 'turn-crossing' }, 1)
    const boundary = itemRow(
      threadId,
      'turn-crossing',
      {
        type: 'UserMessage',
        id: 'user-boundary',
        client_id: 'human-boundary',
        content: [{ type: 'text', text: 'boundary input' }],
      },
      2
    )
    const tail =
      itemRow(
        threadId,
        'turn-crossing',
        {
          type: 'AgentMessage',
          id: 'assistant-after-boundary',
          phase: 'final_answer',
          content: [{ type: 'text', text: 'recovered' }],
        },
        3
      ) + row({ type: 'task_complete', turn_id: 'turn-crossing' }, 4)
    const trailingPartial = '{"timestamp"'
    writeFileSync(path, prefix + boundary + tail + trailingPartial)
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexDesktopDriver({ watchFile: false, pollIntervalMs: 10 })],
      onEvent: (event) => events.push(event),
      captureDir: join(dir, 'replacement-capture'),
    })
    await broker.start({
      spec: withDriver(spec(path, 'inv-desktop-fresh-recovery'), {
        recoveryBoundary: {
          sourceKind: 'provider-jsonl',
          sourceEpoch: 'prior-capture-epoch',
          furthestCommittedRecord: {
            rawRecordId: 'prior-raw-boundary',
            byteOffset: Buffer.byteLength(prefix),
            line: 2,
            rawSha256: 'prior-capture-hash',
            nativeType: 'event_msg:item_completed',
          },
          committedProjections: [
            { seq: 8, type: 'user.message', turnId: 'turn-crossing', itemId: 'user-boundary' },
          ],
          appliedThroughSeq: 8,
          empty: false,
        },
      }),
    })
    await waitFor(() => events.some((event) => event.type === 'turn.completed'))

    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'user.message')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn.attributed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'assistant.message.completed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
    expect(
      events.find(
        (event) =>
          event.type === 'driver.notice' &&
          event.payload.code === 'CODEX_DESKTOP_RECOVERY_BOUNDARY_APPLIED'
      )?.payload.data
    ).toMatchObject({
      replayByteOffset: 0,
      replaySnapshotBytes: Buffer.byteLength(prefix + boundary + tail + trailingPartial),
      replaySnapshotCompleteRecords: 4,
      replaySnapshotTrailingPartialBytes: Buffer.byteLength(trailingPartial),
      furthestCommittedByteOffset: Buffer.byteLength(prefix),
      committedProjectionCount: 1,
    })
  })

  test('never treats the legacy producer EOF watermark as a committed recovery boundary', async () => {
    const dir = tempDir()
    const path = join(dir, 'unsafe-producer-eof.jsonl')
    const history =
      row({ type: 'task_started', turn_id: 'turn-below-producer-eof' }, 1) +
      row({ type: 'task_complete', turn_id: 'turn-below-producer-eof' }, 2)
    writeFileSync(path, history)
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexDesktopDriver({ watchFile: false, pollIntervalMs: 10 })],
      onEvent: (event) => events.push(event),
      captureDir: dir,
    })
    await broker.start({
      spec: withDriver(spec(path, 'inv-desktop-unsafe-eof'), {
        adoptionWatermark: { byteOffset: Buffer.byteLength(history) },
      }),
    })
    await waitFor(() => events.some((event) => event.type === 'turn.completed'))
    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
  })

  test('fresh recovery republishes delayed output carrying an earlier boundary provenance', async () => {
    const dir = tempDir()
    const path = join(dir, 'delayed-projection-recovery.jsonl')
    const prefix = row({ type: 'task_started', turn_id: 'turn-delayed-projection' }, 1)
    const held = itemRow(
      'thread-desktop',
      'turn-delayed-projection',
      {
        type: 'AgentMessage',
        id: 'assistant-delayed-projection',
        phase: 'final_answer',
        content: [{ type: 'text', text: 'delayed projection' }],
      },
      2
    )
    const laterApplied = row({ type: 'token_count', info: { total_tokens: 42 } }, 3)
    const terminal = row({ type: 'task_complete', turn_id: 'turn-delayed-projection' }, 4)
    writeFileSync(path, prefix + held + laterApplied + terminal)
    const events: InvocationEventEnvelope[] = []
    const boundaryOffset = Buffer.byteLength(prefix)
    const broker = createBroker({
      drivers: [createCodexDesktopDriver({ watchFile: false, pollIntervalMs: 10 })],
      onEvent: (event) => events.push(event),
      captureDir: join(dir, 'replacement-capture'),
    })
    await broker.start({
      spec: withDriver(spec(path, 'inv-desktop-delayed-projection'), {
        recoveryBoundary: {
          sourceKind: 'provider-jsonl',
          furthestCommittedRecord: {
            rawRecordId: 'prior-raw-later-applied',
            byteOffset: Buffer.byteLength(prefix + held),
            rawSha256: 'prior-capture-hash',
          },
          earliestPendingRecord: {
            rawRecordId: 'prior-raw-pending-after-held',
            byteOffset: Buffer.byteLength(prefix + held + laterApplied),
          },
          committedProjections: [{ seq: 12, type: 'usage.updated', rawRecordId: 'raw-later' }],
          appliedThroughSeq: 12,
          empty: false,
        },
      }),
    })
    await waitFor(() => events.some((event) => event.type === 'turn.completed'))

    const assistant = events.find((event) => event.type === 'assistant.message.completed')
    expect(assistant?.payload).toMatchObject({ final: true })
    expect(assistant?.provenance.sourceCursor).toMatchObject({ byteOffset: boundaryOffset })
    expect(events.filter((event) => event.type === 'usage.updated')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
    expect(
      events.find(
        (event) =>
          event.type === 'driver.notice' &&
          event.payload.code === 'CODEX_DESKTOP_RECOVERY_BOUNDARY_APPLIED'
      )?.payload.data
    ).toMatchObject({ replayByteOffset: 0, committedProjectionCount: 1 })
  })

  test('detects a same-path replacement and observes the replacement epoch once', async () => {
    const dir = tempDir()
    const path = join(dir, 'replacement.jsonl')
    const original = [
      row({ type: 'task_started', turn_id: 'turn-original' }, 1),
      row({ type: 'task_complete', turn_id: 'turn-original' }, 2),
    ].join('')
    writeFileSync(path, original)
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexDesktopDriver({ watchFile: false, pollIntervalMs: 10 })],
      onEvent: (event) => events.push(event),
      captureDir: dir,
    })
    await broker.start({ spec: spec(path, 'inv-desktop-replacement') })
    await waitFor(() =>
      events.some(
        (event) => event.type === 'turn.completed' && event.turnId === ('turn-original' as never)
      )
    )

    const replacementPrefix = `${' '.repeat(original.length - 1)}\n`
    writeFileSync(
      path,
      [
        replacementPrefix,
        row({ type: 'task_started', turn_id: 'turn-replacement' }, 3),
        row({ type: 'task_complete', turn_id: 'turn-replacement' }, 4),
      ].join('')
    )
    await waitFor(() =>
      events.some(
        (event) => event.type === 'turn.completed' && event.turnId === ('turn-replacement' as never)
      )
    )
    expect(
      events.filter(
        (event) => event.type === 'turn.started' && event.turnId === ('turn-original' as never)
      )
    ).toHaveLength(1)
    expect(
      events.filter(
        (event) => event.type === 'turn.started' && event.turnId === ('turn-replacement' as never)
      )
    ).toHaveLength(1)
  })

  test('queues one native write, preserves human interleaving, and executes only on client-id rollout evidence', async () => {
    const dir = tempDir()
    const path = join(dir, 'queue.jsonl')
    writeFileSync(path, '')
    const native = queueHarness()
    const events: InvocationEventEnvelope[] = []
    const invocationId = 'inv-desktop-queue' as InvocationId
    const broker = createBroker({
      drivers: [
        createCodexDesktopDriver({
          watchFile: false,
          pollIntervalMs: 10,
          openQueueHelper: native.openQueueHelper,
        }),
      ],
      onEvent: (event) => events.push(event),
      captureDir: dir,
    })
    await broker.start({ spec: spec(path, invocationId) })
    const origin = {
      principalRef: 'agent:sender',
      scopeRef: 'sender@agent-spaces:primary',
      envelopeId: 'EN-desktop-queue',
    }
    const first = await broker.enqueue({ invocationId, origin, body: 'first' })
    await waitFor(() => native.adds.length === 1)
    expect(
      events.find(
        (event) =>
          event.type === 'driver.notice' &&
          event.payload.code === 'CODEX_DESKTOP_NATIVE_ATTEMPT_QUEUED'
      )?.payload.data
    ).toMatchObject({
      inputId: first.submissionId,
      clientUserMessageId: first.submissionId,
      nativeThreadId: 'thread-desktop',
      envelopeId: 'EN-desktop-queue',
      queuedSubmissionId: `native-${first.submissionId}`,
      attemptState: 'queued',
    })
    const second = await broker.enqueue({ invocationId, origin, body: 'second' })
    const listed = await broker.queueList({ invocationId })
    expect(listed.entries.map((entry) => entry.submissionId)).toEqual([second.submissionId])

    const humanTurn = [
      row({ type: 'task_started', turn_id: 'turn-human' }, 1),
      itemRow(
        'thread-desktop',
        'turn-human',
        {
          type: 'UserMessage',
          id: 'user-human',
          client_id: 'human-client',
          content: [{ type: 'text', text: 'human interleaving' }],
        },
        2
      ),
      row({ type: 'task_complete', turn_id: 'turn-human' }, 3),
    ].join('')
    appendFileSync(path, humanTurn)
    await waitFor(() =>
      events.some(
        (event) => event.type === 'turn.completed' && event.turnId === ('turn-human' as never)
      )
    )
    expect(
      events.some(
        (event) =>
          event.type === 'submission.executed' && event.payload.submissionId === first.submissionId
      )
    ).toBe(false)
    expect(native.adds).toHaveLength(1)

    native.queue.splice(0, 1)
    appendFileSync(path, ownTurnRows('thread-desktop', 'turn-owned', first.submissionId, 10))
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === 'submission.executed' && event.payload.submissionId === first.submissionId
      )
    )
    await waitFor(() => native.adds.length === 2)
    expect(native.adds).toEqual([first.submissionId, second.submissionId])
  })

  test('carries a native fence across fresh invocation and capture identities until matching execution', async () => {
    const dir = tempDir()
    const path = join(dir, 'lost-ack.jsonl')
    const nativeAttemptStorePath = join(dir, 'stable-observer-state', 'native-attempts.db')
    writeFileSync(path, '')
    let queued: NativeQueueRow | undefined
    let adds = 0
    const cursors: Array<string | undefined> = []
    const openQueueHelper = async (): Promise<CodexDesktopQueueHelper> => ({
      async list(_threadId, cursor) {
        cursors.push(cursor)
        if (cursor === undefined) {
          return {
            data: [{ id: 'human-native', clientUserMessageId: 'human-client' }],
            nextCursor: 'page-2',
          }
        }
        return { data: queued === undefined ? [] : [queued], nextCursor: null }
      },
      async add(_threadId, _input, clientUserMessageId) {
        adds += 1
        queued = { id: 'native-lost-ack', clientUserMessageId }
        throw new Error('fault injection: helper died after native insert')
      },
      async delete() {
        return { deleted: false }
      },
      close() {},
    })
    const firstInvocationId = 'inv-desktop-lost-ack-a' as InvocationId
    const firstEvents: InvocationEventEnvelope[] = []
    const first = createBroker({
      drivers: [
        createCodexDesktopDriver({ openQueueHelper, watchFile: false, pollIntervalMs: 10 }),
      ],
      onEvent: (event) => firstEvents.push(event),
      captureDir: join(dir, 'first-capture'),
    })
    await first.start({
      spec: withDriver(spec(path, firstInvocationId), { nativeAttemptStorePath }),
    })
    const admitted = await first.enqueue({
      invocationId: firstInvocationId,
      origin: { principalRef: 'agent:sender', envelopeId: 'EN-lost-ack' },
      body: 'lost ack',
    })
    await waitFor(() =>
      firstEvents.some(
        (event) =>
          event.type === 'driver.notice' &&
          event.payload.code === 'CODEX_DESKTOP_NATIVE_ATTEMPT_RECONCILED_QUEUED'
      )
    )
    expect(adds).toBe(1)
    expect(cursors).toContain('page-2')
    await first.stop({ invocationId: firstInvocationId, reason: 'restart fault injection' })
    await first.dispose({ invocationId: firstInvocationId })

    const secondInvocationId = 'inv-desktop-lost-ack-b' as InvocationId
    const secondEvents: InvocationEventEnvelope[] = []
    const second = createBroker({
      drivers: [
        createCodexDesktopDriver({ openQueueHelper, watchFile: false, pollIntervalMs: 10 }),
      ],
      onEvent: (event) => secondEvents.push(event),
      captureDir: join(dir, 'replacement-capture'),
    })
    await second.start({
      spec: withDriver(spec(path, secondInvocationId), {
        nativeAttemptStorePath,
        recoveryBoundary: { committedProjections: [], appliedThroughSeq: 0, empty: true },
      }),
    })
    const expiring = await second.enqueue({
      invocationId: secondInvocationId,
      origin: { principalRef: 'agent:sender', envelopeId: 'EN-expiring' },
      body: 'expires behind the native fence',
      ttlMs: 5,
    })
    await waitFor(() =>
      secondEvents.some(
        (event) =>
          event.type === 'submission.expired' &&
          event.payload.submissionId === expiring.submissionId
      )
    )
    const withdrawn = await second.enqueue({
      invocationId: secondInvocationId,
      origin: { principalRef: 'agent:sender', envelopeId: 'EN-withdrawn' },
      body: 'withdrawn behind the native fence',
    })
    expect(
      await second.withdraw({ submissionId: withdrawn.submissionId, reason: 'outer terminal' })
    ).toEqual({ outcome: 'withdrawn' })
    const later = await second.enqueue({
      invocationId: secondInvocationId,
      origin: { principalRef: 'agent:sender', envelopeId: 'EN-later' },
      body: 'must remain local',
    })
    await Bun.sleep(30)
    expect(adds).toBe(1)
    expect(
      (await second.queueList({ invocationId: secondInvocationId })).entries.map(
        (entry) => entry.submissionId
      )
    ).toEqual([later.submissionId])
    expect(admitted.submissionId).toBe('submission_inv-desktop-lost-ack-a_1')

    queued = undefined
    appendFileSync(path, ownTurnRows('thread-desktop', 'turn-old-executed', admitted.submissionId))
    await waitFor(() => adds === 2)
    expect(adds).toBe(2)
    expect(
      secondEvents.filter(
        (event) =>
          event.type === 'submission.executed' &&
          event.payload.submissionId === admitted.submissionId
      )
    ).toHaveLength(1)
    expect(
      secondEvents.some(
        (event) =>
          event.type === 'submission.executed' && event.payload.submissionId === later.submissionId
      )
    ).toBe(false)
    expect(queued?.clientUserMessageId).toBe(later.submissionId)
  })

  test('fences an absent possibly-written attempt and retries only a definitive rejection', async () => {
    const run = async (kind: 'indeterminate' | 'rejected') => {
      const dir = tempDir()
      const path = join(dir, `${kind}.jsonl`)
      writeFileSync(path, '')
      let adds = 0
      const openQueueHelper = async (): Promise<CodexDesktopQueueHelper> => ({
        async list() {
          return { data: [], nextCursor: null }
        },
        async add() {
          adds += 1
          if (kind === 'rejected' && adds === 1) {
            throw new CodexRpcError(-32602, 'native queue rejected')
          }
          if (kind === 'indeterminate') {
            throw new Error('fault injection: disconnected after write')
          }
          return { queuedSubmission: { id: 'native-retry' } }
        },
        async delete() {
          return { deleted: false }
        },
        close() {},
      })
      const invocationId = `inv-desktop-${kind}` as InvocationId
      const events: InvocationEventEnvelope[] = []
      const broker = createBroker({
        drivers: [
          createCodexDesktopDriver({ openQueueHelper, watchFile: false, pollIntervalMs: 10 }),
        ],
        onEvent: (event) => events.push(event),
        captureDir: dir,
      })
      await broker.start({ spec: spec(path, invocationId) })
      await broker.enqueue({
        invocationId,
        origin: { principalRef: 'agent:sender' },
        body: kind,
      })
      await waitFor(() => adds === 1)
      const second = await broker.enqueue({
        invocationId,
        origin: { principalRef: 'agent:sender' },
        body: 'second',
      })
      if (kind === 'rejected') await waitFor(() => adds === 2)
      else await Bun.sleep(30)
      return { adds, events, broker, invocationId, second }
    }

    const indeterminate = await run('indeterminate')
    expect(indeterminate.adds).toBe(1)
    expect(
      indeterminate.events.some(
        (event) => event.payload.code === 'CODEX_DESKTOP_NATIVE_ATTEMPT_INDETERMINATE'
      )
    ).toBe(true)
    expect(
      (await indeterminate.broker.queueList({ invocationId: indeterminate.invocationId })).entries
    ).toHaveLength(1)

    const rejected = await run('rejected')
    expect(rejected.adds).toBe(2)
    expect(
      rejected.events.some(
        (event) => event.payload.code === 'CODEX_DESKTOP_NATIVE_ATTEMPT_REJECTED'
      )
    ).toBe(true)
  })

  test('withdraw deletes only the owned native id while broker-local TTL expires independently', async () => {
    const dir = tempDir()
    const path = join(dir, 'cancel.jsonl')
    writeFileSync(path, '')
    const native = queueHarness()
    const events: InvocationEventEnvelope[] = []
    const invocationId = 'inv-desktop-cancel' as InvocationId
    const broker = createBroker({
      drivers: [
        createCodexDesktopDriver({
          openQueueHelper: native.openQueueHelper,
          watchFile: false,
          pollIntervalMs: 10,
        }),
      ],
      onEvent: (event) => events.push(event),
      captureDir: dir,
    })
    await broker.start({ spec: spec(path, invocationId) })
    const first = await broker.enqueue({
      invocationId,
      origin: { principalRef: 'agent:sender', envelopeId: 'EN-cancel' },
      body: 'owned',
    })
    await waitFor(() => native.adds.length === 1)
    native.queue.push({ id: 'human-native', clientUserMessageId: 'human-client' })
    const expiring = await broker.enqueue({
      invocationId,
      origin: { principalRef: 'agent:sender' },
      body: 'expires broker-local',
      ttlMs: 5,
    })
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === 'submission.expired' &&
          event.payload.submissionId === expiring.submissionId
      )
    )
    expect(native.adds).toHaveLength(1)
    expect(
      await broker.withdraw({ submissionId: first.submissionId, reason: 'envelope-terminal' })
    ).toEqual({
      outcome: 'withdrawn',
    })
    expect(native.deletes).toEqual([`native-${first.submissionId}`])
    expect(native.queue).toEqual([{ id: 'human-native', clientUserMessageId: 'human-client' }])

    appendFileSync(path, ownTurnRows('thread-desktop', 'turn-delete-race', first.submissionId, 20))
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === 'turn.attributed' &&
          event.turnId === ('turn-delete-race' as never) &&
          event.payload.ownership === 'own'
      )
    )
    expect(
      events.some(
        (event) =>
          event.type === 'submission.executed' && event.payload.submissionId === first.submissionId
      )
    ).toBe(false)
    expect(
      events.some(
        (event) =>
          event.type === 'driver.notice' &&
          event.payload.code === 'CODEX_DESKTOP_NATIVE_ATTEMPT_EXECUTED'
      )
    ).toBe(true)
  })

  test('surfaces bundled helper incompatibility and never falls back or writes', async () => {
    const dir = tempDir()
    const path = join(dir, 'incompatible.jsonl')
    writeFileSync(path, '')
    let opens = 0
    const events: InvocationEventEnvelope[] = []
    const invocationId = 'inv-desktop-incompatible' as InvocationId
    const broker = createBroker({
      drivers: [
        createCodexDesktopDriver({
          watchFile: false,
          openQueueHelper: async () => {
            opens += 1
            throw new Error('experimental queue methods unavailable in bundled server')
          },
        }),
      ],
      onEvent: (event) => events.push(event),
      captureDir: dir,
    })
    await broker.start({ spec: spec(path, invocationId) })
    await broker.enqueue({
      invocationId,
      origin: { principalRef: 'agent:sender' },
      body: 'must not fall back',
    })
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === 'driver.notice' && event.payload.code === 'CODEX_DESKTOP_DELIVERY_DEGRADED'
      )
    )
    await waitFor(() => events.some((event) => event.type === 'submission.rejected'))
    expect(opens).toBe(1)
    expect(
      events.some(
        (event) =>
          event.type === 'submission.rejected' &&
          String(event.payload.reason).includes('bundled server')
      )
    ).toBe(true)
    expect(
      (await broker.status({ invocationId, probeLiveness: true })).liveness?.driver
    ).toMatchObject({ state: 'degraded' })
  })
})
