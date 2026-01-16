/**
 * Events module exports
 *
 * This module provides structured run event emission and CP context handling
 * for multi-agent coordination with the control-plane.
 */

// CP Context handling
export {
  type CpContext,
  CP_ENV_VARS,
  extractCpContext,
  hasCpContext,
  cpContextToEnv,
  mergeCpContextEnv,
} from './cp-context.js'

// Event types and emitter
export {
  type BaseEvent,
  type JobStartedEvent,
  type SessionStartedEvent,
  type MessageEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type HeartbeatEvent,
  type JobCompletedEvent,
  type RunEvent,
  type EventEmitterOptions,
  RunEventEmitter,
  createEventEmitter,
  getEventsOutputPath,
} from './events.js'
