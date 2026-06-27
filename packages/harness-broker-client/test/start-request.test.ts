import { describe, expect, test } from 'bun:test'
import { BrokerClient } from 'spaces-harness-broker-client'
import type { InvocationInput, InvocationStartRequest } from 'spaces-harness-broker-protocol'
import { conservativeDefaultLifecyclePolicyOverlay } from 'spaces-harness-broker-protocol'
import {
  brokerArgs,
  brokerCommand,
  brokerEnvOverrides,
  codexSpec,
  collectUntil,
  helloRequest,
  repoRoot,
  withTimeout,
} from './helpers'

const fakeBrokerScript = String.raw`
const assert = require('node:assert/strict')
const readline = require('node:readline')

const rl = readline.createInterface({ input: process.stdin })
const mode = process.argv[1]
const expectedParams = process.argv[2] ? JSON.parse(process.argv[2]) : undefined
let seq = 1

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function response(id, result) {
  write({ jsonrpc: '2.0', id, result })
}

function error(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } })
}

function notify(invocationId, type, payload) {
  write({
    jsonrpc: '2.0',
    method: 'invocation.event',
    params: {
      invocationId,
      seq: seq++,
      time: '2026-05-20T19:30:00.000Z',
      type,
      payload,
    },
  })
}

function startResponse(invocationId) {
  return {
    invocationId,
    state: 'ready',
    capabilities: {
      input: true,
      interrupt: true,
      stop: true,
      dispose: true,
    },
  }
}

rl.on('line', (line) => {
  const message = JSON.parse(line)

  if (message.method === 'broker.hello') {
    response(message.id, {
      brokerInfo: { name: 'fake-start-request-broker', version: '0.1.0' },
      protocolVersion: 'harness-broker/0.2',
      capabilities: {
        multiInvocation: false,
        transports: ['stdio-jsonrpc-ndjson'],
        eventNotifications: true,
        brokerToClientRequests: false,
      },
      drivers: [],
    })
    return
  }

  if (message.method === 'invocation.start') {
    if (mode === 'exact-request') {
      try {
        assert.deepStrictEqual(message.params, expectedParams)
      } catch (err) {
        error(message.id, -32000, err.message)
        return
      }

      const invocationId = message.params.startRequest.spec.invocationId
      notify(invocationId, 'invocation.started', { command: 'fake', args: [], cwd: process.cwd() })
      notify(invocationId, 'invocation.ready', { state: 'ready' })
      response(message.id, startResponse(invocationId))
      return
    }

    if (mode === 'early-started') {
      const invocationId = message.params.startRequest.spec.invocationId
      notify(invocationId, 'invocation.started', { command: 'fake', args: [], cwd: process.cwd() })
      setTimeout(() => {
        notify(invocationId, 'invocation.ready', { state: 'ready' })
        response(message.id, startResponse(invocationId))
      }, 25)
      return
    }

    if (mode === 'legacy-equivalence') {
      const invocationId = message.params.startRequest.spec.invocationId
      if (message.params.startRequest.initialInput?.inputId !== 'input_legacy_delegate') {
        error(message.id, -32000, 'legacy startInvocation did not forward initialInput')
        return
      }
      notify(invocationId, 'invocation.started', { command: 'fake', args: [], cwd: process.cwd() })
      notify(invocationId, 'invocation.ready', { state: 'ready' })
      response(message.id, startResponse(invocationId))
      return
    }
  }
})

setTimeout(() => process.exit(0), 120)
`

function fakeBrokerArgs(mode: string, expectedParams?: unknown): string[] {
  const args = ['--eval', fakeBrokerScript, mode]
  if (expectedParams !== undefined) {
    args.push(JSON.stringify(expectedParams))
  }
  return args
}

const initialInput: InvocationInput = {
  inputId: 'input_start_request',
  kind: 'user',
  content: [{ type: 'text', text: 'Initial input must pass through unchanged.' }],
  metadata: { source: 'red-test' },
}

