/**
 * RED/GREEN acceptance tests for HRC Slice 1A (T-00958)
 *
 * These are the gatekeeper acceptance tests for Slice 1A. They exercise the
 * full vertical stack — server, SDK client, CLI — through real Unix sockets
 * with real SQLite persistence. No mocks.
 *
 * Acceptance criteria from HRC_IMPLEMENTATION_PLAN.md Phase 1 Slice 1A:
 *
 *   AC-1: `hrc server` starts, migrates the DB, acquires the single-instance
 *         lock, and exposes the foundation endpoints.
 *   AC-2: `hrc session resolve` creates continuity/session on first resolve
 *         and returns same hostSessionId with created=false on repeat resolve.
 *   AC-3: `hrc watch` replays from seq and follows live events as NDJSON.
 *   AC-4: Spool replay runs on daemon startup.
 *
 * Pass conditions (Smokey → Curly/Larry):
 *   1. createHrcServer starts, binds socket, creates lock with PID, migrates DB
 *   2. HrcClient.resolveSession creates session (created=true, generation=1) on
 *      first call; returns same hostSessionId with created=false on second call
 *   3. HrcClient.watch yields HrcEventEnvelopes with monotonic seq; fromSeq
 *      filters correctly; follow mode delivers live events
 *   4. Spooled wrapper-started callback is replayed on restart and appears in
 *      the event stream with replayed=true
 *   5. CLI `hrc session resolve`, `hrc session list`, `hrc watch` produce
 *      correct JSON output via subprocess execution
 *
 * Reference: T-00946 (parent), T-00958 (this validation task)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcEventEnvelope } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'

// RED GATE: These imports require the full stack to be wired up.
// hrc-server: createHrcServer must exist and export HrcServer + HrcServerOptions
// hrc-sdk: HrcClient must connect over a real Unix socket
import { createHrcServer } from 'hrc-server'
import type { HrcServer, HrcServerOptions } from 'hrc-server'

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let server: HrcServer | null = null

function opts(overrides: Partial<HrcServerOptions> = {}): HrcServerOptions {
  return {
    runtimeRoot,
    stateRoot,
    socketPath,
    lockPath,
    spoolDir,
    dbPath,
    ...overrides,
  }
}

function client(): HrcClient {
  return new HrcClient(socketPath)
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-accept-'))
  runtimeRoot = join(tmpDir, 'runtime')
  stateRoot = join(tmpDir, 'state')
  socketPath = join(runtimeRoot, 'hrc.sock')
  lockPath = join(runtimeRoot, 'server.lock')
  spoolDir = join(runtimeRoot, 'spool')
  dbPath = join(stateRoot, 'state.sqlite')

  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  await mkdir(spoolDir, { recursive: true })
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = null
  }
  await rm(tmpDir, { recursive: true, force: true })
})

// ===========================================================================
// AC-1: Server startup, migration, lock, foundation endpoints
// ===========================================================================
describe('AC-1: hrc server starts, migrates DB, acquires lock, exposes endpoints', () => {
  it('binds a Unix socket and creates a lock file with current PID', async () => {
    server = await createHrcServer(opts())

    // Socket must exist
    const sockStat = await stat(socketPath).catch(() => null)
    expect(sockStat).not.toBeNull()
    expect(sockStat!.isSocket()).toBe(true)

    // Lock must contain current PID in JSON format (C-1 atomic lock)
    const lockContent = await readFile(lockPath, 'utf-8')
    const lockData = JSON.parse(lockContent)
    expect(lockData.pid).toBe(process.pid)
    expect(lockData.createdAt).toBeDefined()
  })

  it('migrates the DB so that session endpoints respond', async () => {
    server = await createHrcServer(opts())
    const c = client()

    // GET /v1/sessions should work (proves DB is migrated and server is listening)
    const sessions = await c.listSessions()
    expect(Array.isArray(sessions)).toBe(true)
    expect(sessions.length).toBe(0)
  })

  it('rejects a second daemon when the lock is held by a live process', async () => {
    server = await createHrcServer(opts())
    await expect(createHrcServer(opts())).rejects.toThrow(/already running|lock/i)
  })

  it('cleans up a stale lock from a dead process and starts', async () => {
    // Simulate a stale lock from a dead PID
    const deadPid = 2147483647
    await writeFile(lockPath, String(deadPid), 'utf-8')
    await writeFile(socketPath, '', 'utf-8') // fake stale socket

    server = await createHrcServer(opts())
    const c = client()
    const sessions = await c.listSessions()
    expect(Array.isArray(sessions)).toBe(true)
  })
})

// ===========================================================================
// AC-2: Session resolve — continuity creation and reuse
// ===========================================================================
describe('AC-2: session resolve creates continuity on first call, reuses on repeat', () => {
  beforeEach(async () => {
    server = await createHrcServer(opts())
  })

  it('creates a new session with created=true and generation=1 on first resolve', async () => {
    const c = client()
    const result = await c.resolveSession({
      sessionRef: 'project:acceptance/lane:default',
    })

    expect(result.created).toBe(true)
    expect(result.generation).toBe(1)
    expect(result.hostSessionId).toBeString()
    expect(result.hostSessionId.length).toBeGreaterThan(0)
    expect(result.session).toBeDefined()
    expect(result.session.scopeRef).toBe('project:acceptance')
    expect(result.session.laneRef).toBe('default')
    expect(result.session.status).toBe('active')
  })

  it('returns same hostSessionId with created=false on repeat resolve', async () => {
    const c = client()
    const sessionRef = 'project:acceptance/lane:default'

    const first = await c.resolveSession({ sessionRef })
    expect(first.created).toBe(true)

    const second = await c.resolveSession({ sessionRef })
    expect(second.created).toBe(false)
    expect(second.hostSessionId).toBe(first.hostSessionId)
    expect(second.generation).toBe(first.generation)
  })

  it('creates independent continuities for different sessionRefs', async () => {
    const c = client()

    const a = await c.resolveSession({
      sessionRef: 'project:alpha/lane:default',
    })
    const b = await c.resolveSession({
      sessionRef: 'project:beta/lane:default',
    })

    expect(a.hostSessionId).not.toBe(b.hostSessionId)
    expect(a.created).toBe(true)
    expect(b.created).toBe(true)
  })

  it('session is retrievable via getSession after resolve', async () => {
    const c = client()
    const resolved = await c.resolveSession({
      sessionRef: 'project:gettest/lane:main',
    })

    const session = await c.getSession(resolved.hostSessionId)
    expect(session.hostSessionId).toBe(resolved.hostSessionId)
    expect(session.scopeRef).toBe('project:gettest')
    expect(session.laneRef).toBe('main')
  })

  it('session appears in listSessions filtered by scopeRef', async () => {
    const c = client()
    await c.resolveSession({ sessionRef: 'project:listA/lane:default' })
    await c.resolveSession({ sessionRef: 'project:listB/lane:default' })

    const all = await c.listSessions()
    expect(all.length).toBe(2)

    const filtered = await c.listSessions({ scopeRef: 'project:listA' })
    expect(filtered.length).toBe(1)
    expect(filtered[0]!.scopeRef).toBe('project:listA')
  })
})

// ===========================================================================
// AC-3: Watch — replay from seq and follow live events as NDJSON
// ===========================================================================
describe('AC-3: hrc watch replays from seq and follows live events as NDJSON', () => {
  beforeEach(async () => {
    server = await createHrcServer(opts())
  })

  it('yields no events when the database is empty', async () => {
    const c = client()
    const events: HrcEventEnvelope[] = []
    for await (const ev of c.watch()) {
      events.push(ev)
    }
    expect(events.length).toBe(0)
  })

  it('replays events with monotonically increasing seq', async () => {
    const c = client()

    // Generate events via session resolve
    await c.resolveSession({ sessionRef: 'project:watch1/lane:default' })
    await c.resolveSession({ sessionRef: 'project:watch2/lane:default' })

    const events: HrcEventEnvelope[] = []
    for await (const ev of c.watch()) {
      events.push(ev)
    }

    expect(events.length).toBeGreaterThanOrEqual(2)

    // Verify monotonic seq
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq)
    }
  })

  it('respects fromSeq to skip earlier events', async () => {
    const c = client()

    await c.resolveSession({ sessionRef: 'project:fromseq1/lane:default' })
    await c.resolveSession({ sessionRef: 'project:fromseq2/lane:default' })
    await c.resolveSession({ sessionRef: 'project:fromseq3/lane:default' })

    // Get all events first
    const allEvents: HrcEventEnvelope[] = []
    for await (const ev of c.watch()) {
      allEvents.push(ev)
    }
    expect(allEvents.length).toBeGreaterThanOrEqual(3)

    // Now replay from the second event's seq
    const fromSeq = allEvents[1]!.seq
    const filtered: HrcEventEnvelope[] = []
    for await (const ev of c.watch({ fromSeq })) {
      filtered.push(ev)
    }

    // All filtered events must have seq >= fromSeq
    for (const ev of filtered) {
      expect(ev.seq).toBeGreaterThanOrEqual(fromSeq)
    }
    expect(filtered.length).toBeLessThan(allEvents.length)
  })

  it('follow mode delivers live events as they are created', async () => {
    const c = client()

    // Start watching in follow mode
    const liveEvents: HrcEventEnvelope[] = []
    const controller = new AbortController()

    // We need to consume the async iterable in the background
    const watchPromise = (async () => {
      try {
        for await (const ev of c.watch({ follow: true })) {
          liveEvents.push(ev)
          // After receiving at least one event, abort
          if (liveEvents.length >= 1) {
            controller.abort()
            break
          }
        }
      } catch (err: unknown) {
        // AbortError is expected
        if (err instanceof Error && err.name !== 'AbortError') throw err
      }
    })()

    // Give the watch stream time to connect
    await new Promise((r) => setTimeout(r, 100))

    // Create a session to emit a live event
    await c.resolveSession({ sessionRef: 'project:live-follow/lane:default' })

    // Wait for the watch to complete (with timeout)
    await Promise.race([watchPromise, new Promise((r) => setTimeout(r, 2000))])

    expect(liveEvents.length).toBeGreaterThanOrEqual(1)
    // The live event should have a seq and an eventKind
    expect(liveEvents[0]!.seq).toBeGreaterThanOrEqual(1)
    expect(typeof liveEvents[0]!.eventKind).toBe('string')
  })

  it('each event envelope has required HrcEventEnvelope fields', async () => {
    const c = client()
    await c.resolveSession({ sessionRef: 'project:envelope/lane:default' })

    const events: HrcEventEnvelope[] = []
    for await (const ev of c.watch()) {
      events.push(ev)
    }

    expect(events.length).toBeGreaterThanOrEqual(1)
    const ev = events[0]!
    // Required HrcEventEnvelope fields per hrc-core contracts
    expect(typeof ev.seq).toBe('number')
    expect(typeof ev.ts).toBe('string')
    expect(typeof ev.hostSessionId).toBe('string')
    expect(typeof ev.scopeRef).toBe('string')
    expect(typeof ev.laneRef).toBe('string')
    expect(typeof ev.generation).toBe('number')
    expect(typeof ev.source).toBe('string')
    expect(typeof ev.eventKind).toBe('string')
    expect(ev.eventJson).toBeDefined()
  })
})

// ===========================================================================
// AC-4: Spool replay runs on daemon startup
// ===========================================================================
describe('AC-4: spool replay runs on daemon startup', () => {
  it('replays a spooled wrapper-started callback on restart', async () => {
    // Phase 1: Start server, create a session, then stop
    server = await createHrcServer(opts())
    const c1 = client()
    const resolved = await c1.resolveSession({
      sessionRef: 'project:spool-test/lane:default',
    })
    const hostSessionId = resolved.hostSessionId
    await server.stop()
    server = null

    // Phase 2: Manually create spool entries (simulating hrc-launch spooling
    // when the daemon was unavailable)
    const launchId = `spool-launch-${Date.now()}`
    const launchSpoolDir = join(spoolDir, launchId)
    await mkdir(launchSpoolDir, { recursive: true })

    await writeFile(
      join(launchSpoolDir, '000001.json'),
      JSON.stringify({
        endpoint: `/v1/internal/launches/${launchId}/wrapper-started`,
        payload: {
          hostSessionId,
          wrapperPid: 88888,
          timestamp: new Date().toISOString(),
        },
      }),
      'utf-8'
    )

    // Phase 3: Restart server — spool should be replayed
    server = await createHrcServer(opts())
    const c2 = client()

    // Check events include the replayed launch event
    const events: HrcEventEnvelope[] = []
    for await (const ev of c2.watch()) {
      events.push(ev)
    }

    // Should have: session.created (from phase 1) + launch.wrapper_started (replayed)
    expect(events.length).toBeGreaterThanOrEqual(2)

    const replayedEvent = events.find(
      (e) =>
        e.eventKind === 'launch.wrapper_started' &&
        (e.eventJson as Record<string, unknown>)?.['replayed'] === true
    )
    expect(replayedEvent).toBeDefined()
    expect((replayedEvent!.eventJson as Record<string, unknown>)['launchId']).toBe(launchId)
    expect((replayedEvent!.eventJson as Record<string, unknown>)['wrapperPid']).toBe(88888)
  })

  it('spool directory is cleaned up after successful replay', async () => {
    // Create a session first
    server = await createHrcServer(opts())
    const c1 = client()
    const resolved = await c1.resolveSession({
      sessionRef: 'project:spool-cleanup/lane:default',
    })
    await server.stop()
    server = null

    // Create spool
    const launchId = `cleanup-launch-${Date.now()}`
    const launchSpoolDir = join(spoolDir, launchId)
    await mkdir(launchSpoolDir, { recursive: true })
    await writeFile(
      join(launchSpoolDir, '000001.json'),
      JSON.stringify({
        endpoint: `/v1/internal/launches/${launchId}/wrapper-started`,
        payload: {
          hostSessionId: resolved.hostSessionId,
          wrapperPid: 77777,
          timestamp: new Date().toISOString(),
        },
      }),
      'utf-8'
    )

    // Restart — spool should be consumed and cleaned
    server = await createHrcServer(opts())

    // The per-launch spool dir should be removed after replay
    const spoolDirStat = await stat(launchSpoolDir).catch(() => null)
    expect(spoolDirStat).toBeNull()
  })

  it('replays multiple spool entries in order', async () => {
    server = await createHrcServer(opts())
    const c1 = client()
    const resolved = await c1.resolveSession({
      sessionRef: 'project:spool-multi/lane:default',
    })
    const hostSessionId = resolved.hostSessionId
    await server.stop()
    server = null

    const launchId = `multi-launch-${Date.now()}`
    const launchSpoolDir = join(spoolDir, launchId)
    await mkdir(launchSpoolDir, { recursive: true })

    // Spool wrapper-started then child-started then exited
    await writeFile(
      join(launchSpoolDir, '000001.json'),
      JSON.stringify({
        endpoint: `/v1/internal/launches/${launchId}/wrapper-started`,
        payload: { hostSessionId, wrapperPid: 10001, timestamp: new Date().toISOString() },
      }),
      'utf-8'
    )
    await writeFile(
      join(launchSpoolDir, '000002.json'),
      JSON.stringify({
        endpoint: `/v1/internal/launches/${launchId}/child-started`,
        payload: { hostSessionId, childPid: 10002, timestamp: new Date().toISOString() },
      }),
      'utf-8'
    )
    await writeFile(
      join(launchSpoolDir, '000003.json'),
      JSON.stringify({
        endpoint: `/v1/internal/launches/${launchId}/exited`,
        payload: { hostSessionId, exitCode: 0, timestamp: new Date().toISOString() },
      }),
      'utf-8'
    )

    // Restart server — all three should be replayed in order
    server = await createHrcServer(opts())
    const c2 = client()

    const events: HrcEventEnvelope[] = []
    for await (const ev of c2.watch()) {
      events.push(ev)
    }

    const launchEvents = events.filter((e) => e.eventKind.startsWith('launch.'))
    expect(launchEvents.length).toBe(3)

    // Verify order: wrapper_started < child_started < exited
    expect(launchEvents[0]!.eventKind).toBe('launch.wrapper_started')
    expect(launchEvents[1]!.eventKind).toBe('launch.child_started')
    expect(launchEvents[2]!.eventKind).toBe('launch.exited')

    // Verify monotonic seq across replayed events
    for (let i = 1; i < launchEvents.length; i++) {
      expect(launchEvents[i]!.seq).toBeGreaterThan(launchEvents[i - 1]!.seq)
    }
  })
})
