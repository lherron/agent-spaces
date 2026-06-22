// T-04651 — type-level gate for the union-narrowing refactor.
//
// This is the substantive gate (typecheck alone is necessary-not-sufficient):
//  - RuntimeControlErrorCode is CLOSED: an arbitrary string must NOT assign;
//    every one of the 18 named kebab codes must assign.
//  - RunStatus is CLOSED: an arbitrary string must NOT assign; the 9 named
//    values must assign.
//  - brokerDriver + route-catalog `driver` stay OPEN (plugin seams): a custom
//    driver string must still assign.
//  - RuntimeStatus is CLOSED over public/runtime-row status producers.
//
// Typechecked via tsconfig.test.json / `typecheck:tests` (the package's default
// `typecheck` excludes test/).

import type {
  BrokerExecutionProfile,
  RunStatus,
  RuntimeControlErrorCode,
  RuntimeRouteCatalogEntry,
  RuntimeStatus,
} from '../src/index.ts'

declare const arbitraryString: string

// ── (a) RuntimeControlErrorCode is CLOSED ───────────────────────────────────
// @ts-expect-error EXCEPTION(T-04651): closed-taxonomy negative assertion — arbitrary string must NOT assign to RuntimeControlErrorCode.
const _badErrorCode: RuntimeControlErrorCode = arbitraryString
void _badErrorCode

const allErrorCodes: RuntimeControlErrorCode[] = [
  'compile-failed',
  'no-admissible-profile',
  'capability-missing',
  'capability-degrade-forbidden',
  'legacy-disabled',
  'broker-protocol-mismatch',
  'broker-driver-unavailable',
  'broker-start-failed',
  'broker-input-rejected',
  'broker-busy',
  'broker-queue-not-supported',
  'permission-denied',
  'permission-timeout',
  'runtime-not-found',
  'runtime-state-invalid',
  'runtime-recompile-required',
  'event-projection-failed',
  'restart-reattach-unsupported',
]
void allErrorCodes
// Exhaustiveness pin: exactly 18 named codes.
type _ErrorCodeCount = [RuntimeControlErrorCode] extends [
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
  | 'restart-reattach-unsupported',
]
  ? true
  : never
const _errorCodeClosed: _ErrorCodeCount = true
void _errorCodeClosed

// ── (b) RunStatus is CLOSED ─────────────────────────────────────────────────
// @ts-expect-error EXCEPTION(T-04651): closed-union negative assertion — arbitrary string must NOT assign to RunStatus.
const _badRunStatus: RunStatus = arbitraryString
void _badRunStatus

const allRunStatuses: RunStatus[] = [
  'accepted',
  'started',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'degraded',
  'zombie',
]
void allRunStatuses
type _RunStatusClosed = [RunStatus] extends [
  | 'accepted'
  | 'started'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'degraded'
  | 'zombie',
]
  ? true
  : never
const _runStatusClosed: _RunStatusClosed = true
void _runStatusClosed

// ── (c) Driver plugin seams stay OPEN ───────────────────────────────────────
// brokerDriver accepts a custom/non-core driver string.
const _customBrokerDriver: BrokerExecutionProfile['brokerDriver'] = 'my-custom-driver'
void _customBrokerDriver

// route-catalog `driver` accepts a custom/non-core driver string.
type RouteCatalogBroker = NonNullable<RuntimeRouteCatalogEntry['broker']>
const _customRouteDriver: RouteCatalogBroker['driver'] = 'my-custom-driver'
void _customRouteDriver

// ── (d) RuntimeStatus is CLOSED ─────────────────────────────────────────────
// @ts-expect-error EXCEPTION(T-05007): closed runtime-row status vocabulary — arbitrary string must NOT assign.
const _badRuntimeStatus: RuntimeStatus = arbitraryString
void _badRuntimeStatus
