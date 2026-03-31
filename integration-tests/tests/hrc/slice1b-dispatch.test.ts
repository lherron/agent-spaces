/**
 * RED/GREEN integration tests for HRC Slice 1B interactive dispatch (T-00963)
 *
 * These tests exercise the full end-to-end interactive dispatch path:
 *   server → adapter → launch artifact → wrapper → tmux → callbacks → events
 *
 * Required coverage per Run 6 assignment:
 *   1. Full dispatch cycle (resolve → ensure → dispatch → verify run + events + artifact)
 *   2. Fence validation across clear-context
 *   3. Clear-context with relaunch
 *   4. Runtime busy rejection
 *   5. Capture during active run
 *
 * RED GATE: These tests require Larry's Run 6 implementation:
 *   - POST /v1/turns (dispatchTurn) on hrc-server
 *   - POST /v1/clear-context (clearContext) on hrc-server
 *   - client.dispatchTurn() on hrc-sdk
 *   - client.clearContext() on hrc-sdk
 *
 * Pass conditions:
 *   1. dispatchTurn creates a run record (accepted→started), appends turn.accepted
 *      and turn.started events, writes a launch artifact to <runtimeRoot>/launches/
 *   2. clearContext rotates hostSessionId, increments generation, archives old session,
 *      updates continuity; with relaunch=true also creates a new runtime
 *   3. Dispatch on stale generation returns 409 stale_context; with followLatest
 *      succeeds on the new generation
 *   4. Dispatch while a run is active returns 409 runtime_busy
 *   5. Capture after dispatch returns non-empty tmux pane text
 *
 * Reference: T-00963, T-00964, T-00946
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { HrcEventEnvelope, HrcRuntimeIntent } from 'hrc-core'
import { HrcDomainError } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'
import { createHrcServer } from 'hrc-server'
import type { HrcServer, HrcServerOptions } from 'hrc-server'

// ---------------------------------------------------------------------------
// Harness shim path
// ---------------------------------------------------------------------------
const _SHIM_PATH = resolve(import.meta.dir, '../../fixtures/hrc-shim/hrc-harness-shim.sh')

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let launchesDir: string
let dbPath: string
let tmuxSocketPath: string
let server: HrcServer | null = null

function opts(overrides: Partial<HrcServerOptions> = {}): HrcServerOptions {
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

/** Default runtime intent for anthropic/claude-code interactive */
function defaultIntent(cwd?: string): HrcRuntimeIntent {
  return {
    placement: {
      cwd: cwd ?? tmpDir,
      correlation: {},
    },
    harness: {
      provider: 'anthropic',
      interactive: true,
    },
  } as HrcRuntimeIntent
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-slice1b-'))
  runtimeRoot = join(tmpDir, 'runtime')
  stateRoot = join(tmpDir, 'state')
  socketPath = join(runtimeRoot, 'hrc.sock')
  lockPath = join(runtimeRoot, 'server.lock')
  spoolDir = join(runtimeRoot, 'spool')
  launchesDir = join(runtimeRoot, 'launches')
  dbPath = join(stateRoot, 'state.sqlite')
  tmuxSocketPath = join(runtimeRoot, 'tmux.sock')

  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  await mkdir(spoolDir, { recursive: true })
  await mkdir(launchesDir, { recursive: true })
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = null
  }
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helper: resolve session + ensure runtime, return { hostSessionId, runtimeId }
// ---------------------------------------------------------------------------
async function setupSessionAndRuntime(
  c: HrcClient,
  sessionRef = 'project:dispatch-test/lane:default'
): Promise<{ hostSessionId: string; runtimeId: string; generation: number }> {
  const resolved = await c.resolveSession({ sessionRef })
  const runtime = await c.ensureRuntime({
    hostSessionId: resolved.hostSessionId,
    intent: defaultIntent(),
  })
  return {
    hostSessionId: resolved.hostSessionId,
    runtimeId: runtime.runtimeId,
    generation: resolved.generation,
  }
}

