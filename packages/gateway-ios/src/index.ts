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
