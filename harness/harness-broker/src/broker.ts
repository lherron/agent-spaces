import type {
  BrokerAttachRequest,
  BrokerAttachResponse,
  BrokerHealthRequest,
  BrokerHealthResponse,
  BrokerHelloRequest,
  BrokerHelloResponse,
  BrokerLifecyclePolicyOverlay,
  BrokerListInvocationsRequest,
  BrokerListInvocationsResponse,
  BrokerTransportKind,
  ClientCapabilities,
  InvocationAckEventsRequest,
  InvocationAckEventsResponse,
  InvocationDisposeRequest,
  InvocationDisposeResponse,
  InvocationEventEnvelope,
  InvocationEventsSinceRequest,
  InvocationEventsSinceResponse,
  InvocationId,
  InvocationInputRequest,
  InvocationInputResponse,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationPermissionRespondRequest,
  InvocationPermissionRespondResponse,
  InvocationRuntimeContext,
  InvocationSnapshot,
  InvocationSnapshotRequest,
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
  SUPPORTED_BROKER_PROTOCOL_VERSIONS,
  validateCommand,
  validateInvocationDispatchRequest,
} from 'spaces-harness-broker-protocol'
import type { Driver } from './drivers/driver'
import { createDriverRegistry } from './drivers/registry'
import { BrokerError, toInvalidParamsBrokerError } from './errors'
import type { EventLedger } from './event-ledger'
import { createInvocationEventSequencer } from './events'
import { createInvocationManager } from './invocation-manager'
import type { DispatchEnv } from './runtime/env'
import { parseDispatchEnv } from './runtime/env'

const BROKER_VERSION = '0.1.0'

/**
 * Launch-time runtime identity a durable (unix) broker validates incoming
 * `broker.attach` requests against. Sourced from the broker's own CLI flags;
 * absent for stdio brokers (which never attach).
 */
export interface BrokerAttachIdentity {
  runtimeId: string
  hostSessionId: string
  generation: number
  attachToken: string
}

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
  /**
   * Transports this broker process advertises in `broker.hello`. Defaults to
   * stdio only; the unix server entry point advertises both stdio and unix.
   */
  advertisedTransports?: BrokerTransportKind[] | undefined
  /**
   * Whether `broker.hello` advertises the attach/replay control surface. The
   * unix durable runtime advertises it; the stdio child does not.
   */
  advertiseAttachReplay?: boolean | undefined
  /**
   * Durable event ledger. When present, every emitted event is persisted
   * (append idempotent by `(invocationId, seq)`) before the client is notified,
   * and the eventsSince/ackEvents/snapshot control surface serves from it.
   */
  eventLedger?: EventLedger | undefined
  /**
   * Runtime identity that `broker.attach` validates incoming requests against.
   * Present only for the durable unix runtime.
   */
  attachIdentity?: BrokerAttachIdentity | undefined
  /** Stable id reported in `broker.attach` responses. */
  brokerInstanceId?: string | undefined
}

export interface Broker {
  hello(req: BrokerHelloRequest): Promise<BrokerHelloResponse>
  health(req: BrokerHealthRequest): Promise<BrokerHealthResponse>
  start(
    req: InvocationStartRequest,
    dispatchEnv?: Record<string, string> | undefined,
    runtime?: InvocationRuntimeContext | undefined,
    lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined
  ): Promise<InvocationStartResponse>
  input(req: InvocationInputRequest): Promise<InvocationInputResponse>
  interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse>
  stop(req: InvocationStopRequest): Promise<InvocationStopResponse>
  status(req: InvocationStatusRequest): Promise<InvocationStatusResponse>
  listInvocations(req: BrokerListInvocationsRequest): Promise<BrokerListInvocationsResponse>
  dispose(req: InvocationDisposeRequest): Promise<InvocationDisposeResponse>
  // --- Durability control surface (durable/unix runtime only) ---
  attach(req: BrokerAttachRequest): Promise<BrokerAttachResponse>
  snapshot(req: InvocationSnapshotRequest): Promise<InvocationSnapshot>
  eventsSince(req: InvocationEventsSinceRequest): Promise<InvocationEventsSinceResponse>
  ackEvents(req: InvocationAckEventsRequest): Promise<InvocationAckEventsResponse>
  permissionRespond(
    req: InvocationPermissionRespondRequest
  ): Promise<InvocationPermissionRespondResponse>
}

