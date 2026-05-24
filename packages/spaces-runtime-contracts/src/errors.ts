export type RuntimeControlErrorCode =
  | 'compile-failed'
  | 'no-admissible-profile'
  | 'capability-missing'
  | 'capability-degrade-forbidden'
  | 'legacy-disabled'
  | 'broker-protocol-mismatch'
  | 'broker-driver-unavailable'
  | 'broker-start-failed'
  | 'broker-input-rejected'
  | 'broker-busy'
  | 'broker-queue-not-supported'
  | 'permission-denied'
  | 'permission-timeout'
  | 'runtime-not-found'
  | 'runtime-state-invalid'
  | 'runtime-recompile-required'
  | 'event-projection-failed'
  | 'restart-reattach-unsupported'
  | string

export type RuntimeControlError = {
  code: RuntimeControlErrorCode
  message: string
  retryable: boolean
  plane: 'asp-compiler' | 'hrc-control' | 'harness-broker' | 'broker-driver'
  details?: unknown
}

export enum BrokerErrorCode {
  UnknownInvocation = -32001,
  InvalidInvocationState = -32002,
  UnsupportedCapability = -32003,
  InputRejected = -32004,
  HarnessError = -32005,
  Timeout = -32006,
  ResourceError = -32007,
  ShutdownInProgress = -32008,
  DriverUnavailable = -32009,
  PermissionDenied = -32010,
}
