import type { InvocationDispatchRequest } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode, validateCommand } from 'spaces-harness-broker-protocol'
import type { Broker } from './broker'
import { BrokerError } from './errors'
import type { ProtocolServer } from './protocol-server'

/** A broker call reached through one JSON-RPC method name. */
type MethodHandler = (params: unknown) => unknown

interface MethodRoute {
  handle: MethodHandler
  /**
   * Validate `params ?? {}` rather than the raw params. Only for methods whose
   * request object is optional on the wire but required by the schema.
   */
  defaultEmptyParams?: true | undefined
}

type MethodTable = Record<string, MethodRoute>

export interface BrokerMethodOptions {
  experimentalObserverEnabled?: boolean | undefined
}

/** Cast-through for a broker method's single request argument. */
type RequestOf<K extends keyof Broker> = Broker[K] extends (
  request: infer R,
  ...rest: never[]
) => unknown
  ? R
  : never

/**
 * The read-only broker JSON-RPC methods (the observer surface). This is a
 * strict SUBSET of the full broker surface: it has no mutating methods. Both
 * the full registration and the observer-only registration share this table
 * so the read surface cannot silently drift between them.
 */
function readMethods(broker: Broker): MethodTable {
  return {
    'broker.hello': { handle: (p) => broker.hello(p as RequestOf<'hello'>) },
    'broker.health': { handle: (p) => broker.health((p ?? {}) as RequestOf<'health'>) },
    'broker.listInvocations': {
      handle: (p) => broker.listInvocations((p ?? {}) as RequestOf<'listInvocations'>),
      defaultEmptyParams: true,
    },
    'invocation.status': { handle: (p) => broker.status(p as RequestOf<'status'>) },
    'invocation.snapshot': { handle: (p) => broker.snapshot(p as RequestOf<'snapshot'>) },
    'invocation.eventsSince': { handle: (p) => broker.eventsSince(p as RequestOf<'eventsSince'>) },
    'queue.list': { handle: (p) => broker.queueList(p as RequestOf<'queueList'>) },
    'turn.manifest': { handle: (p) => broker.turnManifest(p as RequestOf<'turnManifest'>) },
    'seat.probe': { handle: (p) => broker.seatProbe(p as RequestOf<'seatProbe'>) },
  }
}

/** The mutating v1 methods every controller transport exposes. */
function controlMethods(broker: Broker, options: BrokerMethodOptions): MethodTable {
  return {
    'invocation.start': {
      // validateCommand validates the full InvocationDispatchRequest envelope
      // (including dispatchEnv key-class + lockedEnv-shadow rules) before dispatch.
      handle: (p) => startInvocation(broker, p as InvocationDispatchRequest, options),
    },
    'invocation.input': { handle: (p) => broker.input(p as RequestOf<'input'>) },
    'submission.steer': { handle: (p) => broker.steer(p as RequestOf<'steer'>) },
    'submission.enqueue': { handle: (p) => broker.enqueue(p as RequestOf<'enqueue'>) },
    'submission.invoke': { handle: (p) => broker.invoke(p as RequestOf<'invoke'>) },
    'submission.preempt': { handle: (p) => broker.preempt(p as RequestOf<'preempt'>) },
    'submission.withdraw': { handle: (p) => broker.withdraw(p as RequestOf<'withdraw'>) },
    'queue.jump': { handle: (p) => broker.queueJump(p as RequestOf<'queueJump'>) },
    'queue.cancel': { handle: (p) => broker.queueCancel(p as RequestOf<'queueCancel'>) },
    'invocation.interrupt': { handle: (p) => broker.interrupt(p as RequestOf<'interrupt'>) },
    'invocation.stop': { handle: (p) => broker.stop(p as RequestOf<'stop'>) },
    'invocation.dispose': { handle: (p) => broker.dispose(p as RequestOf<'dispose'>) },
    // Retained operator disposition surface (T-07883: nothing halts). Mutating,
    // so it is registered HERE (and on the unix durability surface) and
    // deliberately NOT in readMethods — the observer surface stays read-only (§8.2).
    'invocation.capture.release': {
      handle: (p) => broker.captureRelease(p as RequestOf<'captureRelease'>),
    },
  }
}

function startInvocation(
  broker: Broker,
  dispatch: InvocationDispatchRequest,
  options: BrokerMethodOptions
): ReturnType<Broker['start']> {
  if (
    options.experimentalObserverEnabled === true &&
    dispatch.startRequest.spec.driver.kind !== 'codex-app-server' &&
    dispatch.startRequest.spec.driver.kind !== 'muse-serve'
  ) {
    throw new BrokerError(
      BrokerErrorCode.UnsupportedCapability,
      'Experimental observer socket is only supported for codex-app-server and muse-serve invocations',
      {
        driverKind: dispatch.startRequest.spec.driver.kind,
      }
    )
  }
  return broker.start(
    dispatch.startRequest,
    dispatch.dispatchEnv,
    dispatch.runtime,
    dispatch.lifecyclePolicy
  )
}

/** Register methods whose params are schema-validated before the broker sees them. */
export function registerValidatedMethods(server: ProtocolServer, table: MethodTable): void {
  for (const [name, route] of Object.entries(table)) {
    server.register(name, async ({ id, method, params }) => {
      validateCommand({
        jsonrpc: '2.0',
        id,
        method,
        params: route.defaultEmptyParams === true ? (params ?? {}) : params,
      })
      return route.handle(params)
    })
  }
}

/**
 * Register the v1 broker JSON-RPC methods on a protocol server. Shared by the
 * stdio and unix transport entry points so both expose identical surfaces.
 */
export function registerBrokerMethods(
  server: ProtocolServer,
  broker: Broker,
  options: BrokerMethodOptions = {}
): void {
  registerValidatedMethods(server, readMethods(broker))
  registerValidatedMethods(server, controlMethods(broker, options))
}

/**
 * Observer-mode registration: the read-only subset only. Deliberately omits all
 * mutating methods (start/input/interrupt/stop/dispose).
 */
export function registerBrokerObserverMethods(server: ProtocolServer, broker: Broker): void {
  registerValidatedMethods(server, readMethods(broker))
}
