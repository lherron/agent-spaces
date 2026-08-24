import type {
  BrokerCapabilities,
  BrokerListInvocationsRequest,
  BrokerListInvocationsResponse,
  InputId,
  InvocationCapabilities,
  InvocationCurrentTurnSummary,
  InvocationEventsSinceRequest,
  InvocationEventsSinceResponse,
  InvocationId,
  InvocationInspectionSummary,
  InvocationLifecycleView,
  InvocationLivenessView,
  InvocationSnapshot,
  InvocationSnapshotRequest,
  InvocationSnapshotResponse,
  InvocationStatusRequest,
  InvocationStatusResponse,
  TurnId,
} from '../src/index.ts'

// T-01850/T-01845 §10 corrected contract notes:
// - eventsSince response stays {events,currentSeq,retentionFloorSeq,liveStreamAttached?}.
// - eventsSince request accepts types? only; no limit until a cursor/page design exists.
// - InvocationSnapshot keeps its exported name; InvocationSnapshotResponse is an alias.
// - liveness capability is the string enum 'none' | 'cached' | 'probe'.

const invocationId = 'inv_1' as InvocationId
const turnId = 'turn_1' as TurnId
const inputId = 'input_1' as InputId

const currentTurn = {
  turnId,
  inputId,
  startedAt: '2026-06-03T20:00:00.000Z',
  attempt: 2,
} satisfies InvocationCurrentTurnSummary

const lifecycle = {
  policyId: 'policy_1',
  policyHash: 'hash_1',
  retention: {
    mode: 'idle-ttl',
    idleTtlMs: 30000,
    idleSince: '2026-06-03T20:01:00.000Z',
    computedRetireAt: '2026-06-03T20:01:30.000Z',
    blockedBy: ['active-turn', 'pending-permission'],
  },
  harnessRecovery: {
    mode: 'recycle-child',
    currentGeneration: 3,
  },
  turnRetry: {
    mode: 'safe-retry',
    currentAttempt: 2,
  },
  terminalReason: 'operator-stop',
} satisfies InvocationLifecycleView

const liveness = {
  mode: 'probe',
  checkedAt: '2026-06-03T20:02:00.000Z',
  driver: {
    state: 'healthy',
    lastOutputAt: '2026-06-03T20:01:59.000Z',
  },
  terminalSurface: {
    state: 'alive',
    checkedAt: '2026-06-03T20:02:00.000Z',
  },
  process: {
    brokerPid: 123,
    childPid: 456,
    alive: true,
  },
} satisfies InvocationLivenessView

const inspection = {
  invocationId,
  state: 'ready',
  driver: 'codex-app-server',
  startedAt: '2026-06-03T20:00:00.000Z',
  lastActivityAt: '2026-06-03T20:02:00.000Z',
  currentTurn,
  currentSeq: 42,
  lifecycle,
  liveness,
} satisfies InvocationInspectionSummary

const eventsRequest = {
  invocationId,
  afterSeq: 10,
  live: true,
  types: ['invocation.ready', 'turn.completed'],
} satisfies InvocationEventsSinceRequest
void eventsRequest

const eventsResponse = {
  events: [],
  currentSeq: 42,
  retentionFloorSeq: 7,
  liveStreamAttached: true,
} satisfies InvocationEventsSinceResponse
void eventsResponse

const snapshotRequest = {
  invocationId,
  probeLiveness: true,
} satisfies InvocationSnapshotRequest
void snapshotRequest

const statusRequest = {
  invocationId,
  probeLiveness: true,
} satisfies InvocationStatusRequest
void statusRequest

declare const snapshot: InvocationSnapshot
const snapshotAlias: InvocationSnapshotResponse = snapshot
void snapshotAlias

const status = {
  ...inspection,
  currentTurnId: turnId,
  currentHarnessGeneration: 3,
  currentTurnAttempt: 2,
  capabilities: {} as InvocationCapabilities,
} satisfies InvocationStatusResponse
void status

const listRequest = {
  includeDisposed: true,
  probeLiveness: true,
} satisfies BrokerListInvocationsRequest
void listRequest

const listResponse = {
  invocations: [inspection],
} satisfies BrokerListInvocationsResponse
void listResponse

const brokerCapabilities = {
  multiInvocation: true,
  transports: ['stdio-jsonrpc-ndjson'],
  eventNotifications: true,
  brokerToClientRequests: true,
  inspection: {
    listInvocations: true,
    timestamps: true,
    lifecycleView: true,
    liveness: 'cached',
    eventTypeFilter: true,
  },
} satisfies BrokerCapabilities
void brokerCapabilities

const invocationCapabilities = {
  input: {
    user: true,
    steer: true,
    appendContext: true,
    localImages: false,
    fileRefs: true,
    queue: true,
  },
  turns: {
    concurrency: 'single',
    interrupt: 'protocol',
  },
  continuation: {
    supported: true,
    provider: 'openai',
    keyKind: 'thread',
  },
  events: {
    assistantDeltas: true,
    toolCalls: true,
    usage: true,
    diagnostics: true,
    replay: true,
    ack: true,
  },
  control: {
    stop: true,
    dispose: true,
    status: true,
    attach: true,
    snapshot: true,
    eventsSince: true,
    eventTypeFilter: true,
    liveness: 'probe',
  },
  lifecycle: {
    runtimeRetention: ['idle-ttl'],
    harnessRecovery: ['recycle-child'],
    turnRetry: ['safe-retry'],
    generationFencing: true,
    permissionCancellation: true,
  },
} satisfies InvocationCapabilities
void invocationCapabilities

type NoLimitField = InvocationEventsSinceRequest extends { limit?: unknown } ? never : true
const noLimitField: NoLimitField = true
void noLimitField

type NoLegacyEventsSinceCursor = InvocationEventsSinceResponse extends {
  lastSeq: unknown
  hasMore: unknown
}
  ? never
  : true
const noLegacyEventsSinceCursor: NoLegacyEventsSinceCursor = true
void noLegacyEventsSinceCursor
