import type { Readable, Writable } from 'node:stream'
import {
  validateAspcCommand,
  validateAspcCompileAndStartRequest,
  validateAspcCompileHarnessInvocationRequest,
  validateAspcCompileRuntimePlanRequest,
  validateAspcHelloRequest,
} from 'spaces-aspc-protocol'
import { createDefaultBroker, createProtocolServer } from 'spaces-harness-broker'
import type { Broker, ProtocolServer } from 'spaces-harness-broker'
import type {
  InvocationDispatchRequest,
  InvocationEventEnvelope,
  JsonRpcNotification,
  PermissionDecision,
} from 'spaces-harness-broker-protocol'
import { validateCommand } from 'spaces-harness-broker-protocol'
import type { AspcCompiler } from './service.js'
import { createAspcService } from './service.js'

export interface AspcFacadeOptions {
  stdin: Readable
  stdout: Writable
  stderr: Writable
  broker?: Broker | undefined
  compiler?: AspcCompiler | undefined
}

export function createAspcFacadeServer(options: AspcFacadeOptions): ProtocolServer {
  const server = createProtocolServer({
    stdin: options.stdin,
    stdout: options.stdout,
    stderr: options.stderr,
  })

  function emitEvent(event: InvocationEventEnvelope): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'invocation.event',
      params: event,
    }
    server.notify(notification)
  }

  const broker =
    options.broker ??
    createDefaultBroker(
      (event) => emitEvent(event),
      (params) => server.request<PermissionDecision>('invocation.permission.request', params)
    )
  const aspc = createAspcService({ broker, compiler: options.compiler })

  server.register('aspc.hello', async ({ id, method, params }) => {
    validateAspcCommand({ jsonrpc: '2.0', id, method, params })
    return aspc.hello(validateAspcHelloRequest(params))
  })

  server.register('aspc.compileRuntimePlan', async ({ id, method, params }) => {
    validateAspcCommand({ jsonrpc: '2.0', id, method, params })
    return aspc.compileRuntimePlan(validateAspcCompileRuntimePlanRequest(params))
  })

  server.register('aspc.compileHarnessInvocation', async ({ id, method, params }) => {
    validateAspcCommand({ jsonrpc: '2.0', id, method, params })
    return aspc.compileHarnessInvocation(validateAspcCompileHarnessInvocationRequest(params))
  })

  server.register('aspc.compileAndStart', async ({ id, method, params }) => {
    validateAspcCommand({ jsonrpc: '2.0', id, method, params })
    return aspc.compileAndStart(validateAspcCompileAndStartRequest(params))
  })

  registerBrokerMethods(server, broker)
  return server
}

export function runAspcFacadeStdio(
  options: Omit<AspcFacadeOptions, 'stdin' | 'stdout' | 'stderr'> = {}
): void {
  const server = createAspcFacadeServer({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    ...options,
  })

  void server.start()

  process.stdin.on('end', () => {
    void server.close().then(() => {
      process.exit(0)
    })
  })
}

function registerBrokerMethods(server: ProtocolServer, broker: Broker): void {
  function validateParams(method: string, id: string | number | null, params: unknown): void {
    validateCommand({ jsonrpc: '2.0', id, method, params })
  }

  server.register('broker.hello', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.hello(params as Parameters<typeof broker.hello>[0])
  })

  server.register('broker.health', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.health((params ?? {}) as Parameters<typeof broker.health>[0])
  })

  server.register('invocation.start', async ({ id, method, params }) => {
    validateParams(method, id, params)
    const dispatch = params as InvocationDispatchRequest
    return broker.start(
      dispatch.startRequest,
      dispatch.dispatchEnv,
      dispatch.runtime,
      dispatch.lifecyclePolicy
    )
  })

  server.register('invocation.input', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.input(params as Parameters<typeof broker.input>[0])
  })

  server.register('invocation.interrupt', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.interrupt(params as Parameters<typeof broker.interrupt>[0])
  })

  server.register('invocation.stop', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.stop(params as Parameters<typeof broker.stop>[0])
  })

  server.register('invocation.status', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.status(params as Parameters<typeof broker.status>[0])
  })

  server.register('invocation.dispose', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.dispose(params as Parameters<typeof broker.dispose>[0])
  })
}
