/** Start a broker observing one Claude Desktop session transcript. */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationId,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../../../src/broker'
import {
  type ClaudeDesktopDriverOptions,
  createClaudeDesktopDriver,
} from '../../../src/drivers/claude-desktop/driver'
import type { EventLedger } from '../../../src/event-ledger'
import { DESKTOP_SESSION_ID } from './desktop-rows'

const cleanups: Array<() => void> = []

export function removeTempDirs(): void {
  while (cleanups.length > 0) cleanups.pop()?.()
}

export const DESKTOP_CWD = '/Users/example/project'

/** A fake `~/.claude` with the session's transcript path under `projects/`. */
export function claudeHome(): {
  home: string
  transcript: string
  write: (rows: string) => void
  append: (rows: string) => void
} {
  const home = join(tmpdir(), `claude-desktop-${crypto.randomUUID()}`)
  const dir = join(home, 'projects', '-Users-example-project')
  mkdirSync(dir, { recursive: true })
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const transcript = join(dir, `${DESKTOP_SESSION_ID}.jsonl`)
  return {
    home,
    transcript,
    write: (rows) => writeFileSync(transcript, rows),
    append: (rows) => appendFileSync(transcript, rows),
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for observer')
    await Bun.sleep(10)
  }
}

export function desktopSpec(invocationId: string): HarnessInvocationSpec {
  return {
    specVersion: 'harness-broker.invocation/v1',
    invocationId: invocationId as InvocationId,
    harness: { frontend: 'claude-desktop', provider: 'anthropic', driver: 'claude-desktop' },
    process: {
      command: 'external-claude-desktop',
      args: [],
      cwd: DESKTOP_CWD,
      lockedEnv: {},
      harnessTransport: { kind: 'pipes' },
    },
    interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'fifo' },
    driver: { kind: 'claude-desktop', sessionId: DESKTOP_SESSION_ID },
  }
}

/** A broker with only the claude-desktop driver, polling fast and recording every event. */
export function desktopBroker(options: {
  claudeHome: string
  captureDir?: string | undefined
  eventLedger?: EventLedger | undefined
  driver?: Partial<ClaudeDesktopDriverOptions> | undefined
}) {
  const events: InvocationEventEnvelope[] = []
  const broker = createBroker({
    drivers: [
      createClaudeDesktopDriver({
        sessionId: DESKTOP_SESSION_ID,
        claudeHome: options.claudeHome,
        pollIntervalMs: 10,
        watchTranscript: false,
        hookSocketPath: false,
        ...options.driver,
      }),
    ],
    onEvent: (event) => events.push(event),
    ...(options.captureDir !== undefined ? { captureDir: options.captureDir } : {}),
    ...(options.eventLedger !== undefined ? { eventLedger: options.eventLedger } : {}),
  })
  return { broker, events }
}

export function ofType(
  events: InvocationEventEnvelope[],
  type: string,
  turnId?: string
): InvocationEventEnvelope[] {
  return events.filter(
    (event) => event.type === type && (turnId === undefined || event.turnId === turnId)
  )
}

/** The turn-level story of a stream: one line per bracket/content event. */
export function story(events: InvocationEventEnvelope[]): string[] {
  const keep = new Set([
    'turn.started',
    'turn.attributed',
    'user.message',
    'submission.absorbed',
    'tool.call.started',
    'tool.call.completed',
    'assistant.message.completed',
    'turn.completed',
    'turn.failed',
    'turn.interrupted',
  ])
  return events
    .filter((event) => keep.has(event.type))
    .map((event) => {
      const payload = event.payload as Record<string, unknown>
      const detail =
        event.type === 'user.message'
          ? ` ${JSON.stringify(payload['content'])}`
          : event.type === 'assistant.message.completed'
            ? ` ${JSON.stringify((payload['content'] as Array<{ text: string }>)[0]?.text)} final=${String(payload['final'])}`
            : event.type === 'turn.attributed'
              ? ` ${String(payload['ownership'])}/${String(payload['origin'])}`
              : ''
      return `${event.turnId ?? '-'} ${event.type}${detail}`
    })
}
