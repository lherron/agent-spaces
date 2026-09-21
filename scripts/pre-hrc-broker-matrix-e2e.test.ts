import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol'

import {
  BROKER_MANAGED_MATRIX_ROWS,
  MATRIX_ROW_NAMES,
  SPARKY_CODEX_MATRIX_ROWS,
  matrixRowSelection,
  verifyBrokerEventFloor,
} from './pre-hrc-broker-matrix-e2e.ts'

const invocationId = 'inv_matrix_contract' as InvocationId
const marker = 'MATRIX_MARKER'

function event(
  seq: number,
  type: InvocationEventEnvelope['type'],
  payload: Record<string, unknown>,
  turnId?: string
): InvocationEventEnvelope {
  return {
    invocationId,
    seq,
    time: new Date(1_700_000_000_000 + seq).toISOString(),
    type,
    payload,
    ...(turnId === undefined ? {} : { turnId: turnId as never }),
  } as InvocationEventEnvelope
}

function completeMarkerStream(): InvocationEventEnvelope[] {
  return [
    event(1, 'invocation.started', { command: 'codex', args: [], cwd: '/tmp' }),
    event(2, 'invocation.ready', { state: 'ready' }),
    event(3, 'turn.started', { turnId: 'turn_1', inputId: 'input_1' }, 'turn_1'),
    event(
      4,
      'tool.call.started',
      { toolCallId: 'call_1', name: 'Bash', input: { command: `printf ${marker}` } },
      'turn_1'
    ),
    event(
      5,
      'tool.call.completed',
      { toolCallId: 'call_1', name: 'Bash', output: marker, isError: false },
      'turn_1'
    ),
    event(6, 'turn.completed', { turnId: 'turn_1' }, 'turn_1'),
  ]
}

describe('pre-HRC broker matrix v2 catalog', () => {
  test('keeps only broker-managed catalog routes', () => {
    expect(BROKER_MANAGED_MATRIX_ROWS).toEqual(MATRIX_ROW_NAMES)
    expect(MATRIX_ROW_NAMES).toEqual([
      'fake-codex',
      'unix-jsonrpc-ndjson',
      'real-codex',
      'codex-tui',
      'real-claude-tmux',
      'real-muse-serve',
      'muse-tmux',
    ])
  })

  test('covers headless and presentation Codex through one closed harness id', () => {
    expect(SPARKY_CODEX_MATRIX_ROWS).toContain('fake-codex')
    expect(SPARKY_CODEX_MATRIX_ROWS).toContain('codex-tui')
  })

  test.each([
    ['fake-codex', 'codex', 'openai-codex', 'gpt-5.6-terra', false],
    ['unix-jsonrpc-ndjson', 'codex', 'openai-codex', 'gpt-5.6-terra', false],
    ['real-codex', 'codex', 'openai-codex', 'gpt-5.6-terra', false],
    ['codex-tui', 'codex', 'openai-codex', 'gpt-5.6-terra', true],
    ['real-claude-tmux', 'claude', 'anthropic', 'claude-sonnet-4-5', true],
    ['real-muse-serve', 'muse', 'meta', 'muse-spark-1.3-contributor', false],
    ['muse-tmux', 'muse', 'meta', 'muse-spark-1.3-contributor', true],
  ] as const)(
    'builds %s from the producer-owned requested harness tuple',
    (row, harness, modelProvider, model, presentation) => {
      expect(matrixRowSelection(row)).toEqual({ harness, modelProvider, model, presentation })
    }
  )

  test('retains command-turn event-floor verification for a complete broker stream', () => {
    expect(verifyBrokerEventFloor(completeMarkerStream(), invocationId, marker)).toEqual([])
  })

  test('rejects event streams that cross an invocation boundary', () => {
    const events = completeMarkerStream()
    events[2] = { ...events[2]!, invocationId: 'inv_other' as InvocationId }
    expect(
      verifyBrokerEventFloor(events, invocationId, marker).map((failure) => failure.code)
    ).toContain('event_invocation_mismatch')
  })

  test('rejects non-monotonic broker sequence numbers', () => {
    const events = completeMarkerStream()
    events[2] = { ...events[2]!, seq: 2 }
    expect(
      verifyBrokerEventFloor(events, invocationId, marker).map((failure) => failure.code)
    ).toContain('event_sequence_invalid')
  })

  test('rejects a stream that does not finish the marker command turn', () => {
    const events = completeMarkerStream().filter((item) => item.type !== 'turn.completed')
    expect(
      verifyBrokerEventFloor(events, invocationId, marker).map((failure) => failure.code)
    ).toEqual(
      expect.arrayContaining(['terminal_turn_count_invalid', 'marker_turn_completion_missing'])
    )
  })
})
