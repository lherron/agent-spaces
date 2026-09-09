import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrokerClient } from 'spaces-harness-broker-client'
import {
  type BrokerEnsureInvocationRequest,
  BrokerErrorCode,
  type BrokerInstallIdentityRequest,
  type BrokerInstallIdentityResponse,
} from 'spaces-harness-broker-protocol'
import { brokerCommand, brokerProcessEnv, codexSpec, helloRequest, repoRoot } from './helpers'

/**
 * T-08346 — the participant establishment sequence through the PUBLIC client,
 * against the shipped `bin/harness-broker.js` over a real unix socket.
 *
 * This is the client-side counterpart to the broker package's acceptance suite:
 * where that one speaks raw JSON-RPC to count driver effects, this one proves
 * that `BrokerClient.installIdentity` / `.ensureInvocation` are wired to the
 * same wire methods, and that the full C.5.1 order — INSTALL -> HELLO ->
 * ENSURE_INVOCATION -> ATTACH — completes against a real driver start
 * (the hermetic fake-codex fixture, no credentials).
 */

const tmpDirs: string[] = []
const clients: BrokerClient[] = []
const brokers: Array<ReturnType<typeof Bun.spawn>> = []

const identity = {
  runtimeId: 'runtime_t08346_client',
  hostSessionId: 'host_session_t08346_client',
  generation: 4,
  attachEpoch: 1,
  invocationId: 'inv_client_t08346',
  startRequestHash: 'start_hash_t08346_client',
  selectedProfileHash: 'profile_hash_t08346_client',
  attachToken: 'attach_token_t08346_client',
} satisfies BrokerInstallIdentityRequest

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})))
  for (const broker of brokers.splice(0)) {
    if (broker.exitCode === null) broker.kill('SIGTERM')
    await broker.exited.catch(() => {})
  }
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function startParticipantBroker(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 't08346-client-'))
  tmpDirs.push(dir)
  const socketPath = join(dir, 'b.sock')
  const broker = Bun.spawn({
    cmd: [
      brokerCommand,
      'harness/harness-broker/bin/harness-broker.js',
      'run',
      '--transport',
      'unix',
      '--socket',
      socketPath,
      '--event-ledger',
      join(dir, 'events.jsonl'),
      // No identity flags: the participant installs its own identity. The
      // posture is DECLARED, never inferred from the missing flags.
      '--join',
      'participant-served',
    ],
    cwd: repoRoot,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: brokerProcessEnv(),
  })
  brokers.push(broker)

  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (broker.exitCode !== null) {
      throw new Error(
        `broker exited before bind: ${(await new Response(broker.stderr).text()).trim()}`
      )
    }
    try {
      if ((await stat(socketPath)).isSocket()) return socketPath
    } catch {
      // still binding
    }
    await Bun.sleep(25)
  }
  throw new Error('participant broker did not bind its unix socket')
}

function ensureRequest(startAttemptId: string, scenario = 'start-fresh-turn') {
  return {
    startAttemptId,
    invocationId: identity.invocationId,
    attachEpoch: identity.attachEpoch,
    startRequest: {
      spec: codexSpec(scenario, {
        invocationId: identity.invocationId,
        correlation: {
          runtimeId: identity.runtimeId,
          hostSessionId: identity.hostSessionId,
          startRequestHash: identity.startRequestHash,
          selectedProfileHash: identity.selectedProfileHash,
        },
      }),
    },
  } as unknown as BrokerEnsureInvocationRequest
}

describe('T-08346 participant establishment through the public client', () => {
  test('install -> hello -> ensureInvocation -> attach completes on one packaged broker', async () => {
    const socketPath = await startParticipantBroker()
    const client = await BrokerClient.connectUnix({ socketPath, timeoutMs: 2000 })
    clients.push(client)

    // Bootstrap posture: the client's ordinary handshake is refused.
    await expect(client.hello(helloRequest({ eventReplay: true }))).rejects.toMatchObject({
      code: BrokerErrorCode.BrokerBootstrapRequired,
    })

    const ack: BrokerInstallIdentityResponse = await client.installIdentity(identity)
    expect(ack.installed).toBe(true)
    expect(ack.invocationId).toBe(identity.invocationId)
    expect(ack.attachEpoch).toBe(identity.attachEpoch)
    // An exact replay for the recorded epoch returns the SAME ack.
    expect(await client.installIdentity({ ...identity })).toEqual(ack)
    // A different epoch is refused; the incumbent keeps live control.
    await expect(client.installIdentity({ ...identity, attachEpoch: 2 })).rejects.toMatchObject({
      code: BrokerErrorCode.IdentityInstallConflict,
    })

    const hello = await client.hello(helloRequest({ eventReplay: true }))
    expect(hello.capabilities.attachReplay).toBe(true)

    // Install and hello do NOT make the participant resident.
    await expect(
      client.attach({
        runtimeId: identity.runtimeId,
        hostSessionId: identity.hostSessionId,
        generation: identity.generation,
        invocationId: identity.invocationId,
        startRequestHash: identity.startRequestHash,
        selectedProfileHash: identity.selectedProfileHash,
        attachToken: identity.attachToken,
        controllerInstanceId: 'controller-before-resident',
      })
    ).rejects.toMatchObject({ code: BrokerErrorCode.AttachRejected })

    const attempt = 'attempt_client_t08346'
    const established = await client.ensureInvocation(ensureRequest(attempt))
    expect(established.receipt).toMatchObject({
      startAttemptId: attempt,
      invocationId: identity.invocationId,
      state: 'started',
    })

    // Retry-safe: the same attempt with the same immutable request returns the
    // same receipt against the now-resident invocation.
    expect(await client.ensureInvocation(ensureRequest(attempt))).toEqual(established)

    // The immutable request is immutable.
    await expect(
      client.ensureInvocation(ensureRequest(attempt, 'resume-turn'))
    ).rejects.toMatchObject({ code: BrokerErrorCode.StartAttemptConflict })

    const attached = await client.attach({
      runtimeId: identity.runtimeId,
      hostSessionId: identity.hostSessionId,
      generation: identity.generation,
      invocationId: identity.invocationId,
      startRequestHash: identity.startRequestHash,
      selectedProfileHash: identity.selectedProfileHash,
      attachToken: identity.attachToken,
      controllerInstanceId: 'controller-after-resident',
    })
    expect(attached.attached).toBe(true)
    expect(attached.invocationId).toBe(identity.invocationId)
    // Events produced during driver.start are in the durable ledger and remain
    // unacked: nothing about establishment acks them (HRC owns activation).
    expect(attached.currentSeq).toBeGreaterThan(0)
    expect(attached.retentionFloorSeq).toBe(0)
  }, 30_000)
})
