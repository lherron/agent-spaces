/**
 * RED/GREEN tests for AgentchatBridge (T-00971 / Phase 5)
 *
 * Tests the hrc-bridge-agentchat package which adapts HRC local bridge
 * registration/delivery to agentchat DM transport:
 *   - registerTarget() registers a local bridge with HRC and returns bridgeId
 *   - deliver() sends text through the bridge via HRC deliver endpoint
 *   - deliver() rejects with stale fence error when context has rotated
 *   - close() closes the bridge registration
 *   - Constructor wires HrcClient + agentchat transport config
 *
 * This package wraps HRC SDK calls. Tests use a real HRC server (no mocks).
 *
 * Pass conditions for Curly (T-00971):
 *   1. AgentchatBridge class is exported from hrc-bridge-agentchat
 *   2. Constructor accepts { socketPath, transport, target } (or HrcClient + bridge config)
 *   3. registerTarget() calls POST /v1/bridges/local-target and returns { bridgeId }
 *   4. registerTarget() with fence params stores expectedHostSessionId + expectedGeneration
 *   5. deliver(text) calls POST /v1/bridges/deliver with bridgeId + text
 *   6. deliver() returns { delivered: true } on success
 *   7. deliver() throws/rejects with stale_context when fence fails
 *   8. close() calls POST /v1/bridges/close and marks bridge closed
 *   9. close() is idempotent (calling twice does not error)
 *  10. After close(), deliver() rejects (bridge no longer active)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHrcServer } from 'hrc-server'
import type { HrcServer } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'

// RED GATE: AgentchatBridge class does not exist yet
import { AgentchatBridge } from '../index'

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let tmuxSocketPath: string

function ts(): string {
  return new Date().toISOString()
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // @ts-expect-error -- Bun supports unix option on fetch
    unix: socketPath,
  })
}

/**
 * Helper: resolve a session + seed a runtime so we have valid IDs for bridge ops.
 */