export function createBroker(options: BrokerOptions): Broker {
  const { drivers, now = () => new Date() } = options
  const registry = createDriverRegistry(drivers)
  const sequencer = createInvocationEventSequencer({ now })
  const eventLedger = options.eventLedger
  const attachIdentity = options.attachIdentity
  const brokerInstanceId = options.brokerInstanceId ?? `broker_${process.pid}`
  const baseOnEvent = options.onEvent ?? (() => {})
  // Persist before notifying: the ledger's synchronous append runs before the
  // client sees the event, so a reconnecting controller can always replay it.
  const onEvent = eventLedger
    ? (event: InvocationEventEnvelope) => {
        eventLedger.append(event).catch(() => {})
        baseOnEvent(event)
      }
    : baseOnEvent
  const advertisedTransports: BrokerTransportKind[] = options.advertisedTransports ?? [
    'stdio-jsonrpc-ndjson',
  ]
  const advertiseAttachReplay = options.advertiseAttachReplay ?? false
  let clientCapabilities: ClientCapabilities = {}

  const manager = createInvocationManager({
    sequencer,
    onEvent,
    getClientCapabilities: () => clientCapabilities,
    onPermissionRequest: options.onPermissionRequest,
    maxInputQueueDepth: options.maxInputQueueDepth,
    now,
  })

  function requireManagedInvocation(invocationId: InvocationId) {
    const inv = manager.get(invocationId)
    if (!inv) {
      throw new BrokerError(
        BrokerErrorCode.UnknownInvocation,
        `Unknown invocation: ${invocationId}`,
        { invocationId }
      )
    }
    return inv
  }

  async function buildSnapshot(
    invocationId: InvocationId,
    opts?: { probeLiveness?: boolean | undefined }
  ): Promise<InvocationSnapshot> {
    const inv = requireManagedInvocation(invocationId)
    // Snapshot delegates the shared inspection fields to the single read-model
    // helper, then APPENDS reconnect-only state (pending inputs/permissions,
    // input dispositions, retention floor). currentSeq comes from the durable
    // ledger when present (the reconnect cursor), falling back to the projected
    // seq for the stdio path.
    const summary = manager.buildInspectionSummary(invocationId, opts)
    const currentSeq = eventLedger?.currentSeq(invocationId) ?? summary.currentSeq ?? 0
    const retentionFloorSeq = eventLedger ? await eventLedger.retentionFloorSeq(invocationId) : 0

    const inputDispositions: Record<string, InvocationInputResponse> = {}
    for (const [inputId, record] of inv.inputDispositions) {
      inputDispositions[inputId] = record.response
    }

    // Broker-owned pending permission requests, each carrying its ABSOLUTE
    // deadline so a reconnecting controller can render the remaining time (C2).
    const pendingPermissionRequests = Array.from(inv.pendingPermissions.values()).map((record) => ({
      ...record.params,
      deadlineAt: record.deadlineAt,
    }))

    return {
      ...summary,
      capabilities: inv.capabilities,
      pendingInputIds: inv.pending.map((item) => item.inputId),
      inputDispositions,
      pendingPermissionRequests,
      process: {
        brokerPid: process.pid,
        ...(inv.childPid !== undefined ? { childPid: inv.childPid } : {}),
        ...(inv.exitCode !== undefined ? { exitCode: inv.exitCode } : {}),
        ...(inv.signal !== undefined ? { signal: inv.signal } : {}),
      },
      currentSeq,
      retentionFloorSeq,
      ...(inv.currentTurnId !== undefined ? { currentTurnId: inv.currentTurnId } : {}),
      ...(inv.continuation !== undefined ? { continuation: inv.continuation } : {}),
    }
  }

  return {
    async hello(req: BrokerHelloRequest): Promise<BrokerHelloResponse> {
      validateBrokerParams('broker.hello', req)

      const protocolVersion = [...SUPPORTED_BROKER_PROTOCOL_VERSIONS]
        .reverse()
        .find((version) => req.protocolVersions.includes(version))
      if (!protocolVersion) {
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
        protocolVersion,
        capabilities: {
          multiInvocation: false,
          transports: [...advertisedTransports],
          eventNotifications: true,
          brokerToClientRequests: hasPermissionRequests,
          ...(advertiseAttachReplay ? { attachReplay: true } : {}),
          // Inspection read-model (T-01851): advertise truthfully. This phase
          // implements listInvocations, timestamps, lifecycle view, cached
          // liveness, and the eventsSince type filter.
          inspection: {
            listInvocations: true,
            timestamps: true,
            lifecycleView: true,
            liveness: 'cached',
            eventTypeFilter: true,
          },
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

    start(
      req: InvocationStartRequest,
      dispatchEnv?: Record<string, string> | undefined,
      runtime?: InvocationRuntimeContext | undefined,
      lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined
    ): Promise<InvocationStartResponse> {
      let parsedDispatchEnv: DispatchEnv | undefined
      try {
        parsedDispatchEnv = parseDispatchEnv(dispatchEnv, req.spec.process.lockedEnv)
      } catch (err) {
        return Promise.reject(err)
      }
      try {
        validateInvocationDispatchRequest({
          startRequest: req,
          ...(parsedDispatchEnv !== undefined ? { dispatchEnv: parsedDispatchEnv } : {}),
          ...(runtime !== undefined ? { runtime } : {}),
          ...(lifecyclePolicy !== undefined ? { lifecyclePolicy } : {}),
        })
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
      const result = manager.start(
        req.spec,
        driver,
        req.initialInput,
        parsedDispatchEnv,
        runtime,
        lifecyclePolicy
      )
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
      return manager.status(
        req.invocationId,
        req.probeLiveness !== undefined ? { probeLiveness: req.probeLiveness } : undefined
      )
    },

    async listInvocations(
      req: BrokerListInvocationsRequest
    ): Promise<BrokerListInvocationsResponse> {
      validateBrokerParams('broker.listInvocations', req)
      return manager.listInvocations(req)
    },

    async dispose(req: InvocationDisposeRequest): Promise<InvocationDisposeResponse> {
      validateBrokerParams('invocation.dispose', req)
      return manager.dispose(req)
    },

    async attach(req: BrokerAttachRequest): Promise<BrokerAttachResponse> {
      validateBrokerParams('broker.attach', req)

      // Launch identity + attach token must match the runtime this broker was
      // started for. Any mismatch is AttachRejected (no information leak about
      // which field failed beyond the data bag).
      if (
        attachIdentity !== undefined &&
        (req.runtimeId !== attachIdentity.runtimeId ||
          req.hostSessionId !== attachIdentity.hostSessionId ||
          req.generation !== attachIdentity.generation ||
          req.attachToken !== attachIdentity.attachToken)
      ) {
        throw new BrokerError(
          BrokerErrorCode.AttachRejected,
          'Attach rejected: runtime identity or attach token mismatch',
          { runtimeId: req.runtimeId, generation: req.generation }
        )
      }

      const inv = manager.get(req.invocationId)
      if (!inv) {
        throw new BrokerError(
          BrokerErrorCode.AttachRejected,
          `Attach rejected: unknown invocation ${req.invocationId}`,
          { invocationId: req.invocationId }
        )
      }

      // Per-invocation request/profile hashes must match the started invocation.
      const correlation = inv.spec.correlation
      const correlatedStartHash = correlation?.['startRequestHash']
      const correlatedProfileHash = correlation?.['selectedProfileHash']
      if (
        (correlatedStartHash !== undefined && req.startRequestHash !== correlatedStartHash) ||
        (correlatedProfileHash !== undefined && req.selectedProfileHash !== correlatedProfileHash)
      ) {
        throw new BrokerError(
          BrokerErrorCode.AttachRejected,
          'Attach rejected: start-request or profile hash mismatch',
          { invocationId: req.invocationId }
        )
      }

      const snapshot = await buildSnapshot(req.invocationId)
      return {
        attached: true,
        brokerInstanceId,
        runtimeId: req.runtimeId,
        generation: req.generation,
        invocationId: req.invocationId,
        activeControllerInstanceId: req.controllerInstanceId,
        currentSeq: snapshot.currentSeq,
        retentionFloorSeq: snapshot.retentionFloorSeq,
        snapshot,
      }
    },

    async snapshot(req: InvocationSnapshotRequest): Promise<InvocationSnapshot> {
      validateBrokerParams('invocation.snapshot', req)
      return buildSnapshot(
        req.invocationId,
        req.probeLiveness !== undefined ? { probeLiveness: req.probeLiveness } : undefined
      )
    },

    async eventsSince(req: InvocationEventsSinceRequest): Promise<InvocationEventsSinceResponse> {
      validateBrokerParams('invocation.eventsSince', req)
      if (!eventLedger) {
        throw new BrokerError(
          BrokerErrorCode.EventReplayUnavailable,
          'Event replay unavailable: no durable ledger configured',
          { invocationId: req.invocationId }
        )
      }
      // eventsSince rejects below the retention floor (EventReplayUnavailable).
      const replayed = await eventLedger.eventsSince(req.invocationId, req.afterSeq)
      // request.types filters ONLY the returned events. currentSeq and the
      // retention floor still describe the FULL ledger so a reconnecting client
      // advances safely past event types it did not ask to render.
      const events =
        req.types !== undefined
          ? replayed.filter((event) => req.types?.includes(event.type))
          : replayed
      const currentSeq = eventLedger.currentSeq(req.invocationId)
      const retentionFloorSeq = await eventLedger.retentionFloorSeq(req.invocationId)
      return { events, currentSeq, retentionFloorSeq }
    },

    async ackEvents(req: InvocationAckEventsRequest): Promise<InvocationAckEventsResponse> {
      validateBrokerParams('invocation.ackEvents', req)
      if (!eventLedger) {
        throw new BrokerError(
          BrokerErrorCode.EventReplayUnavailable,
          'Event ack unavailable: no durable ledger configured',
          { invocationId: req.invocationId }
        )
      }
      // Monotonic per invocation; controller-fencing is enforced by the caller.
      return eventLedger.ackEvents(req.invocationId, req.throughSeq)
    },

    async permissionRespond(
      req: InvocationPermissionRespondRequest
    ): Promise<InvocationPermissionRespondResponse> {
      validateBrokerParams('invocation.permission.respond', req)
      return manager.permissionRespond(req)
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
