import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrokerClient } from 'spaces-harness-broker-client'
import {
  type BrokerAttachRequest,
  BrokerErrorCode,
  type InvocationInputResponse,
} from 'spaces-harness-broker-protocol'
import {
  brokerCommand,
  brokerProcessEnv,
  codexSpec,
  collectUntil,
  helloRequest,
  repoRoot,
  userInput,
  withTimeout,
} from './helpers'

const tmpDirs: string[] = []

const runtimeIdentity = {
  runtimeId: 'runtime_T01793_c1',
  hostSessionId: 'hostSession_T01793_c1',
  generation: 1,
  invocationId: 'inv_client_t01793_c1',
  startRequestHash: 'start_hash_T01793_c1',
  selectedProfileHash: 'profile_hash_T01793_c1',
  attachToken: 'attach-token-T01793-c1',
}

const waitForSocket = async (
  socketPath: string,
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = 1500
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`broker exited before creating unix socket: ${stderr.trim()}`)
    }
    try {
      const info = await stat(socketPath)
      if (info.isSocket()) return
    } catch {
      // Keep polling until the broker binds the socket or exits.
    }
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for unix socket ${socketPath}`)
}

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const startUnixBroker = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-broker-durability-c1-'))
  tmpDirs.push(dir)
  const socketPath = join(dir, 'broker.sock')
  const tokenPath = join(dir, 'attach.token')
  const ledgerPath = join(dir, 'events.jsonl')
  await writeFile(tokenPath, runtimeIdentity.attachToken)

  const broker = Bun.spawn({
    cmd: [
      brokerCommand,
      'packages/harness-broker/bin/harness-broker.js',
      'run',
      '--transport',
      'unix',
      '--socket',
      socketPath,
      '--runtime-id',
      runtimeIdentity.runtimeId,
      '--host-session-id',
      runtimeIdentity.hostSessionId,
      '--generation',
      String(runtimeIdentity.generation),
      '--attach-token-file',
      tokenPath,
      '--event-ledger',
      ledgerPath,
    ],
    cwd: repoRoot,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: brokerProcessEnv(),
  })

  await waitForSocket(socketPath, broker)
  return { broker, socketPath }
}

const connect = (socketPath: string): Promise<BrokerClient> =>
  BrokerClient.connectUnix({ socketPath, timeoutMs: 1000 })

const attachRequest = (
  controllerInstanceId: string,
  overrides: Partial<BrokerAttachRequest> = {}
): BrokerAttachRequest => ({
  ...runtimeIdentity,
  controllerInstanceId,
  clientCapabilities: { eventReplay: true },
  ...overrides,
})

const startDurableInvocation = async (client: BrokerClient, scenario = 'start-fresh-turn') => {
  await client.hello(helloRequest({ eventReplay: true }))
  const startRequest = {
    spec: codexSpec(scenario, {
      invocationId: runtimeIdentity.invocationId,
      correlation: {
        runtimeId: runtimeIdentity.runtimeId,
        hostSessionId: runtimeIdentity.hostSessionId,
        startRequestHash: runtimeIdentity.startRequestHash,
        selectedProfileHash: runtimeIdentity.selectedProfileHash,
      },
    }),
  }
  const started = await client.startInvocationFromRequest(startRequest)
  await collectUntil(started.events, 'invocation.ready')
  return started
}

describe('broker durability unix red tests for T-01793 Phase C1', () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test('broker.attach accepts matching identity/token and rejects mismatched generation or token', async () => {
    // C1 only: permission reconnect is deliberately excluded. This verifies the
    // attach identity gate over the real unix JSON-RPC transport.
    const { broker, socketPath } = await startUnixBroker()
    let client: BrokerClient | undefined
    try {
      client = await connect(socketPath)
      const { invocationId } = await startDurableInvocation(client)

      await client.close()
      client = await connect(socketPath)

      await expect(client.attach(attachRequest('controller-ok'))).resolves.toMatchObject({
        attached: true,
        runtimeId: runtimeIdentity.runtimeId,
        generation: runtimeIdentity.generation,
        invocationId,
        activeControllerInstanceId: 'controller-ok',
        snapshot: {
          invocationId,
          pendingPermissionRequests: [],
        },
      })

      await expect(
        client.attach(attachRequest('controller-bad-generation', { generation: 2 }))
      ).rejects.toMatchObject({ code: BrokerErrorCode.AttachRejected })
      await expect(
        client.attach(attachRequest('controller-bad-token', { attachToken: 'wrong-token' }))
      ).rejects.toMatchObject({ code: BrokerErrorCode.AttachRejected })
    } finally {
      await client?.close().catch(() => {})
      if (isPidAlive(broker.pid)) broker.kill('SIGTERM')
      await broker.exited.catch(() => {})
    }
  })

  test('latest valid attach fences the previous controller and only active controller can ack events', async () => {
    const { broker, socketPath } = await startUnixBroker()
    let first: BrokerClient | undefined
    let second: BrokerClient | undefined
    let firstClose: Promise<unknown> | undefined
    try {
      first = await connect(socketPath)
      const { invocationId } = await startDurableInvocation(first)
      await first.attach(attachRequest('controller-first'))
      firstClose = new Promise((resolve) => first?.onClose(resolve))

      second = await connect(socketPath)
      await expect(second.attach(attachRequest('controller-second'))).resolves.toMatchObject({
        activeControllerInstanceId: 'controller-second',
      })

      await withTimeout(firstClose, 1000, 'first controller was not fenced')
      await expect(
        first.ackEvents({ invocationId, throughSeq: 1, controllerInstanceId: 'controller-first' })
      ).rejects.toMatchObject({ code: BrokerErrorCode.ControllerFenced })
      await expect(
        second.ackEvents({ invocationId, throughSeq: 1, controllerInstanceId: 'controller-second' })
      ).resolves.toMatchObject({ ackedThroughSeq: 1 })
    } finally {
      await first?.close().catch(() => {})
      await second?.close().catch(() => {})
      if (isPidAlive(broker.pid)) broker.kill('SIGTERM')
      await broker.exited.catch(() => {})
    }
  })

  test('eventsSince replays non-empty and empty ranges and rejects below retention floor', async () => {
    const { broker, socketPath } = await startUnixBroker()
    let client: BrokerClient | undefined
    try {
      client = await connect(socketPath)
      const { invocationId, events } = await startDurableInvocation(client)
      const inputResponse = await client.input({
        invocationId,
        input: userInput('Create replayable broker events for T-01793 C1.'),
      })
      expect(inputResponse.accepted).toBe(true)
      const replayable = await collectUntil(events, 'turn.completed')
      const currentSeq = Math.max(...replayable.map((item) => item.seq))

      const nonEmpty = await client.eventsSince({ invocationId, afterSeq: 0 })
      expect(nonEmpty.events.length).toBeGreaterThan(0)
      expect(nonEmpty.events.map((item) => item.seq)).toEqual(
        [...nonEmpty.events].map((item) => item.seq).sort((a, b) => a - b)
      )

      await expect(
        client.eventsSince({ invocationId, afterSeq: currentSeq })
      ).resolves.toMatchObject({
        events: [],
        currentSeq,
      })

      await client.ackEvents({
        invocationId,
        throughSeq: currentSeq,
        controllerInstanceId: 'controller-replay',
      })
      await expect(client.eventsSince({ invocationId, afterSeq: -1 })).rejects.toMatchObject({
        code: BrokerErrorCode.EventReplayUnavailable,
      })
    } finally {
      await client?.close().catch(() => {})
      if (isPidAlive(broker.pid)) broker.kill('SIGTERM')
      await broker.exited.catch(() => {})
    }
  })

  test('snapshot includes event bounds, pending input IDs, input dispositions, and terminal surface fields', async () => {
    const { broker, socketPath } = await startUnixBroker()
    let client: BrokerClient | undefined
    try {
      client = await connect(socketPath)
      const { invocationId } = await startDurableInvocation(client, 'three-turns')
      const firstInput = {
        inputId: 'input_T01793_snapshot',
        kind: 'user' as const,
        content: [{ type: 'text' as const, text: 'Record this disposition in snapshot.' }],
      }
      const inputResponse = await client.input({ invocationId, input: firstInput })
      const snapshot = await client.snapshot({ invocationId })

      expect(snapshot).toMatchObject({
        invocationId,
        currentSeq: expect.any(Number),
        retentionFloorSeq: expect.any(Number),
        pendingPermissionRequests: [],
        inputDispositions: {
          [firstInput.inputId]: inputResponse,
        },
      })
      expect(snapshot.pendingInputIds).toEqual(expect.any(Array))
      expect(snapshot.process?.brokerPid).toEqual(expect.any(Number))
    } finally {
      await client?.close().catch(() => {})
      if (isPidAlive(broker.pid)) broker.kill('SIGTERM')
      await broker.exited.catch(() => {})
    }
  })

  test('inputId idempotency returns the original response for identical input and rejects conflicting content', async () => {
    const { broker, socketPath } = await startUnixBroker()
    let client: BrokerClient | undefined
    try {
      client = await connect(socketPath)
      const { invocationId } = await startDurableInvocation(client, 'three-turns')
      const input = {
        inputId: 'input_T01793_idempotent',
        kind: 'user' as const,
        content: [{ type: 'text' as const, text: 'Idempotent retry payload.' }],
      }

      const first: InvocationInputResponse = await client.input({ invocationId, input })
      const duplicate = await client.input({ invocationId, input: structuredClone(input) })
      expect(duplicate).toEqual(first)

      await expect(
        client.input({
          invocationId,
          input: {
            ...input,
            content: [{ type: 'text', text: 'Conflicting retry payload.' }],
          },
        })
      ).rejects.toMatchObject({ code: BrokerErrorCode.DuplicateInputConflict })
    } finally {
      await client?.close().catch(() => {})
      if (isPidAlive(broker.pid)) broker.kill('SIGTERM')
      await broker.exited.catch(() => {})
    }
  })
})
