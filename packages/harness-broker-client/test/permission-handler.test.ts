import { describe, expect, test } from 'bun:test'
import { BrokerClient } from 'spaces-harness-broker-client'
import type {
  InvocationEventEnvelope,
  PermissionDecision,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import { collectUntil, repoRoot } from './helpers'

const fakeBrokerScript = String.raw`
const readline = require('node:readline')

const rl = readline.createInterface({ input: process.stdin })
const mode = process.argv[1]
const invocationId = 'inv_client_permission_contract'
const turnId = 'turn_client_permission_contract'
let nextRequestId = 1

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
    params: {
      invocationId,
      seq: nextRequestId++,
      time: '2026-05-20T19:30:00.000Z',
      type,
      payload,
      turnId,
    },
  })
}

function notifyLegacyPermissionRequest() {
  write({
    jsonrpc: '2.0',
    method: 'invocation.event',
    params: {
      invocationId,
      seq: nextRequestId++,
      time: '2026-05-20T19:30:00.000Z',
      type: 'invocation.permission.request',
      payload: {
        permissionRequestId: 'perm_client_legacy_event',
        kind: 'command',
        subject: { command: 'printf legacy-event' },
        defaultDecision: 'deny',
      },
      turnId,
    },
  })
}

function requestPermission() {
  write({
    jsonrpc: '2.0',
    id: 'broker_perm_1',
    method: 'invocation.permission.request',
    params: {
      invocationId,
      turnId,
      permissionRequestId: 'perm_client_contract',
      kind: 'command',
      subject: { command: 'printf red-test' },
      defaultDecision: mode === 'request-default-deny' ? 'deny' : 'allow',
      deadlineMs: 1000,
    },
  })
}

rl.on('line', (line) => {
  const message = JSON.parse(line)

  if (message.method === 'broker.hello') {
    response(message.id, {
      brokerInfo: { name: 'fake-permission-broker', version: '0.1.0' },
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
    if (mode === 'legacy-event-only') {
      notifyLegacyPermissionRequest()
      notify('turn.completed', { finalOutput: 'legacy event ignored' })
      return
    }
    notify('permission.requested', {
      permissionRequestId: 'perm_client_contract',
      kind: 'command',
      subjectDisplay: { command: 'printf red-test' },
      defaultDecision: mode === 'event-only' ? 'deny' : 'allow',
      deadlineMs: 1000,
    })
    if (mode === 'event-only') {
      notify('permission.resolved', {
        permissionRequestId: 'perm_client_contract',
        decision: 'deny',
        decidedBy: 'policy',
      })
      notify('turn.completed', { finalOutput: 'audit-only completed' })
    } else {
      requestPermission()
    }
    return
  }

  if (message.id === 'broker_perm_1') {
    const decision = message.result && message.result.decision
    notify('permission.resolved', {
      permissionRequestId: 'perm_client_contract',
      decision,
      decidedBy: 'user',
    })
    notify('turn.completed', {
      finalOutput: decision === 'allow' ? 'permission approved' : 'permission denied',
    })
  }
})
`

function fakeBrokerArgs(mode: string): string[] {
  return ['--eval', fakeBrokerScript, mode]
}

async function runClientScenario(options: {
  mode: string
  handler?: ((request: PermissionRequestParams) => Promise<PermissionDecision>) | undefined
}): Promise<{
  requests: PermissionRequestParams[]
  turnEvents: InvocationEventEnvelope[]
}> {
  const client = await BrokerClient.start({
    command: process.execPath,
    args: fakeBrokerArgs(options.mode),
    cwd: repoRoot,
  })
  const requests: PermissionRequestParams[] = []

  if (options.handler) {
    client.onPermissionRequest(
      async (request: PermissionRequestParams): Promise<PermissionDecision> => {
        requests.push(request)
        return options.handler!(request)
      }
    )
  }

  try {
    await client.hello({
      clientInfo: { name: 'permission-client-red-test', version: '0.1.0' },
      protocolVersions: ['harness-broker/0.2'],
      capabilities: { permissionRequests: true },
    })

    const { invocationId, events } = await client.startInvocation({
      specVersion: 'harness-broker.invocation/v1',
      invocationId: 'inv_client_permission_contract',
      harness: {
        frontend: 'codex',
        provider: 'openai',
        driver: 'codex-app-server',
      },
      process: {
        command: process.execPath,
        args: ['--version'],
        cwd: repoRoot,
        harnessTransport: { kind: 'jsonrpc-stdio' },
      },
      interaction: {
        mode: 'headless',
        turnConcurrency: 'single',
        inputQueue: 'none',
      },
      driver: {
        kind: 'codex-app-server',
        resumeFallback: 'start-fresh',
      },
    })
    await collectUntil(events, 'invocation.ready')
    await client.input({
      invocationId,
      input: {
        inputId: 'input_permission_client_contract',
        kind: 'user',
        content: [{ type: 'text', text: 'Trigger permission request.' }],
      },
    })
    const turnEvents = await collectUntil(events, 'turn.completed')
    return { requests, turnEvents }
  } finally {
    await client.close()
  }
}

describe('BrokerClient permission request callback', () => {
  test('answers inbound invocation.permission.request JSON-RPC requests', async () => {
    const { requests, turnEvents } = await runClientScenario({
      mode: 'request',
      handler: async () => ({ decision: 'allow' }),
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      invocationId: 'inv_client_permission_contract',
      turnId: 'turn_client_permission_contract',
      permissionRequestId: 'perm_client_contract',
      kind: 'command',
      defaultDecision: 'allow',
    })
    expect(turnEvents.find((event) => event.type === 'turn.completed')?.payload).toMatchObject({
      finalOutput: 'permission approved',
    })
  })

  test('treats permission.requested and permission.resolved as observable events only', async () => {
    const { requests, turnEvents } = await runClientScenario({
      mode: 'event-only',
      handler: async () => ({ decision: 'allow' }),
    })

    expect(requests).toHaveLength(0)
    expect(turnEvents.map((event) => event.type)).toContain('permission.requested')
    expect(turnEvents.map((event) => event.type)).toContain('permission.resolved')
    expect(turnEvents.find((event) => event.type === 'turn.completed')?.payload).toMatchObject({
      finalOutput: 'audit-only completed',
    })
  })

  test('does not make permission decisions from legacy event-only simulations', async () => {
    const { requests, turnEvents } = await runClientScenario({
      mode: 'legacy-event-only',
      handler: async () => ({ decision: 'allow' }),
    })

    expect(requests).toHaveLength(0)
    expect(turnEvents.map((event) => event.type as string)).toContain(
      'invocation.permission.request'
    )
    expect(turnEvents.find((event) => event.type === 'turn.completed')?.payload).toMatchObject({
      finalOutput: 'legacy event ignored',
    })
  })

  test('missing client handler returns the defaultDecision', async () => {
    const { requests, turnEvents } = await runClientScenario({
      mode: 'request-default-deny',
    })

    expect(requests).toHaveLength(0)
    expect(turnEvents.find((event) => event.type === 'turn.completed')?.payload).toMatchObject({
      finalOutput: 'permission denied',
    })
  })

  test('failed client handler returns the defaultDecision or deny', async () => {
    const { requests, turnEvents } = await runClientScenario({
      mode: 'request',
      handler: async () => {
        throw new Error('permission handler failed')
      },
    })

    expect(requests).toHaveLength(1)
    expect(turnEvents.find((event) => event.type === 'turn.completed')?.payload).toMatchObject({
      finalOutput: 'permission approved',
    })
  })
})
