/**
 * gateway-ios public API surface.
 *
 * Re-exports the module lifecycle, config, contracts, and internal types
 * that downstream consumers (acp-cli, tests) need.
 */

// Module lifecycle
export { createGatewayIosModule } from './module.js'
export type { GatewayIosModule, GatewayIosModuleOptions } from './module.js'

// Config
export { resolveConfig, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_GATEWAY_ID } from './config.js'
export type { GatewayIosConfig } from './config.js'

// Logger
export { createLogger } from './logger.js'

// Frozen mobile DTO contracts
export type {
  MobileSessionMode,
  MobileSessionStatus,
  MobileSessionSummary,
  MobileSessionCapabilities,
  MobileSessionIndex,
  TimelineFrameKind,
  TimelineBlockKind,
  SourceEventCitation,
  TimelineBlock,
  FrameAction,
  TimelineFrame,
  SnapshotHighWater,
  HistoryCursor,
  HistoryPage,
  SnapshotMessage,
  FrameMessage,
  HrcEventMessage,
  ControlMessage,
  GatewayWsMessage,
  MobileFence,
  InputRequest,
  InputResponse,
  InterruptRequest,
  InterruptResponse,
} from './contracts.js'

// Reducer input interface (consumed by P2)
export type { ReducerInput } from './types.js'

// Event reducer (P2)
export {
  createReducerState,
  reduce,
} from './event-reducer.js'
export type {
  FrameState,
  ReducerState,
  FrameUpdate,
  ReducerResult,
} from './event-reducer.js'

// Frame projector (P2)
export { projectTimeline, projectIncremental } from './frame-projector.js'
export type { ProjectionResult } from './frame-projector.js'