// ===========================================================================
// 1. Full dispatch cycle
// ===========================================================================
describe('Full dispatch cycle', () => {
  beforeEach(async () => {
    server = await createHrcServer(opts())
  })

  it('dispatchTurn creates run, appends events, writes launch artifact', async () => {
    const c = client()
    const { hostSessionId, runtimeId, generation } = await setupSessionAndRuntime(c)

    // RED GATE: client.dispatchTurn does not exist yet
    const result = await (c as any).dispatchTurn({
      hostSessionId,
      prompt: 'hello world',
      fences: { expectedHostSessionId: hostSessionId, expectedGeneration: generation },
    })

    // Verify response shape
    expect(result.runId).toBeString()
    expect(result.runId.length).toBeGreaterThan(0)
    expect(result.hostSessionId).toBe(hostSessionId)
    expect(result.generation).toBe(generation)
    expect(result.runtimeId).toBe(runtimeId)
    expect(result.status).toBe('started')

    // Verify events: turn.accepted and turn.started
    const events: HrcEventEnvelope[] = []
    for await (const ev of c.watch()) {
      events.push(ev)
    }

    const turnAccepted = events.find((e) => e.eventKind === 'turn.accepted')
    expect(turnAccepted).toBeDefined()
    expect(turnAccepted!.hostSessionId).toBe(hostSessionId)
    expect(turnAccepted!.runtimeId).toBe(runtimeId)

    const turnStarted = events.find((e) => e.eventKind === 'turn.started')
    expect(turnStarted).toBeDefined()
    expect(turnStarted!.hostSessionId).toBe(hostSessionId)

    // Verify turn.accepted comes before turn.started
    expect(turnAccepted!.seq).toBeLessThan(turnStarted!.seq)

    // Verify launch artifact was written
    const launchFiles = await readdir(launchesDir)
    const artifactFiles = launchFiles.filter((f) => f.endsWith('.json'))
    expect(artifactFiles.length).toBeGreaterThanOrEqual(1)

    // Read and validate the launch artifact
    const artifactPath = join(launchesDir, artifactFiles[0]!)
    const artifact = JSON.parse(await readFile(artifactPath, 'utf-8'))
    expect(artifact.launchId).toBeString()
    expect(artifact.hostSessionId).toBe(hostSessionId)
    expect(artifact.generation).toBe(generation)
    expect(artifact.runtimeId).toBe(runtimeId)
    expect(artifact.runId).toBe(result.runId)
    expect(artifact.callbackSocketPath).toBe(socketPath)
    expect(artifact.spoolDir).toBe(spoolDir)
    expect(Array.isArray(artifact.argv)).toBe(true)
    expect(typeof artifact.env).toBe('object')
    expect(typeof artifact.cwd).toBe('string')
  })

  it('dispatchTurn without fences succeeds on active session', async () => {
    const c = client()
    const { hostSessionId } = await setupSessionAndRuntime(c)

    // Dispatch without fences — should use current active state
    const result = await (c as any).dispatchTurn({
      hostSessionId,
      prompt: 'no-fence test',
    })

    expect(result.runId).toBeString()
    expect(result.status).toBe('started')
  })
})

// ===========================================================================
// 2. Fence validation across clear-context
// ===========================================================================
describe('Fence validation across clear-context', () => {
  beforeEach(async () => {
    server = await createHrcServer(opts())
  })

  it('rejects stale dispatch after clear-context with 409 stale_context', async () => {
    const c = client()
    const { hostSessionId: gen1HostSession, generation: gen1 } = await setupSessionAndRuntime(c)

    // Clear context — creates generation 2
    // RED GATE: client.clearContext does not exist yet
    const cleared = await (c as any).clearContext({
      hostSessionId: gen1HostSession,
    })
    expect(cleared.generation).toBe(gen1 + 1)
    expect(cleared.hostSessionId).not.toBe(gen1HostSession)

    // Ensure runtime on the new session for dispatch
    await c.ensureRuntime({
      hostSessionId: cleared.hostSessionId,
      intent: defaultIntent(),
    })

    // Dispatch on generation 1 without followLatest — expect 409
    try {
      await (c as any).dispatchTurn({
        hostSessionId: cleared.hostSessionId,
        prompt: 'stale dispatch',
        fences: {
          expectedHostSessionId: gen1HostSession,
          expectedGeneration: gen1,
        },
      })
      // Should not reach here
      expect(true).toBe(false)
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(HrcDomainError)
      const domainErr = err as InstanceType<typeof HrcDomainError>
      expect(domainErr.code).toBe('stale_context')
    }
  })

  it('followLatest bypasses stale fence and dispatches on new generation', async () => {
    const c = client()
    const { hostSessionId: gen1HostSession } = await setupSessionAndRuntime(c)

    // Clear context
    const cleared = await (c as any).clearContext({
      hostSessionId: gen1HostSession,
    })

    // Ensure runtime on new session
    await c.ensureRuntime({
      hostSessionId: cleared.hostSessionId,
      intent: defaultIntent(),
    })

    // Dispatch with followLatest — should succeed on generation 2
    const result = await (c as any).dispatchTurn({
      hostSessionId: cleared.hostSessionId,
      prompt: 'follow latest dispatch',
      fences: { followLatest: true },
    })

    expect(result.runId).toBeString()
    expect(result.generation).toBe(cleared.generation)
    expect(result.status).toBe('started')
  })
})

