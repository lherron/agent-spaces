import type {
  BrokerHealthRequest,
  BrokerHealthResponse,
  BrokerHelloRequest,
  BrokerHelloResponse,
  ClientCapabilities,
  InvocationDisposeRequest,
  InvocationDisposeResponse,
  InvocationEventEnvelope,
  InvocationInputRequest,
  InvocationInputResponse,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStartRequest,
  InvocationStartResponse,
  InvocationStatusRequest,
  InvocationStatusResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  PermissionDecision,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import {
  BrokerErrorCode,
  validateCommand,
  validateInvocationStartRequest,
} from 'spaces-harness-broker-protocol'
import type { Driver } from './drivers/driver'
import { createDriverRegistry } from './drivers/registry'
import { BrokerError, toInvalidParamsBrokerError } from './errors'
import { createInvocationEventSequencer } from './events'
import { createInvocationManager } from './invocation-manager'

const BROKER_VERSION = '0.1.0'

export interface BrokerOptions {
  drivers: Driver[]
  onEvent?: ((event: InvocationEventEnvelope) => void) | undefined
  now?: (() => Date) | undefined
  /**
   * Broker→client permission request transport (e.g. wired to
   * `ProtocolServer.request('invocation.permission.request', ...)`). When
   * present, ask-client permission policies can reach the connected client.
   */
  onPermissionRequest?:
    | ((params: PermissionRequestParams) => Promise<PermissionDecision>)
    | undefined
  maxInputQueueDepth?: number | undefined
}

export interface Broker {
  hello(req: BrokerHelloRequest): Promise<BrokerHelloResponse>
  health(req: BrokerHealthRequest): Promise<BrokerHealthResponse>
  start(req: InvocationStartRequest): Promise<InvocationStartResponse>
  input(req: InvocationInputRequest): Promise<InvocationInputResponse>
  interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse>
  stop(req: InvocationStopRequest): Promise<InvocationStopResponse>
  status(req: InvocationStatusRequest): Promise<InvocationStatusResponse>
  dispose(req: InvocationDisposeRequest): Promise<InvocationDisposeResponse>
}

export function createBroker(options: BrokerOptions): Broker {
  const { drivers, now = () => new Date() } = options
  const registry = createDriverRegistry(drivers)
  const sequencer = createInvocationEventSequencer({ now })
  const onEvent = options.onEvent ?? (() => {})
  let clientCapabilities: ClientCapabilities = {}

  const manager = createInvocationManager({
    sequencer,
    onEvent,
    getClientCapabilities: () => clientCapabilities,
    onPermissionRequest: options.onPermissionRequest,
    maxInputQueueDepth: options.maxInputQueueDepth,
  })

  return {
    async hello(req: BrokerHelloRequest): Promise<BrokerHelloResponse> {
      validateBrokerParams('broker.hello', req)

      const supported = req.protocolVersions.includes('harness-broker/0.1')
      if (!supported) {
        throw new BrokerError(
          BrokerErrorCode.UnsupportedCapability,
          'No supported protocol version in request'
        )
      }

      // Store client capabilities for permission negotiation
      clientCapabilities = req.capabilities ?? {}

      const hasPermissionRequests = clientCapabilities.permissionRequests === true

      return {
        brokerInfo: {
          name: 'harness-broker',
          version: BROKER_VERSION,
        },
        protocolVersion: 'harness-broker/0.1',
        capabilities: {
          multiInvocation: false,
          transports: ['stdio-jsonrpc-ndjson'],
          eventNotifications: true,
          brokerToClientRequests: hasPermissionRequests,
        },
        drivers: registry.summaries(),
      }
    },

    async health(req: BrokerHealthRequest): Promise<BrokerHealthResponse> {
      validateBrokerParams('broker.health', req)
      return {
        status: 'ok',
        activeInvocations: manager.activeCount(),
      }
    },

    start(req: InvocationStartRequest): Promise<InvocationStartResponse> {
      try {
        validateInvocationStartRequest(req)
      } catch (err) {
        return Promise.reject(toInvalidParamsBrokerError(err) ?? err)
      }

      const driverKind = req.spec.harness.driver
      const driver = registry.get(driverKind)
      if (!driver) {
        return Promise.reject(
          new BrokerError(
            BrokerErrorCode.DriverUnavailable,
            `No driver registered for kind: ${driverKind}`,
            { driverKind }
          )
        )
      }

      // Non-async wrapper: the returned promise has a no-op catch pre-attached
      // so that bun's test runner doesn't flag it as an unhandled rejection when
      // the startup timeout fires before the caller awaits.
      const result = manager.start(req.spec, driver, req.initialInput)
      result.catch(() => {})
      return result
    },

    input(req: InvocationInputRequest): Promise<InvocationInputResponse> {
      try {
        validateBrokerParams('invocation.input', req)
      } catch (err) {
        return Promise.reject(toInvalidParamsBrokerError(err) ?? err)
      }

      // Non-async: suppress unhandled rejection for turn timeout scenarios
      const result = manager.input(req)
      result.catch(() => {})
      return result
    },

    async interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      validateBrokerParams('invocation.interrupt', req)
      return manager.interrupt(req)
    },

    async stop(req: InvocationStopRequest): Promise<InvocationStopResponse> {
      validateBrokerParams('invocation.stop', req)
      return manager.stop(req)
    },

    async status(req: InvocationStatusRequest): Promise<InvocationStatusResponse> {
      validateBrokerParams('invocation.status', req)
      return manager.status(req.invocationId)
    },

    async dispose(req: InvocationDisposeRequest): Promise<InvocationDisposeResponse> {
      validateBrokerParams('invocation.dispose', req)
      return manager.dispose(req)
    },
  }
}

function validateBrokerParams(method: string, params: unknown): void {
  try {
    validateCommand({ jsonrpc: '2.0', id: 'broker_facade_validation', method, params })
  } catch (err) {
    throw toInvalidParamsBrokerError(err) ?? err
  }
}
