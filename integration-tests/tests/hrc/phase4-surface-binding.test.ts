/**
 * Phase 4 surface binding integration tests (T-00970)
 *
 * End-to-end coverage using real HRC server instances (createHrcServer):
 *   1. Bind a surface, verify it persists across daemon restart
 *   2. Bind to runtime A, rebind same surface to runtime B → surface.rebound event
 *   3. Clear-context invalidates old surfaces → fresh bind on new context
 *   4. Unbind → verify surface.unbound event
 *   5. List surfaces for a runtime
 *
 * All tests seed SDK runtimes directly into the DB (no tmux fork).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcEventEnvelope } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'
import { createHrcServer } from 'hrc-server'
import type { HrcServer, HrcServerOptions } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'

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
let tmuxSocketPath: string
let server: HrcServer | null = null

function serverOpts(overrides: Partial<HrcServerOptions> = {}): HrcServerOptions {
  return {
    runtimeRoot,
    stateRoot,
    socketPath,
    lockPath,
    spoolDir,
    dbPath,
    tmuxSocketPath,
    ...overrides,
  }
}

function client(): HrcClient {
  return new HrcClient(socketPath)
}

function ts(): string {
  return new Date().toISOString()
}

/**
 * Resolve a session via the server, then seed an SDK runtime directly into the
 * database — avoids tmux fork which fails in this environment.
 */
async function seedRuntime(
  c: HrcClient,
  scopeRef: string
): Promise<{ hostSessionId: string; runtimeId: string; generation: number }> {
  const sessionRef = scopeRef.includes('/lane:') ? scopeRef : `${scopeRef}/lane:default`
  const resolved = await c.resolveSession({ sessionRef })

  const runtimeId = `rt-test-${randomUUID()}`
  const now = ts()
  const db = openHrcDatabase(dbPath)
  db.runtimes.insert({
    runtimeId,
    hostSessionId: resolved.hostSessionId,
    scopeRef: scopeRef.replace(/\/lane:.*$/, ''),
    laneRef: 'default',
    generation: resolved.generation,
    transport: 'sdk',
    harness: 'agent-sdk',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    createdAt: now,
    updatedAt: now,
  })

  return {
    hostSessionId: resolved.hostSessionId,
    runtimeId,
    generation: resolved.generation,
  }
}

