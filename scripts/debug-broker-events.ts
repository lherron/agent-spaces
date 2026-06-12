#!/usr/bin/env bun
import type {
  InvocationEventEnvelope,
  InvocationId,
  InvocationInspectionSummary,
} from 'spaces-harness-broker-protocol'

import { BrokerClient } from '../packages/harness-broker-client/src/index.js'
import { formatBrokerEventLogLine } from './lib/broker-event-render.js'

type Args = {
  socketPath: string
  invocationId?: InvocationId | undefined
  afterSeq: number
  follow: boolean
  replay: boolean
  waitMs: number
  includeDisposed: boolean
  raw: boolean
}

const TERMINAL_STATES = new Set(['exited', 'failed', 'disposed'])

function parseArgs(argv: string[]): Args {
  const args: Args = {
    socketPath: '',
    afterSeq: 0,
    follow: true,
    replay: true,
    waitMs: 30_000,
    includeDisposed: false,
    raw: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = argv[i + 1]
    switch (arg) {
      case '--socket':
        args.socketPath = readValue(value, arg)
        i += 1
        break
      case '--invocation-id':
        args.invocationId = readValue(value, arg)
        i += 1
        break
      case '--after-seq':
        args.afterSeq = parseInteger(readValue(value, arg), arg)
        i += 1
        break
      case '--no-follow':
        args.follow = false
        break
      case '--no-replay':
        args.replay = false
        break
      case '--wait-ms':
        args.waitMs = parseInteger(readValue(value, arg), arg)
        i += 1
        break
      case '--include-disposed':
        args.includeDisposed = true
        break
      case '--raw':
        args.raw = true
        break
      case '--help':
        printUsage()
        process.exit(0)
        break
      case '-h':
        printUsage()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (args.socketPath.length === 0) {
    throw new Error('Missing --socket <path>')
  }
  return args
}

function readValue(value: string | undefined, flag: string): string {
  if (value === undefined || value.length === 0) throw new Error(`Missing value for ${flag}`)
  return value
}

function parseInteger(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`)
  }
  return parsed
}

function printUsage(): void {
  console.log(
    [
      'Broker event observer for an experimental harness-broker observer socket.',
      '',
      'Usage:',
      '  bun scripts/debug-broker-events.ts --socket <path> [options]',
      '',
      'Options:',
      '  --invocation-id <id>   Invocation to render. Defaults to newest non-terminal invocation.',
      '  --after-seq <n>        Replay events after this seq (default: 0).',
      '  --no-follow           Replay current events and exit.',
      '  --no-replay           Do not call invocation.eventsSince before following.',
      '  --wait-ms <n>         Wait for an invocation to appear when none exists (default: 30000).',
      '  --include-disposed    Include disposed invocations when selecting latest.',
      '  --raw                 Print raw InvocationEventEnvelope JSONL.',
      '  --help                Show this message.',
    ].join('\n')
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const client = await BrokerClient.connectUnix({ socketPath: args.socketPath, timeoutMs: 2000 })
  let closed = false

  process.once('SIGINT', () => {
    closed = true
    void client.close().catch(() => undefined)
  })

  try {
    const hello = await client.hello({
      clientInfo: { name: 'debug-broker-events', version: '0.1.0' },
      protocolVersions: ['harness-broker/0.2'],
      capabilities: { permissionRequests: false },
    })
    console.error(
      `connected: ${hello.brokerInfo.name} ${hello.brokerInfo.version} protocol=${hello.protocolVersion}`
    )

    const invocationId =
      args.invocationId ??
      (await waitForLatestInvocation(client, {
        includeDisposed: args.includeDisposed,
        waitMs: args.waitMs,
      }))
    console.error(`invocation: ${invocationId}`)

    const liveEvents = args.follow ? client.streamInvocationEvents(invocationId) : undefined
    let lastRenderedSeq = args.afterSeq

    if (args.replay) {
      const replay = await client.eventsSince({ invocationId, afterSeq: args.afterSeq })
      for (const event of replay.events) {
        renderEvent(event, args.raw)
      }
      lastRenderedSeq = Math.max(lastRenderedSeq, replay.currentSeq)
      console.error(
        `replayed: ${replay.events.length} event(s), currentSeq=${replay.currentSeq}, retentionFloorSeq=${replay.retentionFloorSeq}`
      )
    }

    if (!args.follow || liveEvents === undefined) {
      await client.close()
      return
    }

    console.error('following live events; press Ctrl-C to stop')
    for await (const event of liveEvents) {
      if (closed) break
      if (event.seq <= lastRenderedSeq) continue
      renderEvent(event, args.raw)
      lastRenderedSeq = event.seq
    }
  } finally {
    await client.close().catch(() => undefined)
  }
}

async function waitForLatestInvocation(
  client: BrokerClient,
  options: { includeDisposed: boolean; waitMs: number }
): Promise<InvocationId> {
  const deadline = Date.now() + options.waitMs
  while (true) {
    const response = await client.listInvocations({ includeDisposed: options.includeDisposed })
    const selected = selectLatestInvocation(response.invocations)
    if (selected !== undefined) return selected.invocationId
    if (Date.now() >= deadline) {
      throw new Error(`No broker invocation found after ${options.waitMs}ms`)
    }
    await sleep(250)
  }
}

function selectLatestInvocation(
  invocations: InvocationInspectionSummary[]
): InvocationInspectionSummary | undefined {
  const active = invocations.filter((invocation) => !TERMINAL_STATES.has(invocation.state))
  const candidates = active.length > 0 ? active : invocations
  return candidates
    .slice()
    .sort((a, b) => timestampMs(b.lastActivityAt) - timestampMs(a.lastActivityAt))[0]
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function renderEvent(event: InvocationEventEnvelope, raw: boolean): void {
  if (raw) {
    console.log(JSON.stringify(event))
  } else {
    console.log(formatBrokerEventLogLine(event))
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
