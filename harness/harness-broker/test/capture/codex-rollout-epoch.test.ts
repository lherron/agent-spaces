import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvocationId, RawProviderRecord } from 'spaces-harness-broker-protocol'
import { createCaptureGate } from '../../src/capture/capture-gate'
import { openCaptureIndex } from '../../src/capture/capture-index'
import { createRawJournal } from '../../src/capture/raw-journal'
import { createCodexHookTranscriptReader } from '../../src/drivers/codex-cli-tmux/hook-transcript'

/**
 * Source-epoch handling for the Codex rollout file (T-07853 §7.1, §14 row 5).
 *
 * A byte offset only means something within one epoch: if the file this reader
 * is tailing is replaced or truncated under it, offset 400 addresses different
 * bytes than it did a moment ago. The gate must mint a NEW epoch at that
 * boundary, and no fact may be skipped or minted twice across it.
 */
const invocationId = 'inv_codex_epoch' as InvocationId
const roots: string[] = []
process.on('exit', () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const agentMessage = (id: string, message: string): string =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', id, message } })

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-epoch-'))
  roots.push(dir)
  const index = openCaptureIndex(join(dir, 'ledger-index.db'))
  const gate = createCaptureGate({
    invocationId,
    journal: createRawJournal({ invocationId, dir }),
    index,
    normalizer: { name: 'codex-cli-tmux', version: 'test' },
    now: () => new Date('2026-09-02T12:00:00.000Z'),
    emitWarning: () => 0,
    emitReleased: () => 0,
    emitNormalizedAs: () => 0,
  })
  const events: string[] = []
  const reader = createCodexHookTranscriptReader({
    invocationId,
    now: () => new Date('2026-09-02T12:00:00.000Z'),
    getCurrentTurnId: () => 'turn_active',
    capture: gate,
  })
  const pump = (hook: Record<string, unknown>): void => {
    for (const event of reader.handleHook(hook)) {
      const payload = event.payload as { content?: Array<{ text?: string }> }
      events.push(`${event.type}:${payload.content?.[0]?.text ?? ''}`)
    }
  }
  return {
    dir,
    gate,
    events,
    pump,
    records: (): RawProviderRecord[] => gate.records(),
    close: () => index.close(),
  }
}

/** Bytes committed for a record, as text. */
const textOf = (record: RawProviderRecord): string => Buffer.from(record.rawBytes).toString('utf8')

