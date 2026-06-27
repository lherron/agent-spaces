import { describe, expect, test } from 'bun:test'
import { BrokerClient } from 'spaces-harness-broker-client'
import type { PermissionDecision, PermissionRequestParams } from 'spaces-harness-broker-protocol'
import { brokerEnvOverrides, collectUntil, repoRoot } from './helpers'

// Fake broker that, on `invocation.input`, issues a single inbound
// `invocation.permission.request` JSON-RPC request and reports the decision it
// receives back via the `turn.completed` finalOutput. Used to assert the
// disposer + double-register semantics of `onPermissionRequest`
// (backlog harness-broker-client A4).
const fakeBrokerScript = String.raw`
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const invocationId = 'inv_client_handler_disposer'
const turnId = 'turn_client_handler_disposer'
let seq = 1

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}
function response(id, result) {
  write({ jsonrpc: '2.0', id, result })
}
function notify(type, payload) {
  write({
    jsonrpc: '2.0',
    method: 'invocation.event',
    params: { invocationId, seq: seq++, time: '2026-05-20T19:30:00.000Z', type, payload, turnId },
  })
}

rl.on('line', (line) => {
  const message = JSON.parse(line)

  if (message.method === 'broker.hello') {
    response(message.id, {
      brokerInfo: { name: 'fake-disposer-broker', version: '0.1.0' },
      protocolVersion: 'harness-broker/0.2',
      capabilities: {
        multiInvocation: false,
        transports: ['stdio-jsonrpc-ndjson'],
        eventNotifications: true,
        brokerToClientRequests: true,
      },
      drivers: [],
    })
    return
  }

  if (message.method === 'invocation.start') {
    response(message.id, { invocationId })
    notify('invocation.ready', { state: 'ready' })
    return
  }

  if (message.method === 'invocation.input') {
    response(message.id, { accepted: true })
    write({
      jsonrpc: '2.0',
      id: 'broker_perm_disposer',
      method: 'invocation.permission.request',
      params: {
        invocationId,
        turnId,
        permissionRequestId: 'perm_client_disposer',
        kind: 'command',
        subject: { command: 'printf disposer' },
        defaultDecision: 'deny',
        deadlineMs: 1000,
      },
    })
    return
  }

  if (message.id === 'broker_perm_disposer') {
    const decision = message.result && message.result.decision
    notify('turn.completed', { finalOutput: decision })
  }
})
`

async function runDecisionScenario(
  register: (client: BrokerClient) => void
): Promise<string | undefined> {
  const client = await BrokerClient.start({
    command: process.execPath,
    args: ['--eval', fakeBrokerScript],
    cwd: repoRoot,
    env: brokerEnvOverrides(),
  })

  register(client)

  try {
    await client.hello({
      clientInfo: { name: 'handler-disposer-test', version: '0.1.0' },
      protocolVersions: ['harness-broker/0.2'],
      capabilities: { permissionRequests: true },
    })
    const { invocationId, events } = await client.startInvocation({
      specVersion: 'harness-broker.invocation/v1',
      invocationId: 'inv_client_handler_disposer',
      harness: { frontend: 'codex', provider: 'openai', driver: 'codex-app-server' },
      process: {
        command: process.execPath,
        args: ['--version'],
        cwd: repoRoot,
        harnessTransport: { kind: 'jsonrpc-stdio' },
      },
      interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'none' },
      driver: { kind: 'codex-app-server', resumeFallback: 'start-fresh' },
    })
    await collectUntil(events, 'invocation.ready')
    await client.input({
      invocationId,
      input: {
        inputId: 'input_handler_disposer',
        kind: 'user',
        content: [{ type: 'text', text: 'trigger permission' }],
      },
    })
    const turnEvents = await collectUntil(events, 'turn.completed')
    return turnEvents.find((event) => event.type === 'turn.completed')?.payload?.finalOutput as
      | string
      | undefined
  } finally {
    await client.close()
  }
}

describe('BrokerClient onPermissionRequest disposer (A4)', () => {
  test('disposing the handler falls back to the broker defaultDecision', async () => {
    const finalOutput = await runDecisionScenario((client) => {
      const allowAll = async (): Promise<PermissionDecision> => ({ decision: 'allow' })
      const dispose = client.onPermissionRequest(allowAll)
      // After disposal no handler is registered, so defaultDecision ('deny') wins.
      dispose()
    })
    expect(finalOutput).toBe('deny')
  })

  test('a second registration replaces the first (last-writer-wins)', async () => {
    const calls: string[] = []
    const finalOutput = await runDecisionScenario((client) => {
      client.onPermissionRequest(async (_req: PermissionRequestParams) => {
        calls.push('first')
        return { decision: 'allow' }
      })
      client.onPermissionRequest(async (_req: PermissionRequestParams) => {
        calls.push('second')
        return { decision: 'allow' }
      })
    })
    expect(finalOutput).toBe('allow')
    expect(calls).toEqual(['second'])
  })

  test('disposing a superseded handler does not clear the active one', async () => {
    const calls: string[] = []
    const finalOutput = await runDecisionScenario((client) => {
      const disposeFirst = client.onPermissionRequest(async () => {
        calls.push('first')
        return { decision: 'allow' }
      })
      client.onPermissionRequest(async () => {
        calls.push('second')
        return { decision: 'allow' }
      })
      // The first disposer must be a no-op now that 'second' is active.
      disposeFirst()
    })
    expect(finalOutput).toBe('allow')
    expect(calls).toEqual(['second'])
  })
})

describe('BrokerClient onClose disposer (A4)', () => {
  test('a disposed close handler does not fire when the broker exits', async () => {
    const client = await BrokerClient.start({
      command: process.execPath,
      // Broker that exits shortly after start so onClose fires.
      args: ['--eval', 'setTimeout(() => process.exit(0), 50)'],
      cwd: repoRoot,
      env: brokerEnvOverrides(),
    })

    let keptFired = false
    let disposedFired = false
    const disposeOne = client.onClose(() => {
      disposedFired = true
    })
    client.onClose(() => {
      keptFired = true
    })
    disposeOne()

    await new Promise<void>((resolve) => {
      client.onClose(() => resolve())
    })

    expect(disposedFired).toBe(false)
    expect(keptFired).toBe(true)
    await client.close().catch(() => {})
  })
})
