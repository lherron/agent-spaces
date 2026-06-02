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

  // Each ASPC route validates the JSON-RPC envelope, narrows params with its
  // typed validator, then forwards to the service. `registerAspcMethod` factors
  // out the shared envelope validation while preserving per-method typing.
  function registerAspcMethod<Params, Result>(
    method: string,
    validateRequest: (params: unknown) => Params,
    handle: (req: Params) => Promise<Result>
  ): void {
    server.register(method, async ({ id, params }) => {
      validateAspcCommand({ jsonrpc: '2.0', id, method, params })
      return handle(validateRequest(params))
    })
  }

  registerAspcMethod('aspc.hello', validateAspcHelloRequest, (req) => aspc.hello(req))
  registerAspcMethod('aspc.compileRuntimePlan', validateAspcCompileRuntimePlanRequest, (req) =>
    aspc.compileRuntimePlan(req)
  )
  registerAspcMethod(
    'aspc.compileHarnessInvocation',
    validateAspcCompileHarnessInvocationRequest,
    (req) => aspc.compileHarnessInvocation(req)
  )
  registerAspcMethod('aspc.compileAndStart', validateAspcCompileAndStartRequest, (req) =>
    aspc.compileAndStart(req)
  )

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

/**
 * Table of broker RPC routes. Each entry validates its params through the
 * broker protocol seam and forwards to the matching `Broker` method, so adding
 * a route is one row rather than another copy-pasted `server.register` block.
 */
function brokerMethodTable(broker: Broker): ReadonlyArray<{
  method: string
  invoke: (params: unknown) => Promise<unknown>
}> {
  return [
    {
      method: 'broker.hello',
      invoke: (params) => broker.hello(params as Parameters<typeof broker.hello>[0]),
    },
    {
      method: 'broker.health',
      invoke: (params) => broker.health((params ?? {}) as Parameters<typeof broker.health>[0]),
    },
    {
      method: 'invocation.start',
      invoke: (params) => {
        const dispatch = params as InvocationDispatchRequest
        return broker.start(
          dispatch.startRequest,
          dispatch.dispatchEnv,
          dispatch.runtime,
          dispatch.lifecyclePolicy
        )
      },
    },
    {
      method: 'invocation.input',
      invoke: (params) => broker.input(params as Parameters<typeof broker.input>[0]),
    },
    {
      method: 'invocation.interrupt',
      invoke: (params) => broker.interrupt(params as Parameters<typeof broker.interrupt>[0]),
    },
    {
      method: 'invocation.stop',
      invoke: (params) => broker.stop(params as Parameters<typeof broker.stop>[0]),
    },
    {
      method: 'invocation.status',
      invoke: (params) => broker.status(params as Parameters<typeof broker.status>[0]),
    },
    {
      method: 'invocation.dispose',
      invoke: (params) => broker.dispose(params as Parameters<typeof broker.dispose>[0]),
    },
  ]
}

function registerBrokerMethods(server: ProtocolServer, broker: Broker): void {
  for (const { method, invoke } of brokerMethodTable(broker)) {
    server.register(method, async ({ id, params }) => {
      validateCommand({ jsonrpc: '2.0', id, method, params })
      return invoke(params)
    })
  }
}
