#!/usr/bin/env bun
/**
 * T-07906 — replay a RECORDED broker event ledger through the codex-app-server
 * pane renderer, with no live session.
 *
 * The renderer's only input is the two-method `RendererDurableReadSurface`
 * (`eventsSince` + `observe`), and every real broker run already persists exactly
 * the envelope type it consumes at `var/run/hrc/bipc/<id>/events.ndjson`. So a
 * recorded ledger IS a renderer fixture: pointing the projection at a file
 * reproduces the pane that session produced, without booting a harness, without
 * waiting for someone to queue a message, and repeatably.
 *
 * It shares `createPaneOutput` with `renderer-entry.ts` rather than rebuilding the
 * wiring, so what you watch here is the pane, not a lookalike of it.
 *
 *   bun scripts/replay-broker-pane.ts --list
 *   bun scripts/replay-broker-pane.ts --bipc 9c8f03bd38ac | less -R
 *   bun scripts/replay-broker-pane.ts --bipc 9c8f03bd38ac --live --speed 20
 *   bun scripts/replay-broker-pane.ts --bipc 9c8f03bd38ac --only-queue --verbose
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { createPaneOutput } from '../harness/harness-broker/src/drivers/codex-app-server/pane-output'
import { createCodexAppServerRendererProjection } from '../harness/harness-broker/src/drivers/codex-app-server/renderer'

const BIPC_ROOT = join(homedir(), 'praesidium', 'var', 'run', 'hrc', 'bipc')

interface Args {
  ledger?: string
  invocationId?: string
  list: boolean
  live: boolean
  speed: number
  maxGapMs: number
  from: number
  to: number
  tail: number
  width?: number
  color?: boolean
  verbose: boolean
  onlyQueue: boolean
}

function usage(): never {
  process.stdout.write(
    [
      'replay-broker-pane — render a recorded broker ledger through the codex pane renderer',
      '',
      '  --list                 list recorded ledgers (id, events, driver, admissions)',
      '  --bipc <id>            replay ~/praesidium/var/run/hrc/bipc/<id>/events.ndjson',
      '  --ledger <path>        replay an events.ndjson directly',
      '  --invocation-id <id>   pick one invocation when the ledger holds several',
      '',
      '  --live                 drive the ephemeral footer (running row + queue drawer)',
      '  --speed <n>            live replay speed multiplier (default 10; 0 = no delay)',
      '  --max-gap <ms>         clamp idle gaps between events (default 1200)',
      '',
      '  --from <seq> --to <seq> --tail <n>   restrict the range',
      '  --only-queue           keep only admission/queue/submission + turn events',
      '  --width <n>  --color / --no-color  --verbose',
      '',
    ].join('\n')
  )
  process.exit(0)
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    list: false,
    live: false,
    speed: 10,
    maxGapMs: 1200,
    from: 0,
    to: Number.POSITIVE_INFINITY,
    tail: 0,
    verbose: false,
    onlyQueue: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    const take = (): string => {
      if (value === undefined) throw new Error(`${flag} requires a value`)
      i += 1
      return value
    }
    switch (flag) {
      case '--help':
      case '-h':
        usage()
        break
      case '--list':
        args.list = true
        break
      case '--bipc':
        args.ledger = join(BIPC_ROOT, take(), 'events.ndjson')
        break
      case '--ledger':
        args.ledger = take()
        break
      case '--invocation-id':
        args.invocationId = take()
        break
      case '--live':
        args.live = true
        break
      case '--speed':
        args.speed = Number(take())
        break
      case '--max-gap':
        args.maxGapMs = Number(take())
        break
      case '--from':
        args.from = Number(take())
        break
      case '--to':
        args.to = Number(take())
        break
      case '--tail':
        args.tail = Number(take())
        break
      case '--width':
        args.width = Number(take())
        break
      case '--color':
        args.color = true
        break
      case '--no-color':
        args.color = false
        break
      case '--verbose':
        args.verbose = true
        break
      case '--only-queue':
        args.onlyQueue = true
        break
      default:
        throw new Error(`unknown flag: ${flag}`)
    }
  }
  return args
}

function readLedger(path: string): InvocationEventEnvelope[] {
  const events: InvocationEventEnvelope[] = []
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const text = raw.trim()
    if (text.length === 0) continue
    try {
      events.push(JSON.parse(text) as InvocationEventEnvelope)
    } catch {
      // A torn trailing record is what the broker's own tail repair exists for;
      // a replay tool should skip it rather than refuse the whole session.
    }
  }
  return events.sort((a, b) => a.seq - b.seq)
}

function listLedgers(): void {
  const rows: string[][] = [['ledger', 'events', 'admissions', 'drivers', 'modified']]
  for (const id of readdirSync(BIPC_ROOT)) {
    const path = join(BIPC_ROOT, id, 'events.ndjson')
    let events: InvocationEventEnvelope[]
    try {
      if (statSync(path).size === 0) continue
      events = readLedger(path)
    } catch {
      continue
    }
    if (events.length === 0) continue
    const drivers = new Set(
      events.map((event) => event.driver?.kind).filter((kind): kind is string => kind !== undefined)
    )
    const admissions = events.filter((event) => event.type === 'admission.requested').length
    rows.push([
      id,
      String(events.length),
      String(admissions),
      [...drivers].join(',') || '—',
      new Date(statSync(path).mtimeMs).toISOString().slice(0, 16).replace('T', ' '),
    ])
  }
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length))
  )
  for (const row of rows) {
    process.stdout.write(
      `${row.map((cell, column) => cell.padEnd(widths?.[column] ?? 0)).join('  ')}\n`
    )
  }
}

/** The families a queue-focused replay keeps, plus enough turn flow to read it. */
const QUEUE_PREFIXES = ['admission.', 'queue.', 'submission.', 'input.', 'interrupt.']
const QUEUE_KEEP = new Set([
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'user.message',
  'invocation.ready',
  'invocation.exited',
])

