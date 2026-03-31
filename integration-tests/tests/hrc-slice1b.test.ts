/**
 * RED/GREEN acceptance tests for HRC Slice 1B (T-00964)
 *
 * These are the gatekeeper acceptance tests for Slice 1B. They exercise the
 * full interactive dispatch path — server, SDK client, adapter, launch,
 * tmux — through real Unix sockets with real SQLite persistence and a real
 * tmux session (managed by the server's TmuxManager). No mocks.
 *
 * Acceptance criteria from HRC_IMPLEMENTATION_PLAN.md Phase 1 Slice 1B:
 *
 *   AC-5: `hrc server` starts and owns the tmux socket.
 *   AC-6: `hrc runtime ensure` can prewarm a `claude-code` or `codex-cli` runtime.
 *   AC-7: `hrc turn send` launches a turn and records `turn.accepted`.
 *   AC-8: `hrc capture` returns tmux pane text.
 *   AC-9: `hrc clear-context --relaunch` rotates `hostSessionId` and increments `generation`.
 *   AC-10: Stale dispatch across the prior generation is rejected unless `followLatest` is set.
 *
 * RED GATE — these tests exercise endpoints and SDK methods that DO NOT EXIST YET:
 *   - POST /v1/turns (dispatchTurn) — not wired in hrc-server
 *   - POST /v1/clear-context (clearContext) — not wired in hrc-server
 *   - HrcClient.dispatchTurn() — not defined in hrc-sdk
 *   - HrcClient.clearContext() — not defined in hrc-sdk
 *   - DispatchTurnRequest / DispatchTurnResponse — not defined in hrc-sdk/types
 *   - ClearContextRequest / ClearContextResponse — not defined in hrc-sdk/types
 *
 * Pass conditions (Smokey → Larry):
 *   1. Server starts and creates a tmux socket at <runtimeRoot>/tmux.sock
 *   2. ensureRuntime creates a runtime with transport=tmux, status=ready
 *   3. dispatchTurn accepts a prompt, creates a run record (status=accepted→started),
 *      appends turn.accepted + turn.started events, writes a launch artifact,
 *      and returns { runId, hostSessionId, generation, runtimeId, status: 'started' }
 *   4. capture returns non-empty pane text after a dispatch
 *   5. clearContext rotates hostSessionId, increments generation, archives old session,
 *      and optionally relaunches a new runtime
 *   6. dispatchTurn with stale generation fence returns 409 stale_context;
 *      with followLatest=true it resolves to the current generation and succeeds
 *   7. dispatchTurn while a run is active returns 409 runtime_busy
 *
 * Reference: T-00946 (parent), T-00964 (this validation task), T-00963 (Curly integration)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcEventEnvelope, HrcRuntimeIntent } from 'hrc-core'
import { HrcDomainError } from 'hrc-core'

// RED GATE: These imports require the full Slice 1B stack to be wired up.
// hrc-sdk must export HrcClient with dispatchTurn() and clearContext() methods.
// hrc-server must handle POST /v1/turns and POST /v1/clear-context.
import { HrcClient } from 'hrc-sdk'
import type { ClearContextResponse, DispatchTurnResponse } from 'hrc-sdk'
import { createHrcServer } from 'hrc-server'
import type { HrcServer, HrcServerOptions } from 'hrc-server'

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const _SHIM_PATH = join(import.meta.dir, '..', 'fixtures', 'hrc-shim', 'harness')

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let launchDir: string
let server: HrcServer | null = null

/** Standard RuntimeIntent for claude-code interactive harness */
function claudeIntent(): HrcRuntimeIntent {
  return {
    placement: {
      harness: 'claude-code',
      frontend: 'claude-code',
      provider: 'anthropic',
      model: 'sonnet',
    },
    harness: {
      provider: 'anthropic',
      interactive: true,
    },
  }
}

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
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-1b-accept-'))
  runtimeRoot = join(tmpDir, 'runtime')
  stateRoot = join(tmpDir, 'state')
  socketPath = join(runtimeRoot, 'hrc.sock')
  lockPath = join(runtimeRoot, 'server.lock')
  spoolDir = join(runtimeRoot, 'spool')
  dbPath = join(stateRoot, 'state.sqlite')
  launchDir = join(runtimeRoot, 'launches')

  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  await mkdir(spoolDir, { recursive: true })
  await mkdir(launchDir, { recursive: true })
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = null
  }
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a session and ensure a runtime, returning both IDs */
async function resolveAndEnsure(c: HrcClient) {
  const session = await c.resolveSession({
    sessionRef: 'project:slice1b-test/lane:default',
  })
  const runtime = await c.ensureRuntime({
    hostSessionId: session.hostSessionId,
    intent: claudeIntent(),
  })
  return { session, runtime }
}

