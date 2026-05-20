import type {
  BrokerHelloRequest,
  BrokerHelloResponse,
  BrokerHealthRequest,
  BrokerHealthResponse,
  InvocationStartRequest,
  InvocationStartResponse,
  InvocationInputRequest,
  InvocationInputResponse,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  InvocationStatusRequest,
  InvocationStatusResponse,
  InvocationDisposeRequest,
  InvocationDisposeResponse,
  InvocationEventEnvelope,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from './errors'
import { createInvocationEventSequencer } from './events'
import type { Driver } from './drivers/driver'
import { createDriverRegistry } from './drivers/registry'
import { createInvocationManager } from './invocation-manager'

const BROKER_VERSION = '0.1.0'

export interface BrokerOptions {
  drivers: Driver[]
  onEvent?: ((event: InvocationEventEnvelope) => void) | undefined
  now?: (() => Date) | undefined
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

  const manager = createInvocationManager({
    sequencer,
    onEvent,
  })

  return {
    async hello(req: BrokerHelloRequest): Promise<BrokerHelloResponse> {
      const supported = req.protocolVersions.includes('harness-broker/0.1')
      if (!supported) {
        throw new BrokerError(
          BrokerErrorCode.UnsupportedCapability,
          'No supported protocol version in request'
        )
      }

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
          brokerToClientRequests: false,
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

    async start(req: InvocationStartRequest): Promise<InvocationStartResponse> {
      const driverKind = req.spec.harness.driver
      const driver = registry.get(driverKind)
      if (!driver) {
        throw new BrokerError(
          BrokerErrorCode.DriverUnavailable,
          `No driver registered for kind: ${driverKind}`,
          { driverKind }
        )
      }

      return manager.start(req.spec, driver)
    },

    async input(req: InvocationInputRequest): Promise<InvocationInputResponse> {
      return manager.input(req)
    },

    async interrupt(
      req: InvocationInterruptRequest
    ): Promise<InvocationInterruptResponse> {
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
