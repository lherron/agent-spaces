export type RuntimeResourceLimits = {
  startupTimeoutMs?: number | undefined
  turnTimeoutMs?: number | undefined
  stopGraceMs?: number | undefined
  maxEventBytes?: number | undefined
  maxInputQueueDepth?: number | undefined
  maxRuntimeAgeMs?: number | undefined
}
