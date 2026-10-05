import type {
  HostSessionId,
  RequestId,
  RuntimeId,
  RuntimeOperationId,
} from 'spaces-runtime-contracts'

// Branded-id constructors for test fixtures. The runtime ids are nominal
// strings with no runtime representation, so this is the one place tests
// brand a literal; call sites stay cast-free.
export const requestIdFrom = (value: string): RequestId => value as RequestId
export const operationIdFrom = (value: string): RuntimeOperationId => value as RuntimeOperationId
export const hostSessionIdFrom = (value: string): HostSessionId => value as HostSessionId
export const runtimeIdFrom = (value: string): RuntimeId => value as RuntimeId