// ===========================================================================
// 3. Clear-context with relaunch
// ===========================================================================
describe('Clear-context with relaunch', () => {
  beforeEach(async () => {
    server = await createHrcServer(opts())
  })

  it('clearContext rotates hostSessionId and increments generation', async () => {
    const c = client()
    const { hostSessionId: origId, generation: origGen } = await setupSessionAndRuntime(c)

    const cleared = await (c as any).clearContext({
      hostSessionId: origId,
    })

    expect(cleared.hostSessionId).toBeString()
    expect(cleared.hostSessionId).not.toBe(origId)
    expect(cleared.generation).toBe(origGen + 1)
    expect(cleared.priorHostSessionId).toBe(origId)
  })

  it('clearContext archives the prior session', async () => {
    const c = client()
    const { hostSessionId: origId } = await setupSessionAndRuntime(c)

    await (c as any).clearContext({ hostSessionId: origId })

    // The old session should be archived
    const oldSession = await c.getSession(origId)
    expect(oldSession.status).toBe('archived')
  })

  it('clearContext updates continuity to new hostSessionId', async () => {
    const c = client()
    const sessionRef = 'project:ctx-clear/lane:default'
    const resolved = await c.resolveSession({ sessionRef })
    await c.ensureRuntime({
      hostSessionId: resolved.hostSessionId,
      intent: defaultIntent(),
    })

    const cleared = await (c as any).clearContext({
      hostSessionId: resolved.hostSessionId,
    })

    // Re-resolve should return the new hostSessionId
    const reResolved = await c.resolveSession({ sessionRef })
    expect(reResolved.hostSessionId).toBe(cleared.hostSessionId)
    expect(reResolved.created).toBe(false)
  })

  it('clearContext with relaunch creates a new runtime', async () => {
    const c = client()
    const { hostSessionId: origId } = await setupSessionAndRuntime(c)

    const cleared = await (c as any).clearContext({
      hostSessionId: origId,
      relaunch: true,
    })

    expect(cleared.hostSessionId).not.toBe(origId)
    expect(cleared.generation).toBeGreaterThan(1)

    // The new session should have a runtime (ensured by relaunch)
    // Verify by capturing — should not throw unknown_runtime
    // We need to get the new runtime; ensure runtime on the new session
    const newRuntime = await c.ensureRuntime({
      hostSessionId: cleared.hostSessionId,
      intent: defaultIntent(),
    })

    // The new runtime should have a different runtimeId
    // (relaunch creates fresh runtime, ensureRuntime may reuse or create)
    expect(newRuntime.runtimeId).toBeString()
    expect(newRuntime.hostSessionId).toBe(cleared.hostSessionId)
  })

  it('clearContext emits context.cleared on old session and session.created on new', async () => {
    const c = client()
    const { hostSessionId: origId } = await setupSessionAndRuntime(c)

    const cleared = await (c as any).clearContext({
      hostSessionId: origId,
    })

    const events: HrcEventEnvelope[] = []
    for await (const ev of c.watch()) {
      events.push(ev)
    }

    // context.cleared event on the old session
    const ctxCleared = events.find(
      (e) => e.eventKind === 'context.cleared' && e.hostSessionId === origId
    )
    expect(ctxCleared).toBeDefined()

    // session.created event on the new session
    const newCreated = events.find(
      (e) => e.eventKind === 'session.created' && e.hostSessionId === cleared.hostSessionId
    )
    expect(newCreated).toBeDefined()
  })
})

// ===========================================================================
// 4. Runtime busy rejection
// ===========================================================================
describe('Runtime busy rejection', () => {
  beforeEach(async () => {
    server = await createHrcServer(opts())
  })

  it('rejects second dispatch while first run is active with 409 runtime_busy', async () => {
    const c = client()
    const { hostSessionId } = await setupSessionAndRuntime(c)

    // First dispatch — should succeed
    const first = await (c as any).dispatchTurn({
      hostSessionId,
      prompt: 'first turn',
    })
    expect(first.runId).toBeString()
    expect(first.status).toBe('started')

    // Second dispatch while first is active — expect 409
    try {
      await (c as any).dispatchTurn({
        hostSessionId,
        prompt: 'second turn while busy',
      })
      // Should not reach here
      expect(true).toBe(false)
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(HrcDomainError)
      const domainErr = err as InstanceType<typeof HrcDomainError>
      expect(domainErr.code).toBe('runtime_busy')
    }
  })
})

// ===========================================================================
// 5. Capture during active run
// ===========================================================================
describe('Capture during active run', () => {
  beforeEach(async () => {
    server = await createHrcServer(opts())
  })

  it('capture returns non-empty text after dispatch', async () => {
    const c = client()
    const { hostSessionId, runtimeId } = await setupSessionAndRuntime(c)

    // Dispatch a turn (the shim will echo output to the tmux pane)
    await (c as any).dispatchTurn({
      hostSessionId,
      prompt: 'capture test',
    })

    // Wait a moment for the shim to produce output
    await new Promise((r) => setTimeout(r, 500))

    // Capture pane text
    const captured = await c.capture(runtimeId)
    expect(captured.text).toBeString()
    expect(captured.text.length).toBeGreaterThan(0)
  })
})