async function ensureRuntime(scopeRef: string): Promise<{
  hostSessionId: string
  generation: number
  runtimeId: string
}> {
  const resolveRes = await postJson('/v1/sessions/resolve', {
    sessionRef: `${scopeRef}/lane:default`,
  })
  const resolved = (await resolveRes.json()) as {
    hostSessionId: string
    generation: number
  }

  const runtimeId = `rt-test-${randomUUID()}`
  const now = ts()
  const db = openHrcDatabase(dbPath)
  db.runtimes.create({
    runtimeId,
    hostSessionId: resolved.hostSessionId,
    scopeRef,
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
    generation: resolved.generation,
    runtimeId,
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-bridge-agentchat-test-'))
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
  try {
    const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await exited
  } catch {
    // fine
  }
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. AgentchatBridge construction and registerTarget
// ---------------------------------------------------------------------------
describe('AgentchatBridge.registerTarget', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('registers a local bridge target and returns bridgeId', async () => {
    server = await createHrcServer({
      runtimeRoot,
      stateRoot,
      socketPath,
      lockPath,
      spoolDir,
      dbPath,
      tmuxSocketPath,
    })
    const { hostSessionId, generation, runtimeId } = await ensureRuntime('bridge-reg-test')

    const bridge = new AgentchatBridge({
      socketPath,
      transport: 'legacy-agentchat',
      target: 'reg-test@agent-spaces',
    })

    const result = await bridge.registerTarget({
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    expect(result.bridgeId).toBeDefined()
    expect(typeof result.bridgeId).toBe('string')
  })

  it('stores fence params from registration', async () => {
    server = await createHrcServer({
      runtimeRoot,
      stateRoot,
      socketPath,
      lockPath,
      spoolDir,
      dbPath,
      tmuxSocketPath,
    })
    const { hostSessionId, generation, runtimeId } = await ensureRuntime('bridge-fence-reg')

    const bridge = new AgentchatBridge({
      socketPath,
      transport: 'legacy-agentchat',
      target: 'fence-reg@agent-spaces',
    })

    const result = await bridge.registerTarget({
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    // Verify via DB that fence was stored
    const db = openHrcDatabase(dbPath)
    try {
      const record = db.localBridges.findById(result.bridgeId)
      expect(record).not.toBeNull()
      expect(record!.expectedHostSessionId).toBe(hostSessionId)
      expect(record!.expectedGeneration).toBe(generation)
    } finally {
      db.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. AgentchatBridge.deliver
// ---------------------------------------------------------------------------
describe('AgentchatBridge.deliver', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('delivers text through the bridge', async () => {
    server = await createHrcServer({
      runtimeRoot,
      stateRoot,
      socketPath,
      lockPath,
      spoolDir,
      dbPath,
      tmuxSocketPath,
    })
    const { hostSessionId, generation, runtimeId } = await ensureRuntime('bridge-deliver')

    const bridge = new AgentchatBridge({
      socketPath,
      transport: 'legacy-agentchat',
      target: 'deliver@agent-spaces',
    })

    await bridge.registerTarget({
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    const result = await bridge.deliver('Hello from agentchat bridge')
    expect(result.delivered).toBe(true)
  })

  it('rejects with stale_context when fence has rotated', async () => {
    server = await createHrcServer({
      runtimeRoot,
      stateRoot,
      socketPath,
      lockPath,
      spoolDir,
      dbPath,
      tmuxSocketPath,
    })
    const { hostSessionId, generation, runtimeId } = await ensureRuntime('bridge-stale')

    const bridge = new AgentchatBridge({
      socketPath,
      transport: 'legacy-agentchat',
      target: 'stale@agent-spaces',
    })

    await bridge.registerTarget({
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    // Simulate context rotation by bumping the session's generation via
    // raw SQL. Fence validation checks the session, so this makes the
    // bridge's registered fence stale.
    const db = openHrcDatabase(dbPath)
    db.sqlite.exec(
      `UPDATE sessions SET generation = ${generation + 100} WHERE host_session_id = '${hostSessionId}'`
    )
    db.close()

    // The bridge still holds the original fence from registerTarget,
    // which now mismatches the session's current generation — expect 409
    await expect(bridge.deliver('Should fail')).rejects.toThrow(/stale_context/)
  })
})

// ---------------------------------------------------------------------------
// 3. AgentchatBridge.close
// ---------------------------------------------------------------------------
describe('AgentchatBridge.close', () => {
  let server: HrcServer

  afterEach(async () => {
    if (server) await server.stop()
  })

  it('closes the bridge registration', async () => {
    server = await createHrcServer({
      runtimeRoot,
      stateRoot,
      socketPath,
      lockPath,
      spoolDir,
      dbPath,
      tmuxSocketPath,
    })
    const { hostSessionId, generation, runtimeId } = await ensureRuntime('bridge-close')

    const bridge = new AgentchatBridge({
      socketPath,
      transport: 'legacy-agentchat',
      target: 'close@agent-spaces',
    })

    await bridge.registerTarget({
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    await bridge.close()

    // Verify via DB
    const db = openHrcDatabase(dbPath)
    try {
      const record = db.localBridges.findByTarget('legacy-agentchat', 'close@agent-spaces')
      expect(record).not.toBeNull()
      expect(record!.closedAt).toBeDefined()
    } finally {
      db.close()
    }
  })

  it('is idempotent — calling close twice does not error', async () => {
    server = await createHrcServer({
      runtimeRoot,
      stateRoot,
      socketPath,
      lockPath,
      spoolDir,
      dbPath,
      tmuxSocketPath,
    })
    const { hostSessionId, generation, runtimeId } = await ensureRuntime('bridge-close-idem')

    const bridge = new AgentchatBridge({
      socketPath,
      transport: 'legacy-agentchat',
      target: 'close-idem@agent-spaces',
    })

    await bridge.registerTarget({
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    await bridge.close()
    // Second close should not throw
    await bridge.close()
  })

  it('deliver rejects after close', async () => {
    server = await createHrcServer({
      runtimeRoot,
      stateRoot,
      socketPath,
      lockPath,
      spoolDir,
      dbPath,
      tmuxSocketPath,
    })
    const { hostSessionId, generation, runtimeId } = await ensureRuntime('bridge-deliver-closed')

    const bridge = new AgentchatBridge({
      socketPath,
      transport: 'legacy-agentchat',
      target: 'deliver-closed@agent-spaces',
    })

    await bridge.registerTarget({
      hostSessionId,
      runtimeId,
      expectedHostSessionId: hostSessionId,
      expectedGeneration: generation,
    })

    await bridge.close()

    // Deliver after close should fail
    await expect(bridge.deliver('Should fail')).rejects.toThrow()
  })
})