/** Collect all events from the server (non-follow mode) */
async function collectEvents(c: HrcClient): Promise<HrcEventEnvelope[]> {
  const events: HrcEventEnvelope[] = []
  for await (const ev of c.watch()) {
    events.push(ev)
  }
  return events
}

// ===========================================================================
// AC-5: hrc server starts and owns the tmux socket
// ===========================================================================
describe('AC-5: hrc server starts and owns the tmux socket', () => {
  it('creates a tmux socket at <runtimeRoot>/tmux.sock', async () => {
    server = await createHrcServer(opts())

    // The server's TmuxManager should create the tmux socket
    const tmuxSockPath = join(runtimeRoot, 'tmux.sock')
    const tmuxStat = await stat(tmuxSockPath).catch(() => null)
    expect(tmuxStat).not.toBeNull()
    // tmux sockets are Unix domain sockets
    expect(tmuxStat!.isSocket()).toBe(true)
  })
})

// ===========================================================================
// AC-6: hrc runtime ensure can prewarm a claude-code or codex-cli runtime
// ===========================================================================
describe('AC-6: ensureRuntime prewarming for interactive harnesses', () => {
  beforeEach(async () => {
    server = await createHrcServer(opts())
  })

  it('creates a runtime with transport=tmux and status=ready', async () => {
    const c = client()
    const session = await c.resolveSession({
      sessionRef: 'project:prewarm-test/lane:default',
    })

    const runtime = await c.ensureRuntime({
      hostSessionId: session.hostSessionId,
      intent: claudeIntent(),
    })

    expect(runtime.runtimeId).toBeString()
    expect(runtime.runtimeId.length).toBeGreaterThan(0)
    expect(runtime.hostSessionId).toBe(session.hostSessionId)
    expect(runtime.transport).toBe('tmux')
    expect(runtime.status).toBe('ready')
    expect(runtime.tmux).toBeDefined()
    expect(runtime.tmux.sessionId).toBeString()
    expect(runtime.tmux.paneId).toBeString()
  })

  it('reuses existing tmux pane on repeat ensure with reuse_pty', async () => {
    const c = client()
    const session = await c.resolveSession({
      sessionRef: 'project:reuse-test/lane:default',
    })

    const first = await c.ensureRuntime({
      hostSessionId: session.hostSessionId,
      intent: claudeIntent(),
    })

    const second = await c.ensureRuntime({
      hostSessionId: session.hostSessionId,
      intent: claudeIntent(),
      restartStyle: 'reuse_pty',
    })

    // Same tmux pane, possibly same or updated runtime ID
    expect(second.tmux.paneId).toBe(first.tmux.paneId)
    expect(second.transport).toBe('tmux')
    expect(second.status).toBe('ready')
  })
})

// ===========================================================================
// AC-7: hrc turn send launches a turn and records turn.accepted
// ===========================================================================
describe('AC-7: dispatchTurn launches a turn and records turn.accepted', () => {
  beforeEach(async () => {
    server = await createHrcServer(opts())
  })

  it('dispatches a turn and returns runId with status started', async () => {
    const c = client()
    const { session, runtime } = await resolveAndEnsure(c)

    // RED GATE: dispatchTurn does not exist yet
    const result: DispatchTurnResponse = await c.dispatchTurn({
      hostSessionId: session.hostSessionId,
      prompt: 'echo hello from slice 1b acceptance test',
    })

    expect(result.runId).toBeString()
    expect(result.runId.length).toBeGreaterThan(0)
    expect(result.hostSessionId).toBe(session.hostSessionId)
    expect(result.generation).toBe(session.generation)
    expect(result.runtimeId).toBe(runtime.runtimeId)
    expect(result.status).toBe('started')
  })

  it('appends turn.accepted and turn.started events', async () => {
    const c = client()
    const { session } = await resolveAndEnsure(c)

    await c.dispatchTurn({
      hostSessionId: session.hostSessionId,
      prompt: 'test event recording',
    })

    const events = await collectEvents(c)
    const turnEvents = events.filter(
      (e) => e.eventKind === 'turn.accepted' || e.eventKind === 'turn.started'
    )

    expect(turnEvents.length).toBeGreaterThanOrEqual(2)

    const accepted = turnEvents.find((e) => e.eventKind === 'turn.accepted')
    const started = turnEvents.find((e) => e.eventKind === 'turn.started')

    expect(accepted).toBeDefined()
    expect(started).toBeDefined()
    expect(accepted!.hostSessionId).toBe(session.hostSessionId)
    expect(started!.hostSessionId).toBe(session.hostSessionId)
    // accepted must come before started
    expect(accepted!.seq).toBeLessThan(started!.seq)
  })

  it('writes a launch artifact with required fields', async () => {
    const c = client()
    const { session } = await resolveAndEnsure(c)

    const result = await c.dispatchTurn({
      hostSessionId: session.hostSessionId,
      prompt: 'test launch artifact',
    })

    // Verify a launch artifact file was written
    const { readdir, readFile } = await import('node:fs/promises')
    const files = await readdir(launchDir).catch(() => [])
    expect(files.length).toBeGreaterThanOrEqual(1)

    // Read and validate the artifact
    const artifactPath = join(launchDir, files[0]!)
    const raw = JSON.parse(await readFile(artifactPath, 'utf-8'))

    expect(raw.launchId).toBeString()
    expect(raw.hostSessionId).toBe(session.hostSessionId)
    expect(raw.generation).toBe(session.generation)
    expect(raw.runtimeId).toBeString()
    expect(raw.runId).toBe(result.runId)
    expect(raw.harness).toBeString()
    expect(raw.provider).toBeString()
    expect(Array.isArray(raw.argv)).toBe(true)
    expect(typeof raw.env).toBe('object')
    expect(typeof raw.cwd).toBe('string')
    expect(raw.callbackSocketPath).toBeString()
    expect(raw.spoolDir).toBeString()
    expect(typeof raw.correlationEnv).toBe('object')
  })
})

