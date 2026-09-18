/**
 * muse-cli-tmux transcript reader tests (T-08601): session discovery and
 * poll-driven tailing over a fixture sessions tree.
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMuseCliTmuxLogEventNormalizer } from './log-events'
import { createMuseCliSessionTranscriptReader, discoverMuseSessionLog } from './transcript'

const now = () => new Date('2026-09-18T12:00:00.000Z')
const RUN = 'run_22222222-2222-4222-8222-222222222222'

function intakeLine(prompt: string): string {
  return `${JSON.stringify({
    schema_version: 1,
    id: 'rec-1',
    stream: { kind: 'session', id: 'ses_x' },
    sequence: 1,
    payload_type: 'runtime.command_intake.received',
    payload: {
      kind: 'command_intake',
      record: { kind: 'received', command_id: RUN, command: { kind: 'turn_submit', prompt } },
    },
  })}\n`
}

async function fixtureDataDir(): Promise<{
  dataDir: string
  logPath: string
  cleanup: () => Promise<void>
}> {
  const base = await mkdtemp(join(tmpdir(), 'muse-cli-tmux-'))
  const dir = join(base, 'sessions', '2026', '09', '18', 'ses_x')
  await mkdir(dir, { recursive: true })
  const logPath = join(dir, 'session.jsonl')
  await writeFile(logPath, '')
  return { dataDir: base, logPath, cleanup: () => rm(base, { recursive: true, force: true }) }
}

describe('discoverMuseSessionLog', () => {
  test('finds the single session log under the data dir', async () => {
    const { dataDir, logPath, cleanup } = await fixtureDataDir()
    try {
      expect(discoverMuseSessionLog(dataDir)).toBe(logPath)
    } finally {
      await cleanup()
    }
  })

  test('waits while the TUI has not booted yet', async () => {
    const base = await mkdtemp(join(tmpdir(), 'muse-cli-tmux-empty-'))
    try {
      expect(discoverMuseSessionLog(base)).toBeUndefined()
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test('sticky path wins once chosen', async () => {
    const { dataDir, logPath, cleanup } = await fixtureDataDir()
    try {
      expect(discoverMuseSessionLog(dataDir, logPath)).toBe(logPath)
    } finally {
      await cleanup()
    }
  })
})

describe('createMuseCliSessionTranscriptReader', () => {
  test('polls new lines into turn events', async () => {
    const { dataDir, logPath, cleanup } = await fixtureDataDir()
    try {
      const reader = createMuseCliSessionTranscriptReader({
        dataDir,
        normalizer: createMuseCliTmuxLogEventNormalizer({ invocationId: 'inv_t', now }),
      })
      expect(reader.poll()).toEqual([])
      await writeFile(logPath, intakeLine('hello reader'))
      const events = reader.poll()
      expect(events.filter((e) => e.type === 'turn.started')).toHaveLength(1)
      // No new bytes: no new events.
      expect(reader.poll()).toEqual([])
    } finally {
      await cleanup()
    }
  })
})