describe('BrokerClient startInvocationFromRequest', () => {
  test('sends the InvocationDispatchRequest envelope wrapping a verbatim startRequest', async () => {
    const request: InvocationStartRequest = {
      spec: codexSpec('start-fresh-turn', {
        invocationId: 'inv_client_start_request_exact_params',
        labels: {
          package: 'harness-broker-client',
          scenario: 'start-fresh-turn',
          nested: 'preserved',
        },
      }),
      initialInput,
    }
    // With no dispatchEnv, the wire payload is exactly { startRequest }.
    const client = await BrokerClient.start({
      command: process.execPath,
      args: fakeBrokerArgs('exact-request', { startRequest: request }),
      cwd: repoRoot,
      env: brokerEnvOverrides(),
    })

    try {
      await client.hello(helloRequest())
      const { invocationId, response, events } = await client.startInvocationFromRequest(request)

      expect(invocationId).toBe(request.spec.invocationId)
      expect(response).toMatchObject({ invocationId, state: 'ready' })
      const startupEvents = await collectUntil(events, 'invocation.ready')
      expect(startupEvents.map((event) => event.type)).toEqual([
        'invocation.started',
        'invocation.ready',
      ])
    } finally {
      await client.close()
    }
  })

  test('threads dispatchEnv into the InvocationDispatchRequest envelope alongside the verbatim startRequest', async () => {
    const request: InvocationStartRequest = {
      spec: codexSpec('start-fresh-turn', {
        invocationId: 'inv_client_start_request_dispatch_env',
      }),
      initialInput,
    }
    const dispatchEnv = { AGENT_SCOPE_REF: 'agent:curly:project:p:task:t' }
    const client = await BrokerClient.start({
      command: process.execPath,
      args: fakeBrokerArgs('exact-request', { startRequest: request, dispatchEnv }),
      cwd: repoRoot,
      env: brokerEnvOverrides(),
    })

    try {
      await client.hello(helloRequest())
      const { invocationId, response } = await client.startInvocationFromRequest(
        request,
        dispatchEnv
      )
      expect(invocationId).toBe(request.spec.invocationId)
      expect(response).toMatchObject({ invocationId, state: 'ready' })
    } finally {
      await client.close()
    }
  })

  test('threads runtime into the InvocationDispatchRequest envelope alongside the verbatim startRequest', async () => {
    const request: InvocationStartRequest = {
      spec: codexSpec('start-fresh-turn', {
        invocationId: 'inv_client_start_request_runtime',
      }),
      initialInput,
    }
    const runtime = { tmux: { socketPath: '/tmp/client-runtime-overlay.sock' } }
    const client = await BrokerClient.start({
      command: process.execPath,
      args: fakeBrokerArgs('exact-request', { startRequest: request, runtime }),
      cwd: repoRoot,
      env: brokerEnvOverrides(),
    })

    try {
      await client.hello(helloRequest())
      const { invocationId, response } = await client.startInvocationFromRequest(
        request,
        undefined,
        runtime
      )
      expect(invocationId).toBe(request.spec.invocationId)
      expect(response).toMatchObject({ invocationId, state: 'ready' })
    } finally {
      await client.close()
    }
  })

  test('threads lifecyclePolicy through the options-object dispatch envelope', async () => {
    const request: InvocationStartRequest = {
      spec: codexSpec('start-fresh-turn', {
        invocationId: 'inv_client_start_request_lifecycle_policy',
      }),
      initialInput,
    }
    const dispatchEnv = { AGENT_SCOPE_REF: 'agent:curly:project:p:task:t' }
    const lifecyclePolicy = conservativeDefaultLifecyclePolicyOverlay('policy_client_default')
    const client = await BrokerClient.start({
      command: process.execPath,
      args: fakeBrokerArgs('exact-request', {
        startRequest: request,
        dispatchEnv,
        lifecyclePolicy,
      }),
      cwd: repoRoot,
      env: brokerEnvOverrides(),
    })

    try {
      await client.hello(helloRequest())
      const { invocationId, response } = await client.startInvocationFromRequest(request, {
        dispatchEnv,
        lifecyclePolicy,
      })
      expect(invocationId).toBe(request.spec.invocationId)
      expect(response).toMatchObject({ invocationId, state: 'ready' })
    } finally {
      await client.close()
    }
  })

  test('starts from an exact InvocationStartRequest and drives a Codex fake turn', async () => {
    const client = await BrokerClient.start({
      command: brokerCommand,
      args: brokerArgs,
      cwd: repoRoot,
      env: brokerEnvOverrides(),
    })

    try {
      await client.hello(helloRequest())
      const request: InvocationStartRequest = { spec: codexSpec('start-fresh-turn') }
      const { invocationId, response, events } = await client.startInvocationFromRequest(request)

      expect(invocationId).toBe(request.spec.invocationId)
      expect(response).toMatchObject({ invocationId, state: 'ready' })

      const startupEvents = await collectUntil(events, 'invocation.ready')
      expect(startupEvents.map((event) => event.type)).toEqual([
        'invocation.started',
        'continuation.updated',
        'invocation.ready',
      ])

      await client.stop({ invocationId, reason: 'start request red test complete', graceMs: 50 })
      await client.dispose({ invocationId })
    } finally {
      await client.close()
    }
  })

  test('does not mutate the caller request after a successful start', async () => {
    const client = await BrokerClient.start({
      command: brokerCommand,
      args: brokerArgs,
      cwd: repoRoot,
      env: brokerEnvOverrides(),
    })

    try {
      await client.hello(helloRequest())
      const request: InvocationStartRequest = {
        spec: codexSpec('start-fresh-turn', {
          invocationId: 'inv_client_start_request_success_immutable',
        }),
        initialInput,
      }
      const original = structuredClone(request)

      const { invocationId, events } = await client.startInvocationFromRequest(request)
      await collectUntil(events, 'turn.completed')

      expect(request).toEqual(original)
      await client.stop({ invocationId, reason: 'immutability red test complete', graceMs: 50 })
      await client.dispose({ invocationId })
    } finally {
      await client.close()
    }
  })

  test('does not mutate the caller request after a rejected start', async () => {
    const client = await BrokerClient.start({
      command: brokerCommand,
      args: brokerArgs,
      cwd: repoRoot,
      env: brokerEnvOverrides(),
    })

    try {
      await client.hello(helloRequest())
      const request = {
        spec: {
          ...codexSpec('start-fresh-turn', {
            invocationId: 'inv_client_start_request_reject_immutable',
          }),
          specVersion: 'invalid-spec-version',
        },
        initialInput,
      } as unknown as InvocationStartRequest
      const original = structuredClone(request)

      await expect(client.startInvocationFromRequest(request)).rejects.toThrow()
      expect(request).toEqual(original)
    } finally {
      await client.close()
    }
  })

  test('does not lose early invocation.started events for a known invocationId', async () => {
    const client = await BrokerClient.start({
      command: process.execPath,
      args: fakeBrokerArgs('early-started'),
      cwd: repoRoot,
      env: brokerEnvOverrides(),
    })

    try {
      await client.hello(helloRequest())
      const request: InvocationStartRequest = {
        spec: codexSpec('start-fresh-turn', {
          invocationId: 'inv_client_start_request_early_started',
        }),
      }

      const { events } = await client.startInvocationFromRequest(request)
      const startupEvents = await collectUntil(events, 'invocation.ready')
      expect(startupEvents.map((event) => event.type)).toEqual([
        'invocation.started',
        'invocation.ready',
      ])
    } finally {
      await client.close()
    }
  })

  test('legacy startInvocation delegates through the same request shape with initialInput', async () => {
    const client = await BrokerClient.start({
      command: process.execPath,
      args: fakeBrokerArgs('legacy-equivalence'),
      cwd: repoRoot,
      env: brokerEnvOverrides(),
    })

    try {
      await client.hello(helloRequest())
      const input: InvocationInput = {
        inputId: 'input_legacy_delegate',
        kind: 'user',
        content: [{ type: 'text', text: 'legacy path should delegate' }],
      }
      const { invocationId, events } = await client.startInvocation(
        codexSpec('start-fresh-turn', {
          invocationId: 'inv_client_start_request_legacy_delegate',
        }),
        input
      )

      expect(invocationId).toBe('inv_client_start_request_legacy_delegate')
      const startupEvents = await collectUntil(events, 'invocation.ready')
      expect(startupEvents.map((event) => event.type)).toEqual([
        'invocation.started',
        'invocation.ready',
      ])
    } finally {
      await client.close()
    }
  })

  test('onClose handler fires and closes event iterators when the broker exits mid-stream', async () => {
    const client = await BrokerClient.start({
      command: process.execPath,
      args: fakeBrokerArgs('early-started'),
      cwd: repoRoot,
      env: brokerEnvOverrides(),
    })
    let closeError: Error | undefined
    client.onClose((error) => {
      closeError = error
    })

    try {
      await client.hello(helloRequest())
      const { events } = await client.startInvocationFromRequest({
        spec: codexSpec('start-fresh-turn', {
          invocationId: 'inv_client_start_request_on_close',
        }),
      })
      await collectUntil(events, 'invocation.ready')

      const iterator = events[Symbol.asyncIterator]()
      const result = await withTimeout(iterator.next(), 1000, 'event iterator did not terminate')
      expect(result).toEqual({ done: true, value: undefined })
      expect(closeError).toMatchObject({
        name: expect.stringMatching(/Transport|BrokerTransport/),
      })
    } finally {
      await client.close().catch(() => {})
    }
  })
})
