/** Start a broker observing one codex-desktop rollout, plus a scriptable native queue. */
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationId,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../../../src/broker'
import { createCodexDesktopDriver } from '../../../src/drivers/codex-desktop/driver'
import type { CodexDesktopDriverOptions } from '../../../src/drivers/codex-desktop/driver'
import type { CodexDesktopQueueHelper } from '../../../src/drivers/codex-desktop/queue-helper'
import type { EventLedger } from '../../../src/event-ledger'

const cleanups: Array<() => void> = []

/** Register with `afterEach` in each test file that calls `tempDir`. */
export function removeTempDirs(): void {
  while (cleanups.length > 0) cleanups.pop()?.()
}

export function tempDir(): string {
  const path = join(tmpdir(), `codex-desktop-${crypto.randomUUID()}`)
  mkdirSync(path, { recursive: true })
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for observer')
    await Bun.sleep(10)
  }
}

export function spec(
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

export function withDriver(
  base: HarnessInvocationSpec,
  extra: Record<string, unknown>
): HarnessInvocationSpec {
  return { ...base, driver: { ...base.driver, ...extra } }
}

/** A broker with only the codex-desktop driver, polling fast and recording every event. */
export function observerBroker(options: {
  captureDir: string
  driver?: CodexDesktopDriverOptions
  eventLedger?: EventLedger
}) {
  const events: InvocationEventEnvelope[] = []
  const broker = createBroker({
    drivers: [
      createCodexDesktopDriver({ watchFile: false, pollIntervalMs: 10, ...options.driver }),
    ],
    onEvent: (event) => events.push(event),
    captureDir: options.captureDir,
    ...(options.eventLedger !== undefined ? { eventLedger: options.eventLedger } : {}),
  })
  return { broker, events }
}

export type NativeQueueRow = { id: string; clientUserMessageId: string }

/** In-memory native queue that records every add and delete the driver issues. */
export function queueHarness() {
  const queue: NativeQueueRow[] = []
  const adds: string[] = []
  const deletes: string[] = []
  const openQueueHelper = async (): Promise<CodexDesktopQueueHelper> => ({
    async list() {
      return { data: [...queue], nextCursor: null }
    },
    async add(_threadId, _input, clientUserMessageId) {
      adds.push(clientUserMessageId)
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

export function noticeData(events: InvocationEventEnvelope[], code: string): unknown {
  const notice = events.find(
    (event) => event.type === 'driver.notice' && event.payload.code === code
  )
  return notice?.type === 'driver.notice' ? notice.payload.data : undefined
}