/** Fetch all events from the non-follow stream. */
async function fetchEvents(c: HrcClient): Promise<HrcEventEnvelope[]> {
  const events: HrcEventEnvelope[] = []
  for await (const ev of c.watch()) {
    events.push(ev)
  }
  return events
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-phase4-'))
  runtimeRoot = join(tmpDir, 'runtime')
  stateRoot = join(tmpDir, 'state')
  socketPath = join(runtimeRoot, 'hrc.sock')
  lockPath = join(runtimeRoot, 'server.lock')
  spoolDir = join(runtimeRoot, 'spool')
  dbPath = join(stateRoot, 'state.sqlite')
  tmuxSocketPath = join(runtimeRoot, 'tmux.sock')

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
// 1. Bind surface — persists across daemon restart
// ===========================================================================
describe('Surface binding restart persistence', () => {
  it('binding survives daemon stop and restart', async () => {
    server = await createHrcServer(serverOpts())
    const c = client()
    const { hostSessionId, runtimeId, generation } = await seedRuntime(c, 'project:restart-persist')

    // Bind a surface
    const bound = await c.bindSurface({
      surfaceKind: 'ghostty',
      surfaceId: 'persist-surf-1',
      runtimeId,
      hostSessionId,
      generation,
    })
    expect(bound.surfaceKind).toBe('ghostty')
    expect(bound.surfaceId).toBe('persist-surf-1')
    expect(bound.runtimeId).toBe(runtimeId)
    expect(bound.boundAt).toBeString()
    expect(bound.unboundAt).toBeUndefined()

    // Stop the server
    await server.stop()
    server = null

    // Restart with same DB
    server = await createHrcServer(serverOpts())
    const c2 = client()

    // Query — binding must still be present
    const surfaces = await c2.listSurfaces({ runtimeId })
    expect(surfaces.length).toBe(1)
    expect(surfaces[0]!.surfaceKind).toBe('ghostty')
    expect(surfaces[0]!.surfaceId).toBe('persist-surf-1')
    expect(surfaces[0]!.runtimeId).toBe(runtimeId)
    expect(surfaces[0]!.hostSessionId).toBe(hostSessionId)
    expect(surfaces[0]!.generation).toBe(generation)
  })
})

// ===========================================================================
// 2. Rebind — bind to runtime A, then runtime B → surface.rebound event
// ===========================================================================
describe('Surface rebind across runtimes', () => {
  it('rebinding same surface to different runtime emits surface.rebound', async () => {
    server = await createHrcServer(serverOpts())
    const c = client()

    // Create two separate runtimes
    const rtA = await seedRuntime(c, 'project:rebind-a')
    const rtB = await seedRuntime(c, 'project:rebind-b')

    const surfaceKind = 'ghostty'
    const surfaceId = 'rebind-surf-1'

    // Bind to runtime A
    const boundA = await c.bindSurface({
      surfaceKind,
      surfaceId,
      runtimeId: rtA.runtimeId,
      hostSessionId: rtA.hostSessionId,
      generation: rtA.generation,
    })
    expect(boundA.runtimeId).toBe(rtA.runtimeId)

    // Record event seq baseline
    const eventsBeforeRebind = await fetchEvents(c)
    const baselineSeq =
      eventsBeforeRebind.length > 0 ? eventsBeforeRebind[eventsBeforeRebind.length - 1]!.seq : 0

    // Rebind to runtime B
    const boundB = await c.bindSurface({
      surfaceKind,
      surfaceId,
      runtimeId: rtB.runtimeId,
      hostSessionId: rtB.hostSessionId,
      generation: rtB.generation,
    })
    expect(boundB.runtimeId).toBe(rtB.runtimeId)
    expect(boundB.surfaceId).toBe(surfaceId)

    // Verify surface.rebound event
    const events = await fetchEvents(c)
    const reboundEvent = events.find(
      (e) => e.eventKind === 'surface.rebound' && e.seq > baselineSeq
    )
    expect(reboundEvent).toBeDefined()
    expect(reboundEvent!.runtimeId).toBe(rtB.runtimeId)

    const payload = reboundEvent!.eventJson as Record<string, unknown>
    expect(payload.surfaceKind).toBe(surfaceKind)
    expect(payload.surfaceId).toBe(surfaceId)
    expect(payload.previousRuntimeId).toBe(rtA.runtimeId)
    expect(payload.previousHostSessionId).toBe(rtA.hostSessionId)

    // Runtime A should no longer list this surface
    const surfacesA = await c.listSurfaces({ runtimeId: rtA.runtimeId })
    const matchA = surfacesA.find((s) => s.surfaceId === surfaceId)
    expect(matchA).toBeUndefined()

    // Runtime B should list it
    const surfacesB = await c.listSurfaces({ runtimeId: rtB.runtimeId })
    const matchB = surfacesB.find((s) => s.surfaceId === surfaceId)
    expect(matchB).toBeDefined()
    expect(matchB!.runtimeId).toBe(rtB.runtimeId)
  })
})

// ===========================================================================
// 3. Clear-context then attach to new session's runtime → fresh bind
// ===========================================================================
describe('Clear-context surface binding move', () => {
  it('after clear-context, surface is unbound and can be freshly bound to new runtime', async () => {
    server = await createHrcServer(serverOpts())
    const c = client()

    const original = await seedRuntime(c, 'project:clear-ctx-bind')

    const surfaceKind = 'ghostty'
    const surfaceId = 'ctx-move-surf-1'

    // Bind surface to original runtime
    await c.bindSurface({
      surfaceKind,
      surfaceId,
      runtimeId: original.runtimeId,
      hostSessionId: original.hostSessionId,
      generation: original.generation,
    })

    // Clear context — rotates hostSessionId and increments generation
    const cleared = await c.clearContext({
      hostSessionId: original.hostSessionId,
    })
    expect(cleared.hostSessionId).not.toBe(original.hostSessionId)
    expect(cleared.generation).toBe(original.generation + 1)

    // Seed a new runtime on the new session (direct DB insert, no tmux fork)
    const newRuntimeId = `rt-test-${randomUUID()}`
    const now = ts()
    const db = openHrcDatabase(dbPath)
    db.runtimes.insert({
      runtimeId: newRuntimeId,
      hostSessionId: cleared.hostSessionId,
      scopeRef: 'project:clear-ctx-bind',
      laneRef: 'default',
      generation: cleared.generation,
      transport: 'sdk',
      harness: 'agent-sdk',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })

    // Bind surface to the new runtime after clear-context.
    // Phase 5 spec: clear-context invalidates old surfaces, so this is a fresh
    // bind (not a rebound) — no surface.rebound event is expected.
    const bound = await c.bindSurface({
      surfaceKind,
      surfaceId,
      runtimeId: newRuntimeId,
      hostSessionId: cleared.hostSessionId,
      generation: cleared.generation,
    })
    expect(bound.runtimeId).toBe(newRuntimeId)
    expect(bound.hostSessionId).toBe(cleared.hostSessionId)
    expect(bound.generation).toBe(cleared.generation)

    // Verify a surface.bound event (fresh bind, not rebound) was emitted
    const events = await fetchEvents(c)
    const boundEvent = events.find(
      (e) =>
        e.eventKind === 'surface.bound' &&
        (e.eventJson as Record<string, unknown>).surfaceId === surfaceId &&
        (e.eventJson as Record<string, unknown>).hostSessionId === cleared.hostSessionId
    )
    expect(boundEvent).toBeDefined()

    // New runtime lists the surface; old runtime does not
    const newSurfaces = await c.listSurfaces({ runtimeId: newRuntimeId })
    expect(newSurfaces.some((s) => s.surfaceId === surfaceId)).toBe(true)

    const oldSurfaces = await c.listSurfaces({ runtimeId: original.runtimeId })
    expect(oldSurfaces.some((s) => s.surfaceId === surfaceId)).toBe(false)
  })
})

// ===========================================================================
// 4. Unbind → verify surface.unbound event
// ===========================================================================
describe('Surface unbind with event', () => {
  it('unbindSurface returns record with unboundAt and emits surface.unbound', async () => {
    server = await createHrcServer(serverOpts())
    const c = client()
    const { hostSessionId, runtimeId, generation } = await seedRuntime(c, 'project:unbind-test')

    const surfaceKind = 'ghostty'
    const surfaceId = 'unbind-surf-1'

    // Bind
    await c.bindSurface({
      surfaceKind,
      surfaceId,
      runtimeId,
      hostSessionId,
      generation,
    })

    // Record baseline
    const baseline = await fetchEvents(c)
    const baselineSeq = baseline.length > 0 ? baseline[baseline.length - 1]!.seq : 0

    // Unbind with reason
    const unbound = await c.unbindSurface({
      surfaceKind,
      surfaceId,
      reason: 'user-requested',
    })
    expect(unbound.surfaceKind).toBe(surfaceKind)
    expect(unbound.surfaceId).toBe(surfaceId)
    expect(unbound.unboundAt).toBeString()
    expect(unbound.reason).toBe('user-requested')

    // Verify surface.unbound event
    const events = await fetchEvents(c)
    const unboundEvent = events.find(
      (e) => e.eventKind === 'surface.unbound' && e.seq > baselineSeq
    )
    expect(unboundEvent).toBeDefined()
    expect(unboundEvent!.runtimeId).toBe(runtimeId)

    const payload = unboundEvent!.eventJson as Record<string, unknown>
    expect(payload.surfaceKind).toBe(surfaceKind)
    expect(payload.surfaceId).toBe(surfaceId)
    expect(payload.reason).toBe('user-requested')

    // Surface no longer appears in runtime listing
    const surfaces = await c.listSurfaces({ runtimeId })
    expect(surfaces.some((s) => s.surfaceId === surfaceId)).toBe(false)
  })
})

// ===========================================================================
// 5. List surfaces for a runtime
// ===========================================================================
describe('List surfaces for a runtime', () => {
  it('returns only active bindings for the requested runtime', async () => {
    server = await createHrcServer(serverOpts())
    const c = client()

    const rt1 = await seedRuntime(c, 'project:list-rt1')
    const rt2 = await seedRuntime(c, 'project:list-rt2')

    // Bind two surfaces to rt1
    await c.bindSurface({
      surfaceKind: 'ghostty',
      surfaceId: 'list-s1',
      runtimeId: rt1.runtimeId,
      hostSessionId: rt1.hostSessionId,
      generation: rt1.generation,
    })
    await c.bindSurface({
      surfaceKind: 'iterm2',
      surfaceId: 'list-s2',
      runtimeId: rt1.runtimeId,
      hostSessionId: rt1.hostSessionId,
      generation: rt1.generation,
    })

    // Bind one surface to rt2
    await c.bindSurface({
      surfaceKind: 'ghostty',
      surfaceId: 'list-s3',
      runtimeId: rt2.runtimeId,
      hostSessionId: rt2.hostSessionId,
      generation: rt2.generation,
    })

    // Unbind one from rt1
    await c.unbindSurface({ surfaceKind: 'iterm2', surfaceId: 'list-s2' })

    // List rt1 — should have only list-s1 (list-s2 was unbound)
    const surfacesRt1 = await c.listSurfaces({ runtimeId: rt1.runtimeId })
    expect(surfacesRt1.length).toBe(1)
    expect(surfacesRt1[0]!.surfaceId).toBe('list-s1')
    expect(surfacesRt1[0]!.surfaceKind).toBe('ghostty')

    // List rt2 — should have list-s3
    const surfacesRt2 = await c.listSurfaces({ runtimeId: rt2.runtimeId })
    expect(surfacesRt2.length).toBe(1)
    expect(surfacesRt2[0]!.surfaceId).toBe('list-s3')
  })

  it('returns empty array for a runtime with no bindings', async () => {
    server = await createHrcServer(serverOpts())
    const c = client()
    const { runtimeId } = await seedRuntime(c, 'project:list-empty')

    const surfaces = await c.listSurfaces({ runtimeId })
    expect(surfaces).toEqual([])
  })
})