function selectEvents(all: InvocationEventEnvelope[], args: Args): InvocationEventEnvelope[] {
  let events = all.filter((event) => event.seq >= args.from && event.seq <= args.to)
  if (args.onlyQueue) {
    events = events.filter(
      (event) =>
        QUEUE_PREFIXES.some((prefix) => event.type.startsWith(prefix)) || QUEUE_KEEP.has(event.type)
    )
  }
  if (args.tail > 0) events = events.slice(-args.tail)
  return events
}

function resolveInvocationId(events: InvocationEventEnvelope[], requested?: string): string {
  const ids = [...new Set(events.map((event) => event.invocationId))]
  if (requested !== undefined) return requested
  const only = ids[0]
  if (only === undefined) throw new Error('ledger holds no events')
  if (ids.length > 1) {
    throw new Error(
      `ledger holds ${ids.length} invocations; pass --invocation-id (${ids.join(', ')})`
    )
  }
  return only
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.list) {
    listLedgers()
    return
  }
  if (args.ledger === undefined) usage()

  const all = readLedger(args.ledger)
  const events = selectEvents(all, args)
  const invocationId = resolveInvocationId(all, args.invocationId)
  const isTty = process.stdout.isTTY === true
  const color = args.color ?? (process.env['NO_COLOR'] === undefined && isTty)
  const width = args.width ?? (isTty ? undefined : 120)

  if (!args.live) {
    // Static: the committed transcript exactly as scrollback would hold it, with no
    // footer at all. This is the diffable artifact — the same ledger through two
    // renderer revisions produces two files you can put side by side.
    const projection = createCodexAppServerRendererProjection({
      invocationId,
      readSurface: {
        eventsSince: async () => ({ events, currentSeq: events.at(-1)?.seq ?? 0 }),
        observe: () => ({ close: () => {} }),
      },
      color,
      ...(width !== undefined ? { width } : {}),
      verbose: args.verbose,
    })
    await projection.start()
    process.stdout.write(`${projection.lines().join('\n')}\n`)
    return
  }

  // Live: re-timed delivery through the real ephemeral footer, so the running row
  // animates and the queue drawer fills and drains the way it will in the pane.
  // The drawer's clock is the RECORDED timeline, not wall-clock — otherwise every
  // entry would render as however long ago the session happened.
  let virtualNow = Date.parse(events[0]?.time ?? '') || Date.now()
  const pane = createPaneOutput({
    write: (chunk) => process.stdout.write(chunk),
    enabled: isTty,
    color,
    ...(width !== undefined ? { width } : {}),
    height: () => process.stdout.rows,
    now: () => virtualNow,
  })

  let deliver: ((event: InvocationEventEnvelope) => void) | undefined
  const projection = createCodexAppServerRendererProjection({
    invocationId,
    readSurface: {
      eventsSince: async () => ({ events: [], currentSeq: 0 }),
      observe: (handler) => {
        deliver = handler
        return { close: () => {} }
      },
    },
    sink: pane.sink,
    onEvent: pane.onEvent,
    color,
    ...(width !== undefined ? { width } : {}),
    verbose: args.verbose,
  })
  await projection.start()

  try {
    let previousMs: number | undefined
    for (const event of events) {
      const eventMs = Date.parse(event.time)
      if (previousMs !== undefined && Number.isFinite(eventMs) && args.speed > 0) {
        await sleep(Math.min(args.maxGapMs, (eventMs - previousMs) / args.speed))
      }
      if (Number.isFinite(eventMs)) {
        virtualNow = eventMs
        previousMs = eventMs
      }
      deliver?.(event)
    }
    // Hold the final frame briefly so a drawer still holding entries at the end of
    // the recording is actually visible before the footer is torn down.
    if (isTty && args.speed > 0) await sleep(1500)
  } finally {
    pane.dispose()
    projection.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