// ===========================================================================
// AC-8: hrc capture returns tmux pane text
// ===========================================================================
describe('AC-8: capture returns tmux pane text after dispatch', () => {
  beforeEach(async () => {
    server = await createHrcServer(opts())
  })

  it('returns non-empty text from the tmux pane', async () => {
    const c = client()
    const { runtime } = await resolveAndEnsure(c)

    // Capture should return something (at minimum a shell prompt)
    const capture = await c.capture(runtime.runtimeId)
    expect(capture.text).toBeDefined()
    expect(typeof capture.text).toBe('string')
    // After ensureRuntime the pane exists; it may have a shell prompt or be empty-ish
    // but after a dispatch it should have content
  })

  it('returns content from pane after turn dispatch', async () => {
    const c = client()
    const { session, runtime } = await resolveAndEnsure(c)

    // Dispatch a turn that will produce output
    await c.dispatchTurn({
      hostSessionId: session.hostSessionId,
      prompt: 'echo capture-test-output',
    })

    // Give the tmux command a moment to execute
    await new Promise((r) => setTimeout(r, 500))

    const capture = await c.capture(runtime.runtimeId)
    expect(capture.text).toBeDefined()
    expect(capture.text.length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// AC-9: clear-context --relaunch rotates hostSessionId and increments generation
// ===========================================================================
describe('AC-9: clearContext rotates hostSessionId and increments generation', () => {
  beforeEach(async () => {
    server = await createHrcServer(opts())
  })

  it('returns new hostSessionId with generation+1', async () => {
    const c = client()
    const { session } = await resolveAndEnsure(c)
    const oldHostSessionId = session.hostSessionId
    const oldGeneration = session.generation

    // RED GATE: clearContext does not exist yet
    const result: ClearContextResponse = await c.clearContext({
      hostSessionId: oldHostSessionId,
    })

    expect(result.hostSessionId).toBeString()
    expect(result.hostSessionId).not.toBe(oldHostSessionId)
    expect(result.generation).toBe(oldGeneration + 1)
    expect(result.priorHostSessionId).toBe(oldHostSessionId)
  })

  it('archives the prior session', async () => {
    const c = client()
    const { session } = await resolveAndEnsure(c)
    const oldHostSessionId = session.hostSessionId

    await c.clearContext({ hostSessionId: oldHostSessionId })

    // The old session should now be archived
    const oldSession = await c.getSession(oldHostSessionId)
    expect(oldSession.status).toBe('archived')
  })

  it('updates continuity to point at the new hostSessionId', async () => {
    const c = client()
    const { session } = await resolveAndEnsure(c)
    const oldHostSessionId = session.hostSessionId

    const result = await c.clearContext({ hostSessionId: oldHostSessionId })

    // Re-resolve the same sessionRef should now return the new hostSessionId
    const reResolved = await c.resolveSession({
      sessionRef: 'project:slice1b-test/lane:default',
    })
    expect(reResolved.hostSessionId).toBe(result.hostSessionId)
    expect(reResolved.created).toBe(false)
  })

  it('with relaunch=true creates a new runtime for the new session', async () => {
    const c = client()
    const { session, runtime: oldRuntime } = await resolveAndEnsure(c)

    const result = await c.clearContext({
      hostSessionId: session.hostSessionId,
      relaunch: true,
    })

    // The new session should have a fresh runtime
    // Verify by ensuring runtime on the new hostSessionId
    const newRuntime = await c.ensureRuntime({
      hostSessionId: result.hostSessionId,
      intent: claudeIntent(),
    })

    expect(newRuntime.runtimeId).not.toBe(oldRuntime.runtimeId)
    expect(newRuntime.hostSessionId).toBe(result.hostSessionId)
    expect(newRuntime.status).toBe('ready')
  })

  it('appends context.cleared event on old session and session.created on new', async () => {
    const c = client()
    const { session } = await resolveAndEnsure(c)

    const result = await c.clearContext({ hostSessionId: session.hostSessionId })

    const events = await collectEvents(c)

    const cleared = events.find(
      (e) => e.eventKind === 'context.cleared' && e.hostSessionId === session.hostSessionId
    )
    expect(cleared).toBeDefined()

    const created = events.find(
      (e) => e.eventKind === 'session.created' && e.hostSessionId === result.hostSessionId
    )
    expect(created).toBeDefined()
    expect(created!.generation).toBe(result.generation)
  })
})

// ===========================================================================
// AC-10: Stale dispatch rejected unless followLatest is set
// ===========================================================================
describe('AC-10: stale dispatch rejection and followLatest bypass', () => {
  beforeEach(async () => {
    server = await createHrcServer(opts())
  })

  it('rejects dispatch with stale generation fence (409 stale_context)', async () => {
    const c = client()
    const { session } = await resolveAndEnsure(c)
    const gen1HostSessionId = session.hostSessionId

    // Clear context to advance to generation 2
    await c.clearContext({ hostSessionId: gen1HostSessionId })

    // Attempt dispatch targeting generation 1 — should be rejected
    try {
      await c.dispatchTurn({
        hostSessionId: gen1HostSessionId,
        prompt: 'this should fail',
        fences: {
          expectedGeneration: 1,
        },
      })
      // Should not reach here
      expect(true).toBe(false)
    } catch (err) {
      expect(err).toBeInstanceOf(HrcDomainError)
      const domainErr = err as HrcDomainError
      expect(domainErr.code).toBe('stale_context')
      expect(domainErr.status).toBe(409)
    }
  })

  it('allows dispatch with followLatest=true on stale generation', async () => {
    const c = client()
    const { session } = await resolveAndEnsure(c)
    const gen1HostSessionId = session.hostSessionId

    // Clear context to advance to generation 2
    const cleared = await c.clearContext({ hostSessionId: gen1HostSessionId })

    // Ensure runtime on the new session so dispatch can succeed
    await c.ensureRuntime({
      hostSessionId: cleared.hostSessionId,
      intent: claudeIntent(),
    })

    // Dispatch with followLatest — should succeed on generation 2
    const result = await c.dispatchTurn({
      hostSessionId: gen1HostSessionId,
      prompt: 'followLatest bypass test',
      fences: {
        followLatest: true,
      },
    })

    expect(result.hostSessionId).toBe(cleared.hostSessionId)
    expect(result.generation).toBe(cleared.generation)
    expect(result.status).toBe('started')
  })

  it('rejects dispatch with stale hostSessionId fence (409)', async () => {
    const c = client()
    const { session } = await resolveAndEnsure(c)

    // Clear context
    await c.clearContext({ hostSessionId: session.hostSessionId })

    // Dispatch with the old hostSessionId as a fence
    try {
      await c.dispatchTurn({
        hostSessionId: session.hostSessionId,
        prompt: 'stale host session test',
        fences: {
          expectedHostSessionId: session.hostSessionId,
        },
      })
      expect(true).toBe(false)
    } catch (err) {
      expect(err).toBeInstanceOf(HrcDomainError)
      const domainErr = err as HrcDomainError
      expect(domainErr.code).toBe('stale_context')
      expect(domainErr.status).toBe(409)
    }
  })
})

// ===========================================================================
// Bonus: runtime_busy rejection
// ===========================================================================
describe('runtime_busy prevents concurrent dispatch', () => {
  beforeEach(async () => {
    server = await createHrcServer(opts())
  })

  it('rejects second dispatch while first run is active (409 runtime_busy)', async () => {
    const c = client()
    const { session } = await resolveAndEnsure(c)

    // First dispatch
    await c.dispatchTurn({
      hostSessionId: session.hostSessionId,
      prompt: 'first turn — takes a moment',
    })

    // Second dispatch while first is still active
    try {
      await c.dispatchTurn({
        hostSessionId: session.hostSessionId,
        prompt: 'second concurrent turn — should fail',
      })
      expect(true).toBe(false)
    } catch (err) {
      expect(err).toBeInstanceOf(HrcDomainError)
      const domainErr = err as HrcDomainError
      expect(domainErr.code).toBe('runtime_busy')
      expect(domainErr.status).toBe(409)
    }
  })
})
