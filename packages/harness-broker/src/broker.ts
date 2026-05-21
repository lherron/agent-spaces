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
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import type { Driver } from './drivers/driver'
import { createDriverRegistry } from './drivers/registry'
import { BrokerError } from './errors'
import { createInvocationEventSequencer } from './events'
import { createInvocationManager } from './invocation-manager'

const BROKER_VERSION = '0.1.0'

export interface BrokerOptions {
  drivers: Driver[]
  onEvent?: ((event: InvocationEventEnvelope) => void) | undefined
  now?: (() => Date) | undefined
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
    maxInputQueueDepth: options.maxInputQueueDepth,
  })

  return {
    async hello(req: BrokerHelloRequest): Promise<BrokerHelloResponse> {
      // Validate required params (Phase 3 carry-over: broker.hello param validation gap)
      if (!req || typeof req !== 'object') {
        throw new BrokerError(-32602 as BrokerErrorCode, 'Invalid params: expected object')
      }
      if (
        !req.clientInfo ||
        typeof req.clientInfo !== 'object' ||
        typeof req.clientInfo.name !== 'string'
      ) {
        throw new BrokerError(
          -32602 as BrokerErrorCode,
          'Invalid params: clientInfo.name is required'
        )
      }
      if (!Array.isArray(req.protocolVersions) || req.protocolVersions.length === 0) {
        throw new BrokerError(
          -32602 as BrokerErrorCode,
          'Invalid params: protocolVersions must be a non-empty array'
        )
      }

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

    async health(_req: BrokerHealthRequest): Promise<BrokerHealthResponse> {
      return {
        status: 'ok',
        activeInvocations: manager.activeCount(),
      }
    },

    start(req: InvocationStartRequest): Promise<InvocationStartResponse> {
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
      // Non-async: suppress unhandled rejection for turn timeout scenarios
      const result = manager.input(req)
      result.catch(() => {})
      return result
    },

    async interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      return manager.interrupt(req)
    },

    async stop(req: InvocationStopRequest): Promise<InvocationStopResponse> {
      return manager.stop(req)
    },

    async status(req: InvocationStatusRequest): Promise<InvocationStatusResponse> {
      return manager.status(req.invocationId)
    },

    async dispose(req: InvocationDisposeRequest): Promise<InvocationDisposeResponse> {
      return manager.dispose(req)
    },
  }
}
