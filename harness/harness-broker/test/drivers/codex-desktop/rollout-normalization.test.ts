import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCodexTranscriptModel } from '../../../src/drivers/codex-app-server/transcript'
import { observerBroker, removeTempDirs, spec, tempDir, waitFor } from './observer-harness'
import {
  agentMessage,
  commandExecution,
  customToolOutputRow,
  customToolStartRow,
  itemRow,
  responseItemRow,
  row,
  userMessage,
} from './rollout-rows'

afterEach(removeTempDirs)

/** HRC's desktopProjectionIdentity: rawSha256|type|first of itemId, nativeId, turnId. */
function desktopProjectionIdentityForTest(event: {
  type?: unknown
  itemId?: unknown
  turnId?: unknown
  provenance?: { rawSha256?: unknown; nativeId?: unknown } | undefined
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

/** Write `rollout` to a fresh temp dir and observe it until `done`. */
async function observe(
  name: string,
  rollout: string,
  options: { threadId?: string; done?: 'turn.completed' | 'tool.call.completed' } = {}
) {
  const dir = tempDir()
  const path = join(dir, `${name}.jsonl`)
  writeFileSync(path, rollout)
  const { broker, events } = observerBroker({ captureDir: dir })
  await broker.start({ spec: spec(path, `inv-desktop-${name}`, options.threadId) })
  const done = options.done ?? 'turn.completed'
  await waitFor(() => events.some((event) => event.type === done))
  return events
}

describe('codex-desktop rollout normalization', () => {
  test('normalizes native turn, attribution, assistant phases, tools, usage and terminal once', async () => {
    const threadId = 'thread-desktop'
    const turnId = 'turn-1'
    const events = await observe(
      'basic',
      [
        row({ type: 'task_started', turn_id: turnId }, 1),
        itemRow(threadId, turnId, userMessage('user-1', 'human-client', 'hello'), 2),
        itemRow(threadId, turnId, agentMessage('assistant-commentary', 'commentary', 'working'), 3),
        customToolStartRow(
          turnId,
          'call-native-1',
          'text(await tools.exec_command({cmd:"echo ok"}));\n',
          4,
          undefined,
          'ctc-native-1'
        ),
        itemRow(threadId, turnId, commandExecution('tool-1', ['echo', 'ok'], 'ok\n'), 5),
        customToolOutputRow(
          turnId,
          'call-native-1',
          [{ type: 'input_text', text: 'Script completed\n' }],
          6
        ),
        itemRow(threadId, turnId, agentMessage('assistant-final', 'final_answer', 'done'), 7),
        `${JSON.stringify({ type: 'response_item', payload: { type: 'agent_message', id: 'assistant-final' } })}\n`,
        row({ type: 'token_count', info: { last_token_usage: { total_tokens: 12 } } }, 8),
        row({ type: 'task_complete', turn_id: turnId, last_agent_message: 'done' }, 9),
      ].join('')
    )

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
    expect(observed.every((event) => event.provenance?.rawRecordId !== undefined)).toBe(true)
  })

  test('does not fabricate a start when native call identity or turn identity is incomplete', async () => {
    const threadId = 'thread-desktop'
    const turnId = 'turn-unreliable'
    const events = await observe(
      'unreliable',
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
        itemRow(threadId, turnId, commandExecution('exec-unpaired', ['pwd'], '/tmp\n'), 3) +
        row({ type: 'task_complete', turn_id: turnId }, 4)
    )

    expect(events.filter((event) => event.type === 'tool.call.started')).toHaveLength(0)
    expect(events.find((event) => event.type === 'tool.call.completed')).toMatchObject({
      itemId: 'exec-unpaired',
      payload: { toolCallId: 'exec-unpaired' },
    })
    expect(events.filter((event) => event.type === 'assistant.message.started')).toHaveLength(0)
  })

  test('pairs orchestration output by call_id across zero, multiple, and interleaved child commands', async () => {
    const threadId = 'thread-desktop'
    const turnId = 'turn-orchestration'
    const events = await observe(
      'orchestration',
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
        itemRow(threadId, turnId, commandExecution('exec-parallel-b', ['b'], 'b\n'), 6),
        itemRow(threadId, turnId, commandExecution('exec-one', ['one'], 'one\n'), 7),
        itemRow(threadId, turnId, commandExecution('exec-parallel-a', ['a'], 'a\n'), 8),
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

    const completions = events.filter((event) => event.type === 'tool.call.completed')
    const parents = completions.filter((event) => event.payload.name === 'exec/orchestration')
    const children = completions.filter((event) => event.payload.name === 'command')
    expect<string[]>(parents.map((event) => event.payload.toolCallId)).toEqual([
      'call-zero',
      'call-one',
      'call-parallel',
    ])
    expect<string[]>(children.map((event) => event.payload.toolCallId)).toEqual([
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
    const dir = tempDir()
    const path = join(dir, 'quasar-native-starts.jsonl')
    writeFileSync(
      path,
      specimens
        .flatMap((sample, index) => {
          const ordinal = index * 4 + 1
          return [
            row({ type: 'task_started', turn_id: sample.turnId }, ordinal),
            customToolStartRow(
              sample.turnId,
              sample.callId,
              sample.input,
              ordinal + 1,
              sample.start,
              sample.responseId
            ),
            itemRow(
              threadId,
              sample.turnId,
              commandExecution(
                sample.completionId,
                ['/bin/zsh', '-lc', sample.input],
                `result ${index + 1}\n`,
                { aggregated_output: `result ${index + 1}\n` }
              ),
              ordinal + 2,
              sample.childComplete
            ),
            customToolOutputRow(
              sample.turnId,
              sample.callId,
              [{ type: 'input_text', text: `orchestration ${index + 1}\n` }],
              ordinal + 3,
              sample.output,
              sample.outputId
            ),
            row({ type: 'task_complete', turn_id: sample.turnId }, ordinal + 4),
          ]
        })
        .join('')
    )
    const { broker, events } = observerBroker({ captureDir: dir })
    await broker.start({ spec: spec(path, 'inv-desktop-quasar-frozen', threadId) })
    await waitFor(
      () => events.filter((event) => event.type === 'turn.completed').length === specimens.length
    )

    const starts = events.filter((event) => event.type === 'tool.call.started')
    const completions = events.filter((event) => event.type === 'tool.call.completed')
    const parentCompletions = completions.filter(
      (event) => event.payload.name === 'exec/orchestration'
    )
    const childCompletions = completions.filter((event) => event.payload.name === 'command')
    expect<string[]>(starts.map((event) => event.payload.toolCallId)).toEqual(
      specimens.map((sample) => sample.callId)
    )
    expect<string[]>(parentCompletions.map((event) => event.payload.toolCallId)).toEqual(
      specimens.map((sample) => sample.callId)
    )
    expect(starts.map((event) => event.time)).toEqual(specimens.map((sample) => sample.start))
    expect(parentCompletions.map((event) => event.time)).toEqual(
      specimens.map((sample) => sample.output)
    )
    expect(parentCompletions.map((event) => event.payload.result)).toEqual(
      [1, 2, 3].map((n) => ({
        output: `[exec/orchestration output]\norchestration ${n}\n`,
        codeModeOutput: [{ type: 'input_text', text: `orchestration ${n}\n` }],
      }))
    )
    expect<string[]>(childCompletions.map((event) => event.payload.toolCallId)).toEqual(
      specimens.map((sample) => sample.completionId)
    )
    expect(childCompletions.map((event) => event.time)).toEqual(
      specimens.map((sample) => sample.childComplete)
    )
    expect(childCompletions.map((event) => event.payload.result)).toEqual(
      [1, 2, 3].map((n) => ({
        status: 'completed',
        stdout: `result ${n}\n`,
        stderr: '',
        output: `result ${n}\n`,
        exitCode: 0,
      }))
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

  test('replays the exact frozen command record with its old committed projection identity', async () => {
    const frozenPath = join(
      import.meta.dir,
      '../../fixtures/codex-desktop-quasar-command-exec-4517.jsonl'
    )
    const exactFrozenFile = readFileSync(frozenPath, 'utf8')
    expect(exactFrozenFile.endsWith('\n')).toBe(true)
    expect(exactFrozenFile.indexOf('\n')).toBe(exactFrozenFile.length - 1)
    const exactFrozenRecord = exactFrozenFile.slice(0, -1)
    expect(createHash('sha256').update(exactFrozenRecord).digest('hex')).toBe(
      'e4b81dbcdd1ea3c6db64f3087042e6446681c4fdec12f5ed629d0450032f13bd'
    )

    const events = await observe('exact-frozen-command', exactFrozenFile, {
      threadId: '01a086af-b567-7ea3-9812-de81aab2ec42',
      done: 'tool.call.completed',
    })

    const emitted = events.find((event) => event.type === 'tool.call.completed')
    expect(emitted).toMatchObject({
      type: 'tool.call.completed',
      turnId: '01a086af-db07-7e72-94c1-a0ce9557496f',
      itemId: 'exec-4517c5b9-be5d-440a-808a-97d8e79cfa7b',
      payload: {
        toolCallId: 'exec-4517c5b9-be5d-440a-808a-97d8e79cfa7b',
        name: 'command',
      },
      provenance: {
        sourceCursor: { byteOffset: 0, line: 1 },
        nativeType: 'event_msg:item_completed:CommandExecution',
        nativeId: 'exec-4517c5b9-be5d-440a-808a-97d8e79cfa7b',
        rawSha256: 'e4b81dbcdd1ea3c6db64f3087042e6446681c4fdec12f5ed629d0450032f13bd',
      },
    })

    // Extracted from frozen HRC invocation inv-2c2d... seq 6. HRC's
    // desktopProjectionIdentity ignores source epoch/cursor and keys the
    // durable native content as rawSha256|type|itemId.
    const oldCommittedEnvelope = {
      type: 'tool.call.completed',
      itemId: 'exec-4517c5b9-be5d-440a-808a-97d8e79cfa7b',
      provenance: {
        nativeId: 'exec-4517c5b9-be5d-440a-808a-97d8e79cfa7b',
        rawSha256: 'e4b81dbcdd1ea3c6db64f3087042e6446681c4fdec12f5ed629d0450032f13bd',
      },
    }
    expect(desktopProjectionIdentityForTest(emitted ?? {})).toBe(
      desktopProjectionIdentityForTest(oldCommittedEnvelope)
    )
  })

  test('T-08430: usage borrows the model its turn_context named', async () => {
    const events = await observe(
      'usage-model',
      [
        row({ type: 'task_started', turn_id: 'turn-model' }, 1),
        // A rollout `turn_context` row: not an event_msg, dispositioned
        // ignored-known by the shared classifier, yet the only place the
        // rollout names the model Codex resolved for the turn.
        `${JSON.stringify({
          timestamp: new Date(2000).toISOString(),
          ordinal: 2,
          type: 'turn_context',
          payload: { turn_id: 'turn-model', model: 'gpt-5.6-sol', effort: 'medium' },
        })}\n`,
        row({ type: 'token_count', turn_id: 'turn-model', info: { total_tokens: 42 } }, 3),
        row({ type: 'task_complete', turn_id: 'turn-model' }, 4),
      ].join('')
    )

    const usage = events.filter((event) => event.type === 'usage.updated')
    expect(usage).toHaveLength(1)
    expect(usage[0]?.payload).toMatchObject({
      model: { id: 'gpt-5.6-sol', source: 'provider-response' },
    })
  })

  test('T-08430: usage carries no model when the rollout never named one', async () => {
    const events = await observe(
      'usage-no-model',
      [
        row({ type: 'task_started', turn_id: 'turn-nomodel' }, 1),
        row({ type: 'token_count', turn_id: 'turn-nomodel', info: { total_tokens: 42 } }, 2),
        row({ type: 'task_complete', turn_id: 'turn-nomodel' }, 3),
      ].join('')
    )

    const usage = events.filter((event) => event.type === 'usage.updated')
    expect(usage).toHaveLength(1)
    expect(usage[0]?.payload['model']).toBeUndefined()
  })
})
