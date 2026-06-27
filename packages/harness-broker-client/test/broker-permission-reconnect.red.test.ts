import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrokerClient } from 'spaces-harness-broker-client'
import {
  type BrokerAttachRequest,
  BrokerErrorCode,
  type InvocationPermissionRespondRequest,
  type InvocationPermissionRespondResponse,
  type PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import {
  brokerCommand,
  brokerProcessEnv,
  codexSpec,
  collectUntil,
  repoRoot,
  userInput,
  withTimeout,
} from './helpers'

const tmpDirs: string[] = []

const runtimeIdentity = {
  runtimeId: 'runtime_T01796_c2',
  hostSessionId: 'hostSession_T01796_c2',
  generation: 1,
  invocationId: 'inv_client_t01796_c2',
  startRequestHash: 'start_hash_T01796_c2',
  selectedProfileHash: 'profile_hash_T01796_c2',
  attachToken: 'attach-token-T01796-c2',
}

type PermissionRespondCapableClient = BrokerClient & {
  permissionRespond(
    request: InvocationPermissionRespondRequest
  ): Promise<InvocationPermissionRespondResponse>
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
  const dir = await mkdtemp(join(tmpdir(), 'harness-broker-permission-c2-'))
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
  clientCapabilities: { eventReplay: true, permissionRequests: true },
  ...overrides,
})

const helloWithPermissions = (client: BrokerClient): Promise<unknown> =>
  client.hello({
    clientInfo: { name: 'permission-reconnect-red-test', version: '0.1.0' },
    protocolVersions: ['harness-broker/0.2'],
    capabilities: { eventReplay: true, permissionRequests: true },
  })

const permissionSpec = (timeoutMs = 600) =>
  codexSpec('permission-request', {
    invocationId: runtimeIdentity.invocationId,
    correlation: {
      runtimeId: runtimeIdentity.runtimeId,
      hostSessionId: runtimeIdentity.hostSessionId,
      startRequestHash: runtimeIdentity.startRequestHash,
      selectedProfileHash: runtimeIdentity.selectedProfileHash,
    },
    driver: {
      kind: 'codex-app-server',
      resumeFallback: 'start-fresh',
      permissionPolicy: { mode: 'ask-client', timeoutMs, defaultDecision: 'allow' },
    },
  })

const startReadyInvocation = async (client: BrokerClient, timeoutMs?: number) => {
  await helloWithPermissions(client)
  const started = await client.startInvocationFromRequest({ spec: permissionSpec(timeoutMs) })
  await collectUntil(started.events, 'invocation.ready')
  return started
}

const nextPermissionRequest = (client: BrokerClient) => {
  let resolveRequest!: (request: PermissionRequestParams) => void
  const requestPromise = new Promise<PermissionRequestParams>((resolve) => {
    resolveRequest = resolve
  })

  client.onPermissionRequest(async (request) => {
    resolveRequest(request)
    return new Promise(() => {
      // T-01796: keep the broker-owned permission pending until a reconnect
      // response or absolute deadline settles it. The old JSON-RPC request
      // promise must not own this lifecycle anymore.
    })
  })

  return requestPromise
}

