/**
 * The co-hosted ASPC service (T-07314): the `spaces-aspc` compile plane plus the
 * start plane that a live, co-hosted `spaces-harness-broker` makes possible.
 *
 * `spaces-aspc` itself is compile-only and reports `compileAndStart` /
 * `cohostedBroker` false; this composition wraps it, reports both true, and
 * surfaces the broker protocol version it co-hosts.
 */
import type { AspcCompiler, AspcService, AspcServiceOptions } from 'spaces-aspc'
import { createAspcService } from 'spaces-aspc'
import type {
  AspcCompileAndStartRequest,
  AspcCompileAndStartResponse,
  AspcCompileHarnessInvocationResponse,
  AspcHelloRequest,
  AspcHelloResponse,
} from 'spaces-aspc-protocol'
import type { Broker } from 'spaces-harness-broker'
import type { InvocationDispatchRequest } from 'spaces-harness-broker-protocol'
import { SUPPORTED_BROKER_PROTOCOL_VERSIONS } from 'spaces-harness-broker-protocol'

const ASPC_COMPILE_AND_START_SCHEMA = 'aspc-compile-and-start-response/v1'

export interface CohostedAspcServiceOptions
  extends Pick<
    AspcServiceOptions,
    | 'agentsRoot'
    | 'resolveProjectRoot'
    | 'environment'
    | 'now'
    | 'serviceProbeResponses'
    | 'scaffoldPackets'
  > {
  broker: Broker
  compiler?: AspcCompiler | undefined
}

export interface CohostedAspcService extends AspcService {
  compileAndStart(req: AspcCompileAndStartRequest): Promise<AspcCompileAndStartResponse>
}

/**
 * Spreads an `InvocationDispatchRequest` into the positional `Broker.start`
 * call shape. Single source for the arg order so the facade's broker-start row
 * and `compileAndStart` cannot drift apart.
 */
export function startFromDispatch(
  broker: Broker,
  dispatch: InvocationDispatchRequest
): ReturnType<Broker['start']> {
  return broker.start(
    dispatch.startRequest,
    dispatch.dispatchEnv,
    dispatch.runtime,
    dispatch.lifecyclePolicy
  )
}

export function createCohostedAspcService(
  options: CohostedAspcServiceOptions
): CohostedAspcService {
  const compile = createAspcService({
    ...(options.compiler !== undefined ? { compiler: options.compiler } : {}),
    ...(options.agentsRoot !== undefined ? { agentsRoot: options.agentsRoot } : {}),
    ...(options.resolveProjectRoot !== undefined
      ? { resolveProjectRoot: options.resolveProjectRoot }
      : {}),
    ...(options.environment !== undefined ? { environment: options.environment } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.serviceProbeResponses !== undefined
      ? { serviceProbeResponses: options.serviceProbeResponses }
      : {}),
    ...(options.scaffoldPackets !== undefined ? { scaffoldPackets: options.scaffoldPackets } : {}),
  })

  return {
    ...compile,

    async hello(req: AspcHelloRequest): Promise<AspcHelloResponse> {
      const response = await compile.hello(req)
      return {
        ...response,
        capabilities: {
          ...response.capabilities,
          compileAndStart: true,
          cohostedBroker: true,
        },
        brokerProtocol: SUPPORTED_BROKER_PROTOCOL_VERSIONS[0],
      }
    },

    async compileAndStart(req: AspcCompileAndStartRequest): Promise<AspcCompileAndStartResponse> {
      const compiled = await compile.compileHarnessInvocation(req)
      if (!compiled.ok) {
        return failCompileAndStart(compiled)
      }

      const startResponse = await startFromDispatch(options.broker, compiled.dispatchRequest)
      return {
        schemaVersion: ASPC_COMPILE_AND_START_SCHEMA,
        ok: true,
        compile: compiled,
        startResponse,
      }
    },
  }
}

function failCompileAndStart(
  compile: Extract<AspcCompileHarnessInvocationResponse, { ok: false }>
): Extract<AspcCompileAndStartResponse, { ok: false }> {
  return {
    schemaVersion: ASPC_COMPILE_AND_START_SCHEMA,
    ok: false,
    compile,
    diagnostics: compile.diagnostics,
  }
}