describe('codex rollout source epochs', () => {
  test('truncation mints a new epoch and restarts the cursor', () => {
    const h = harness()
    const transcript = join(h.dir, 'rollout.jsonl')
    writeFileSync(transcript, '')
    h.pump({ hook_event_name: 'SessionStart', transcript_path: transcript })

    appendFileSync(transcript, `${agentMessage('msg_1', 'before')}\n`)
    appendFileSync(transcript, `${agentMessage('msg_2', 'still before')}\n`)
    h.pump({ hook_event_name: 'Stop' })
    const beforeRotation = h.records()
    expect(beforeRotation).toHaveLength(2)

    // Codex replaces the file under us: same path, shorter.
    truncateSync(transcript, 0)
    appendFileSync(transcript, `${agentMessage('msg_3', 'after')}\n`)
    h.pump({ hook_event_name: 'Stop' })

    const all = h.records()
    expect(all).toHaveLength(3)
    const epochs = all.map((record) => record.sourceEpoch)
    // A new epoch, and it is genuinely new — not a reused id.
    expect(epochs[0]).toBe(epochs[1] as string)
    expect(epochs[2]).not.toBe(epochs[0] as string)
    // Line ordinals are per-epoch, so the post-rotation row is line 1 again and
    // its byte offset is comparable only within its own epoch.
    expect(all.map((record) => record.sourceCursor.line)).toEqual([1, 2, 1])
    expect(all[2]?.sourceCursor.byteOffset).toBe(0)
    h.close()
  })

  test('a truncate-and-rewrite that grows PAST the old offset is caught', () => {
    // The dangerous shape, and the one `size < offset` cannot see: by the time
    // the tailer next looks, the file is longer than the cursor again. Reading
    // from the old offset hands the caller a mid-line fragment and silently
    // drops everything before it.
    const h = harness()
    const transcript = join(h.dir, 'rollout.jsonl')
    writeFileSync(transcript, '')
    h.pump({ hook_event_name: 'SessionStart', transcript_path: transcript })
    appendFileSync(transcript, `${agentMessage('msg_1', 'first answer')}\n`)
    h.pump({ hook_event_name: 'Stop' })

    truncateSync(transcript, 0)
    appendFileSync(transcript, `${agentMessage('msg_2', 'x'.repeat(400))}\n`)
    appendFileSync(transcript, `${agentMessage('msg_3', 'third answer')}\n`)
    h.pump({ hook_event_name: 'Stop' })

    const records = h.records()
    // Three WHOLE rows, none of them a fragment.
    expect(records.map((record) => JSON.parse(textOf(record)).payload.id)).toEqual([
      'msg_1',
      'msg_2',
      'msg_3',
    ])
    expect(records[1]?.sourceEpoch).not.toBe(records[0]?.sourceEpoch as string)
    expect(records[1]?.sourceEpoch).toBe(records[2]?.sourceEpoch as string)
    expect(records.map((record) => record.sourceCursor.line)).toEqual([1, 1, 2])
    h.close()
  })

  test('no fact is skipped or duplicated when the rewrite matches what was read', () => {
    const h = harness()
    const transcript = join(h.dir, 'rollout.jsonl')
    writeFileSync(transcript, '')
    h.pump({ hook_event_name: 'SessionStart', transcript_path: transcript })

    appendFileSync(transcript, `${agentMessage('msg_1', 'first answer')}\n`)
    h.pump({ hook_event_name: 'Stop' })

    // Truncate and REWRITE the same first row, then add a new one. The bytes
    // behind the cursor are unchanged, so this is the same epoch and the
    // already-committed row is NOT committed a second time.
    truncateSync(transcript, 0)
    appendFileSync(transcript, `${agentMessage('msg_1', 'first answer')}\n`)
    appendFileSync(transcript, `${agentMessage('msg_2', 'second answer')}\n`)
    h.pump({ hook_event_name: 'Stop' })

    expect(h.records().map((record) => JSON.parse(textOf(record)).payload.id)).toEqual([
      'msg_1',
      'msg_2',
    ])
    const answers = h.events.filter((event) => event.startsWith('assistant.message.completed:'))
    expect(answers).toEqual([
      'assistant.message.completed:first answer',
      'assistant.message.completed:second answer',
    ])
    h.close()
  })

  test('retargeting to a different transcript mints a new epoch', () => {
    const h = harness()
    const first = join(h.dir, 'rollout-a.jsonl')
    const second = join(h.dir, 'rollout-b.jsonl')
    writeFileSync(first, `${agentMessage('msg_1', 'session a')}\n`)
    writeFileSync(second, `${agentMessage('msg_9', 'session b')}\n`)

    h.pump({ hook_event_name: 'SessionStart', transcript_path: first })
    h.pump({ hook_event_name: 'Stop' })
    h.pump({ hook_event_name: 'SessionStart', transcript_path: second })
    h.pump({ hook_event_name: 'Stop' })

    const records = h.records()
    expect(records.map(textOf)).toEqual([
      agentMessage('msg_1', 'session a'),
      agentMessage('msg_9', 'session b'),
    ])
    expect(records[0]?.sourceEpoch).not.toBe(records[1]?.sourceEpoch as string)
    // A retarget also resets the reader's per-line state, so the new session's
    // prose is minted even if the previous session had already seen that id.
    expect(h.events).toEqual([
      'assistant.message.completed:session a',
      'assistant.message.completed:session b',
    ])
    h.close()
  })

  test('re-reporting the SAME transcript path is not an epoch boundary', () => {
    // Codex fires SessionStart on every resume of the same session; treating
    // that as a rotation would re-commit the whole file each time.
    const h = harness()
    const transcript = join(h.dir, 'rollout.jsonl')
    writeFileSync(transcript, `${agentMessage('msg_1', 'only answer')}\n`)
    h.pump({ hook_event_name: 'SessionStart', transcript_path: transcript })
    h.pump({ hook_event_name: 'Stop' })
    h.pump({ hook_event_name: 'SessionStart', transcript_path: transcript })
    h.pump({ hook_event_name: 'Stop' })

    // One commit, one epoch: a resume of the same session is not a rotation.
    expect(h.records()).toHaveLength(1)
    h.close()
  })
})