describe('broker permission reconnect red tests for T-01796 Phase C2', () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test('pending permission survives controller disconnect and appears in attach snapshot with absolute deadlineAt', async () => {
    // T-01796 C2: permission.requested is an audit event emitted before the
    // broker-to-client request, and the pending request is broker-owned across
    // controller disconnect until deadlineAt.
    const { broker, socketPath } = await startUnixBroker()
    let first: BrokerClient | undefined
    let second: BrokerClient | undefined
    try {
      first = await connect(socketPath)
      const requestPromise = nextPermissionRequest(first)
      const { invocationId, events } = await startReadyInvocation(first)
      const requestedEventPromise = collectUntil(events, 'permission.requested').then((seen) =>
        seen.at(-1)
      )

      const inputPromise = first
        .input({
          invocationId,
          input: userInput('Trigger a reconnectable permission request for T-01796 C2.'),
        })
        .catch(() => undefined)

      const permissionRequest = await withTimeout(
        requestPromise,
        1000,
        'broker did not send a permission request to the client'
      )
      const requestedEvent = await withTimeout(
        requestedEventPromise,
        1000,
        'permission.requested audit event was not emitted'
      )

      expect(requestedEvent?.payload).toMatchObject({
        permissionRequestId: permissionRequest.permissionRequestId,
        defaultDecision: 'allow',
      })

      await first.close()
      await inputPromise

      second = await connect(socketPath)
      await helloWithPermissions(second)
      const attached = await second.attach(attachRequest('controller-reconnect'))

      expect(attached.snapshot.pendingPermissionRequests).toHaveLength(1)
      expect(attached.snapshot.pendingPermissionRequests[0]).toMatchObject({
        invocationId,
        permissionRequestId: permissionRequest.permissionRequestId,
        defaultDecision: 'allow',
      })
      const deadlineAt = (
        attached.snapshot.pendingPermissionRequests[0] as { deadlineAt?: unknown }
      ).deadlineAt
      expect(typeof deadlineAt).toBe('string')
      expect(Date.parse(deadlineAt as string)).toBeGreaterThan(Date.now())
    } finally {
      await first?.close().catch(() => {})
      await second?.close().catch(() => {})
      if (isPidAlive(broker.pid)) broker.kill('SIGTERM')
      await broker.exited.catch(() => {})
    }
  })

  test('deadline expiry applies defaultDecision and emits permission.resolved decidedBy timeout', async () => {
    // T-01796 C2: timeout settlement must come from the broker-owned pending
    // request state, not from a controller socket closing or a handler error.
    const { broker, socketPath } = await startUnixBroker()
    let client: BrokerClient | undefined
    try {
      client = await connect(socketPath)
      const requestPromise = nextPermissionRequest(client)
      const { invocationId, events } = await startReadyInvocation(client, 180)

      const inputPromise = client
        .input({
          invocationId,
          input: userInput('Trigger a permission request that should timeout to allow.'),
        })
        .catch(() => undefined)

      const permissionRequest = await withTimeout(
        requestPromise,
        1000,
        'broker did not send a permission request to the client'
      )

      const beforeTimeout = await client.snapshot({ invocationId })
      expect(beforeTimeout.pendingPermissionRequests).toHaveLength(1)
      expect(beforeTimeout.pendingPermissionRequests[0]).toMatchObject({
        permissionRequestId: permissionRequest.permissionRequestId,
        defaultDecision: 'allow',
      })

      const resolvedEvents = await collectUntil(events, 'permission.resolved', 1000)
      const resolved = resolvedEvents.at(-1)
      expect(resolved?.payload).toMatchObject({
        permissionRequestId: permissionRequest.permissionRequestId,
        decision: 'allow',
        decidedBy: 'timeout',
      })

      const afterTimeout = await client.snapshot({ invocationId })
      expect(afterTimeout.pendingPermissionRequests).toEqual([])
      await inputPromise
    } finally {
      await client?.close().catch(() => {})
      if (isPidAlive(broker.pid)) broker.kill('SIGTERM')
      await broker.exited.catch(() => {})
    }
  })

  test('invocation.permission.respond is idempotent and rejects conflict, expired, and unknown requests', async () => {
    // T-01796 C2: reconnect controllers settle pending permission requests by
    // permissionRequestId. Duplicate same-decision responses replay the
    // original result; different decisions, expired IDs, and unknown IDs use
    // the Phase A broker error codes.
    const { broker, socketPath } = await startUnixBroker()
    let client: PermissionRespondCapableClient | undefined
    try {
      client = (await connect(socketPath)) as PermissionRespondCapableClient
      const requestPromise = nextPermissionRequest(client)
      const { invocationId } = await startReadyInvocation(client, 160)

      const inputPromise = client
        .input({
          invocationId,
          input: userInput('Trigger a permission request that will be answered by respond.'),
        })
        .catch(() => undefined)

      const permissionRequest = await withTimeout(
        requestPromise,
        1000,
        'broker did not send a permission request to the client'
      )
      const response = {
        invocationId,
        permissionRequestId: permissionRequest.permissionRequestId,
        decision: 'deny' as const,
        controllerInstanceId: 'controller-respond',
      }

      await expect(client.permissionRespond(response)).resolves.toEqual({
        status: 'accepted',
        permissionRequestId: permissionRequest.permissionRequestId,
        decision: 'deny',
      })
      await expect(client.permissionRespond(response)).resolves.toEqual({
        status: 'duplicate',
        permissionRequestId: permissionRequest.permissionRequestId,
        originalDecision: 'deny',
      })
      await expect(
        client.permissionRespond({ ...response, decision: 'allow' })
      ).rejects.toMatchObject({ code: BrokerErrorCode.PermissionResponseConflict })
      await inputPromise

      await expect(
        client.permissionRespond({
          invocationId,
          permissionRequestId: 'perm_T01796_unknown',
          decision: 'deny',
          controllerInstanceId: 'controller-respond',
        })
      ).rejects.toMatchObject({ code: BrokerErrorCode.UnknownPermissionRequest })

      const expiredRequestPromise = nextPermissionRequest(client)
      const expiredInputPromise = client
        .input({
          invocationId,
          input: userInput('Trigger a permission request that expires before respond.'),
        })
        .catch(() => undefined)
      const expiredRequest = await withTimeout(
        expiredRequestPromise,
        1000,
        'broker did not send an expiring permission request to the client'
      )
      await Bun.sleep(260)
      await expect(
        client.permissionRespond({
          invocationId,
          permissionRequestId: expiredRequest.permissionRequestId,
          decision: 'deny',
          controllerInstanceId: 'controller-respond',
        })
      ).rejects.toMatchObject({ code: BrokerErrorCode.PermissionResponseExpired })
      await expiredInputPromise
    } finally {
      await client?.close().catch(() => {})
      if (isPidAlive(broker.pid)) broker.kill('SIGTERM')
      await broker.exited.catch(() => {})
    }
  })
})
