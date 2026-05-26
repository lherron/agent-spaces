// @ts-expect-error Test-only sibling import keeps agent-spaces package deps unchanged.
import { BrokerClient } from 'spaces-harness-broker-client'
import { createCanonicalHasher } from 'spaces-runtime-contracts'

import type {
  BrokerHelloResponse,
  InvocationCapabilities,
  InvocationEventEnvelope,
  InvocationStartRequest,
  InvocationStartResponse,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  CapabilityRequirements,
  HrcCapabilityPolicy,
} from 'spaces-runtime-contracts'
import { compileRuntimePlan } from '../compile-runtime-plan.js'
import { buildCorrelationEnvVars } from '../placement-api.js'
import { writePreHrcBrokerContractArtifacts } from './pre-hrc-broker-contract-artifacts.js'
import {
  assertBrokerProfileClosure,
  assertBrokerStartBaselineEvents,
  assertPreHrcRouteDecision,
  assertRealCodexHappyPath,
} from './pre-hrc-broker-contract-assertions.js'
import type {
  ContractHarnessFailure,
  PreHrcBrokerContractAssertionReport,
  PreHrcBrokerContractHarnessInput,
  PreHrcBrokerContractHarnessResult,
  PreHrcRouteDecision,
} from './pre-hrc-broker-contract-types.js'
import { PreHrcBrokerEventLedger } from './pre-hrc-broker-event-ledger.js'
import {
  ContractHarnessFailureError,
  selectBrokerProfile,
  verifyBrokerStartContract,
} from './pre-hrc-broker-helpers.js'

function routeIdFor(value: unknown): string {
  return `prehrc_route_${createCanonicalHasher().hash(value, { timestampMode: 'omit-ephemeral' }).value.slice(0, 32)}`
}

function createPreHrcRouteDecision(
  plan: NonNullable<PreHrcBrokerContractHarnessResult['compiledPlan']>,
  profile: NonNullable<PreHrcBrokerContractHarnessResult['selectedProfile']>
): PreHrcRouteDecision {
  return {
    schemaVersion: 'pre-hrc-route-decision/v1',
    routeId: routeIdFor({
      compileId: plan.compileId,
      planHash: plan.planHash,
      selectedProfileId: profile.profileId,
      selectedProfileHash: profile.profileHash,
    }),
    operationId: plan.identity.operationId,
    compileId: plan.compileId,
    planHash: plan.planHash,
    selectedProfileId: profile.profileId,
    selectedProfileHash: profile.profileHash,
    selectedProfileKind: 'harness-broker',
    controller: 'harness-broker',
    startupMethod: 'create-broker-invocation',
    turnDelivery: 'broker-input',
    identity: plan.identity,
    admission: { decision: 'admit' },
    reuse: {
      policy: 'always-new',
      compatibilityHash: profile.compatibilityHash,
      staleGeneration: 'rotate',
    },
    productPolicy: {
      permissionPolicy: profile.policy.permissionPolicy,
      inputPolicy: profile.policy.inputPolicy,
      exposurePolicy: profile.policy.exposurePolicy,
      ...(profile.policy.resourceLimits !== undefined
        ? { resourceLimits: profile.policy.resourceLimits }
        : {}),
    },
    diagnostics: plan.diagnostics.map(({ level, code, message }) => ({ level, code, message })),
  }
}

function harnessMode(
  input: PreHrcBrokerContractHarnessInput
): PreHrcBrokerContractHarnessResult['mode'] {
  if (input.mode !== undefined) return input.mode
  return input.dryRunCompile === false ? 'broker-start' : 'dry-run-compile'
}

function repoRoot(): string {
  return new URL('../../../../', import.meta.url).pathname
}

function requiredFlag(
  failures: ContractHarnessFailure[],
  ok: boolean,
  path: string,
  message: string,
  details: Record<string, unknown>
): void {
  if (ok) return
  failures.push({
    code: 'broker_capability_missing',
    message,
    path,
    redactedDetails: details,
  })
}

function assertInvocationCapabilities(
  requirements: CapabilityRequirements,
  capabilities: InvocationCapabilities | undefined,
  pathPrefix: string,
  hrcPolicy: HrcCapabilityPolicy | undefined
): ContractHarnessFailure[] {
  if (capabilities === undefined) {
    return [
      {
        code: 'broker_capability_missing',
        message: 'Broker did not report invocation capabilities for the selected driver.',
        path: pathPrefix,
        redactedDetails: { hrcPolicy },
      },
    ]
  }

  const failures: ContractHarnessFailure[] = []
  for (const key of [
    'user',
    'steer',
    'appendContext',
    'localImages',
    'fileRefs',
    'queue',
  ] as const) {
    requiredFlag(
      failures,
      requirements.input[key] !== 'required' || capabilities.input[key] === true,
      `${pathPrefix}.input.${key}`,
      `Required input capability is missing: ${key}.`,
      { required: requirements.input[key], actual: capabilities.input[key], hrcPolicy }
    )
  }

  requiredFlag(
    failures,
    requirements.turns.concurrency === 'any' ||
      requirements.turns.concurrency === capabilities.turns.concurrency,
    `${pathPrefix}.turns.concurrency`,
    `Required turn concurrency is missing: ${requirements.turns.concurrency}.`,
    {
      required: requirements.turns.concurrency,
      actual: capabilities.turns.concurrency,
      hrcPolicy,
    }
  )
  requiredFlag(
    failures,
    requirements.turns.interrupt !== 'required' ||
      capabilities.turns.interrupt === 'protocol' ||
      capabilities.turns.interrupt === 'process',
    `${pathPrefix}.turns.interrupt`,
    'Required turn interrupt capability is missing.',
    { required: requirements.turns.interrupt, actual: capabilities.turns.interrupt, hrcPolicy }
  )
  requiredFlag(
    failures,
    requirements.continuation !== 'required' || capabilities.continuation.supported === true,
    `${pathPrefix}.continuation.supported`,
    'Required continuation capability is missing.',
    {
      required: requirements.continuation,
      actual: capabilities.continuation.supported,
      hrcPolicy,
    }
  )

  for (const key of ['assistantDeltas', 'toolCalls', 'usage', 'diagnostics'] as const) {
    requiredFlag(
      failures,
      requirements.events[key] !== 'required' || capabilities.events[key] === true,
      `${pathPrefix}.events.${key}`,
      `Required event capability is missing: ${key}.`,
      { required: requirements.events[key], actual: capabilities.events[key], hrcPolicy }
    )
  }

  for (const key of ['stop', 'dispose'] as const) {
    requiredFlag(
      failures,
      requirements.control[key] !== 'required' || capabilities.control[key] === true,
      `${pathPrefix}.control.${key}`,
      `Required control capability is missing: ${key}.`,
      { required: requirements.control[key], actual: capabilities.control[key], hrcPolicy }
    )
  }

  requiredFlag(
    failures,
    requirements.control.reconcile !== 'required' || capabilities.control.status === true,
    `${pathPrefix}.control.status`,
    'Required reconcile/status capability is missing.',
    { required: requirements.control.reconcile, actual: capabilities.control.status, hrcPolicy }
  )

  requiredFlag(
    failures,
    requirements.permissions === 'none' ||
      capabilities.permissions?.brokerToClientRequests === true,
    `${pathPrefix}.permissions.brokerToClientRequests`,
    'Required broker permission request capability is missing.',
    { required: requirements.permissions, actual: capabilities.permissions, hrcPolicy }
  )

  return failures
}

function assertBrokerHelloCapabilities(
  profile: BrokerExecutionProfile,
  hello: BrokerHelloResponse,
  hrcPolicy: HrcCapabilityPolicy | undefined
): ContractHarnessFailure[] {
  const failures: ContractHarnessFailure[] = []
  requiredFlag(
    failures,
    hello.capabilities.eventNotifications === true,
    'brokerHello.capabilities.eventNotifications',
    'Broker hello did not advertise event notifications.',
    { actual: hello.capabilities.eventNotifications, hrcPolicy }
  )
  requiredFlag(
    failures,
    profile.expectedCapabilities.permissions === 'none' ||
      hello.capabilities.brokerToClientRequests === true,
    'brokerHello.capabilities.brokerToClientRequests',
    'Broker hello did not advertise broker-to-client permission requests.',
    {
      required: profile.expectedCapabilities.permissions,
      actual: hello.capabilities.brokerToClientRequests,
      hrcPolicy,
    }
  )
  requiredFlag(
    failures,
    profile.expectedCapabilities.control.attachReplay !== 'required' ||
      hello.capabilities.attachReplay === true,
    'brokerHello.capabilities.attachReplay',
    'Broker hello did not advertise required attach/replay capability.',
    {
      required: profile.expectedCapabilities.control.attachReplay,
      actual: hello.capabilities.attachReplay,
      hrcPolicy,
    }
  )

  const driver = hello.drivers.find((candidate) => candidate.kind === profile.brokerDriver)
  if (driver === undefined || !driver.available) {
    failures.push({
      code: 'broker_capability_missing',
      message: 'Broker hello did not advertise an available selected driver.',
      path: 'brokerHello.drivers',
      redactedDetails: {
        brokerDriver: profile.brokerDriver,
        availableDrivers: hello.drivers.map(({ kind, available }) => ({ kind, available })),
        hrcPolicy,
      },
    })
    return failures
  }

  return [
    ...failures,
    ...assertInvocationCapabilities(
      profile.expectedCapabilities,
      driver.capabilities,
      `brokerHello.drivers.${driver.kind}.capabilities`,
      hrcPolicy
    ),
  ]
}

function selectInteractiveTmuxProfile(
  plan: NonNullable<PreHrcBrokerContractHarnessResult['compiledPlan']>,
  selector: PreHrcBrokerContractHarnessInput['profileSelector']
): BrokerExecutionProfile {
  const profiles = plan.executionProfiles.filter(
    (profile): profile is BrokerExecutionProfile => profile.kind === 'harness-broker'
  )
  let candidates = profiles
  if (selector?.profileId !== undefined) {
    candidates = candidates.filter((profile) => profile.profileId === selector.profileId)
  }
  if (selector?.profileHash !== undefined) {
    candidates = candidates.filter((profile) => profile.profileHash === selector.profileHash)
  }
  const selected = candidates.find(
    (profile) =>
      profile.interactionMode === 'interactive' && profile.brokerDriver === 'claude-code-tmux'
  )
  if (selected === undefined) {
    throw new ContractHarnessFailureError({
      code: 'interactive_tmux_mode_invalid',
      message: 'interactive-tmux mode requires an interactive claude-code-tmux broker profile.',
      path: 'plan.executionProfiles',
      redactedDetails: {
        selector,
        candidates: candidates.map((profile) => ({
          profileId: profile.profileId,
          interactionMode: profile.interactionMode,
          brokerDriver: profile.brokerDriver,
        })),
      },
    })
  }
  return selected
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

type InteractiveTmuxResult = NonNullable<PreHrcBrokerContractHarnessResult['interactiveTmux']>
type DynamicFactory<TArgs extends unknown[], TResult> = (...args: TArgs) => TResult
type InProcessInvocationManager = {
  start: (
    spec: InvocationStartRequest['spec'],
    driver: unknown,
    initialInput: undefined,
    dispatchEnv: Record<string, string> | undefined,
    runtime: { tmux: { socketPath: string } }
  ) => Promise<InvocationStartResponse>
  input: (request: {
    invocationId: string
    input: {
      inputId?: string | undefined
      kind: 'user'
      content: Array<{ type: 'text'; text: string }>
    }
    policy: { whenBusy: 'reject' }
  }) => Promise<{ inputId: string; accepted: boolean; disposition: string; turnId?: string }>
  stop: (request: { invocationId: string; reason: string }) => Promise<unknown>
  dispose: (request: { invocationId: string }) => Promise<unknown>
  status: (invocationId: string) => { state: string }
}

// Exported so the Phase 5 real-target e2e runner (scripts/phase5-real-claude-
// tmux-e2e.ts) can re-run the SIGNED Phase 4 interactive-tmux ledger assertions
// verbatim on a REAL Claude tmux session ledger. The deterministic Phase 4
// harness path keeps calling it in-module; exporting adds no new imports and
// does not change its behavior.
export function assertInteractiveTmuxEvents(input: {
  events: InvocationEventEnvelope[]
  socketPath: string
  inputTurnId: string
  driverDisposed: boolean
  hookListenerClosed: boolean
  queuedInputLeft: boolean
  tmuxServerEvents: Array<{
    owner: 'harness'
    action: 'start-server' | 'kill-server'
    socketPath: string
  }>
  driverTmuxArgv: string[][]
}): ContractHarnessFailure[] {
  const failures: ContractHarnessFailure[] = []
  const { events, socketPath, inputTurnId } = input
  const eventTypes = events.map((event) => event.type)
  const surfaceIndex = eventTypes.indexOf('terminal.surface.reported' as never)
  const turnStarted = events.find(
    (event) => event.type === 'turn.started' && event.turnId === inputTurnId
  )
  const terminalTurns = events.filter(
    (event) =>
      event.type === 'turn.completed' ||
      event.type === 'turn.failed' ||
      event.type === 'turn.interrupted'
  )

  if (surfaceIndex === -1) {
    failures.push({
      code: 'interactive_tmux_surface_invalid',
      message: 'interactive-tmux ledger must report the terminal surface before turns.',
      path: 'brokerEvents',
    })
  } else {
    const surface = events[surfaceIndex]
    const payload = asRecord(surface?.payload)
    if (
      payload?.['socketPath'] !== socketPath ||
      typeof payload?.['sessionName'] !== 'string' ||
      typeof payload?.['paneId'] !== 'string'
    ) {
      failures.push({
        code: 'interactive_tmux_surface_invalid',
        message:
          'terminal.surface.reported must carry the runtime tmux socket plus observed session/pane ids.',
        path: `brokerEvents.${surface?.invocationId}.${surface?.seq}.payload`,
        redactedDetails: { expectedSocketPath: socketPath, payload },
      })
    }
  }

  if (turnStarted === undefined) {
    failures.push({
      code: 'interactive_tmux_turn_correlation_invalid',
      message: 'turn.started must correlate to the broker turn id returned by applyInputNow/input.',
      path: 'brokerEvents',
      redactedDetails: { inputTurnId },
    })
  } else if (surfaceIndex !== -1 && events.indexOf(turnStarted) < surfaceIndex) {
    failures.push({
      code: 'interactive_tmux_event_sequence_invalid',
      message: 'terminal.surface.reported must appear before turn.started.',
      path: `brokerEvents.${turnStarted.invocationId}.${turnStarted.seq}`,
    })
  }

  const matchingTerminalTurns = terminalTurns.filter((event) => event.turnId === inputTurnId)
  if (matchingTerminalTurns.length !== 1) {
    failures.push({
      code: 'broker_terminal_turn_count_invalid',
      message:
        'interactive-tmux ledger must contain exactly one terminal turn event for the applied input.',
      path: 'brokerEvents',
      redactedDetails: {
        inputTurnId,
        count: matchingTerminalTurns.length,
        terminalTypes: matchingTerminalTurns.map((event) => event.type),
      },
    })
  }

  const hasStopClassInvocationExit = events.some(
    (event) =>
      event.type === 'invocation.exited' &&
      ['Stop', 'SessionEnd', 'SubagentStop'].includes(event.driver?.rawType ?? '')
  )
  if (hasStopClassInvocationExit) {
    failures.push({
      code: 'interactive_tmux_event_sequence_invalid',
      message: 'Stop-class Claude hooks must not normalize to invocation.exited.',
      path: 'brokerEvents',
    })
  }

  for (const event of events) {
    if (event.type !== 'tool.call.completed') continue
    const payload = asRecord(event.payload)
    const rawType = event.driver?.rawType
    if (
      rawType === 'PostToolUse' &&
      payload?.['isError'] === true &&
      asRecord(payload['result']) === undefined
    ) {
      failures.push({
        code: 'interactive_tmux_tool_mapping_invalid',
        message:
          'PostToolUse errors/nonzero results must remain tool.call.completed with result/error detail.',
        path: `brokerEvents.${event.invocationId}.${event.seq}.payload`,
      })
    }
  }
  if (
    events.some(
      (event) => event.type === 'tool.call.failed' && event.driver?.rawType === 'PostToolUse'
    )
  ) {
    failures.push({
      code: 'interactive_tmux_tool_mapping_invalid',
      message: 'PostToolUse must not normalize to tool.call.failed.',
      path: 'brokerEvents',
    })
  }

  const permissionEvents = events.filter(
    (event) => event.type === 'permission.requested' || event.type === 'permission.resolved'
  )
  if (permissionEvents.length === 1 || permissionEvents.length > 2) {
    failures.push({
      code: 'interactive_tmux_event_sequence_invalid',
      message: 'Permission events, when actionable, must be requested/resolved pairs.',
      path: 'brokerEvents',
      redactedDetails: { permissionEventTypes: permissionEvents.map((event) => event.type) },
    })
  }

  const driverCommands = input.driverTmuxArgv.flat()
  if (driverCommands.includes('start-server') || driverCommands.includes('kill-server')) {
    failures.push({
      code: 'interactive_tmux_runtime_socket_missing',
      message: 'interactive-tmux driver must not start or kill the tmux server.',
      path: 'interactiveTmux.driverTmuxArgv',
    })
  }
  if (
    input.tmuxServerEvents[0]?.action !== 'start-server' ||
    input.tmuxServerEvents.at(-1)?.action !== 'kill-server' ||
    input.tmuxServerEvents.some(
      (event) => event.owner !== 'harness' || event.socketPath !== socketPath
    )
  ) {
    failures.push({
      code: 'interactive_tmux_runtime_socket_missing',
      message: 'interactive-tmux mode must start and tear down the tmux server as the harness.',
      path: 'interactiveTmux.tmuxServerEvents',
      redactedDetails: input.tmuxServerEvents,
    })
  }
  if (!input.driverDisposed || !input.hookListenerClosed || input.queuedInputLeft) {
    failures.push({
      code: 'interactive_tmux_clean_exit_invalid',
      message:
        'interactive-tmux clean exit requires no queued input, closed hook listener, disposed driver, and harness-owned tmux teardown.',
      path: 'interactiveTmux',
      redactedDetails: {
        driverDisposed: input.driverDisposed,
        hookListenerClosed: input.hookListenerClosed,
        queuedInputLeft: input.queuedInputLeft,
      },
    })
  }

  return failures
}

async function nextBrokerEvent(
  iterator: AsyncIterator<InvocationEventEnvelope>,
  timeoutMs: number
): Promise<InvocationEventEnvelope> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<InvocationEventEnvelope>>((resolve) => {
        timer = setTimeout(() => resolve({ done: true, value: undefined }), timeoutMs)
      }),
    ])
    if (result.done === true) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for broker event.`)
    }
    return result.value
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function collectEventsUntilTerminalTurn(
  events: AsyncIterable<InvocationEventEnvelope>,
  ledger: PreHrcBrokerEventLedger,
  timeoutMs: number
): Promise<ContractHarnessFailure[]> {
  const iterator = events[Symbol.asyncIterator]()
  while (ledger.terminalTurnEvent() === undefined) {
    try {
      ledger.append(await nextBrokerEvent(iterator, timeoutMs))
    } catch (error) {
      return [
        {
          code: 'broker_event_timeout',
          message: error instanceof Error ? error.message : String(error),
        },
      ]
    }
  }
  return []
}

async function startBrokerInvocation(
  profile: BrokerExecutionProfile,
  dispatchEnv: Record<string, string> | undefined,
  hrcPolicy: HrcCapabilityPolicy | undefined,
  timeoutMs: number,
  allowLegacyPermissionEvent: boolean
): Promise<{
  brokerStart: NonNullable<PreHrcBrokerContractHarnessResult['brokerStart']>
  failures: ContractHarnessFailure[]
}> {
  let brokerClient: BrokerClient | undefined
  const ledger = new PreHrcBrokerEventLedger()
  const permissionAudit: Array<{ permissionRequestId: string; kind: string; decision: 'deny' }> = []

  try {
    brokerClient = await BrokerClient.start({
      command: 'bun',
      args: ['packages/harness-broker/bin/harness-broker.js', 'run', '--transport', 'stdio'],
      cwd: repoRoot(),
    })
    const hello = await brokerClient.hello({
      clientInfo: { name: 'pre-hrc-broker-contract-harness', version: '0.1.0' },
      protocolVersions: ['harness-broker/0.1'],
      capabilities: { permissionRequests: true },
    })
    const helloFailures = assertBrokerHelloCapabilities(profile, hello, hrcPolicy)
    if (helloFailures.length > 0) {
      return {
        brokerStart: { attempted: false, reason: 'capability-missing' },
        failures: helloFailures,
      }
    }

    brokerClient.onPermissionRequest(async (request: PermissionRequestParams) => {
      permissionAudit.push({
        permissionRequestId: request.permissionRequestId,
        kind: request.kind,
        decision: 'deny',
      })
      return { decision: 'deny' as const }
    })

    const startResult = await brokerClient.startInvocationFromRequest(
      profile.harnessInvocation.startRequest,
      dispatchEnv
    )
    const invocationFailures = assertInvocationCapabilities(
      profile.expectedCapabilities,
      startResult.response.capabilities,
      'invocationStart.response.capabilities',
      hrcPolicy
    )
    const eventFailures = await collectEventsUntilTerminalTurn(
      startResult.events,
      ledger,
      timeoutMs
    )
    const ledgerFailures = [
      ...ledger.requireMonotonicSeq(),
      ...ledger.requireNoDuplicates(),
      ...ledger.requireOnlyNormalizedEventTypes({ allowLegacyPermissionEvent }),
    ]
    const terminalFailures =
      ledger.terminalTurnEvent() === undefined
        ? [
            {
              code: 'broker_terminal_turn_missing' as const,
              message: 'Broker event stream did not produce a terminal turn event.',
            },
          ]
        : []

    if (startResult.response.capabilities.control.dispose === true) {
      await brokerClient.dispose({ invocationId: startResult.invocationId }).catch(() => undefined)
    }

    return {
      brokerStart: {
        attempted: true,
        response: startResult.response,
        events: ledger.events(),
        eventTypes: ledger.eventTypes(),
        permissionAudit,
      },
      failures: [...invocationFailures, ...eventFailures, ...ledgerFailures, ...terminalFailures],
    }
  } catch (error) {
    return {
      brokerStart: { attempted: false, reason: 'broker-start-failed' },
      failures: [
        {
          code: 'broker_start_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    }
  } finally {
    await brokerClient?.close().catch(() => undefined)
  }
}

async function runInteractiveTmuxInvocation(
  profile: BrokerExecutionProfile,
  runtimeOptions: PreHrcBrokerContractHarnessInput['interactiveTmux'],
  dispatchEnv: Record<string, string> | undefined,
  allowLegacyPermissionEvent: boolean
): Promise<{
  brokerStart: NonNullable<PreHrcBrokerContractHarnessResult['brokerStart']>
  interactiveTmux: InteractiveTmuxResult
  failures: ContractHarnessFailure[]
}> {
  const socketPath =
    runtimeOptions?.socketPath ??
    `/tmp/prehrc-interactive-tmux-${profile.harnessInvocation.startRequest.spec.invocationId ?? 'inv'}.sock`
  const tmuxBin = runtimeOptions?.tmuxBin ?? '/opt/bin/tmux'
  const tmuxServerEvents: Array<{
    owner: 'harness'
    action: 'start-server' | 'kill-server'
    socketPath: string
  }> = []
  const driverTmuxArgv: string[][] = []
  let hookHandler:
    | ((envelope: {
        invocationId: string
        generation: number
        callbackSocket: string
        runtimeId?: string | undefined
        turnId?: string | undefined
        hookData: unknown
      }) => Promise<void>)
    | undefined
  let hookListenerClosed = false
  let driverDisposed = false
  let tmuxServerTornDown = false

  const events: InvocationEventEnvelope[] = []
  const ledger = new PreHrcBrokerEventLedger()
  const startRequest = profile.harnessInvocation.startRequest as InvocationStartRequest
  const invocationId = startRequest.spec.invocationId ?? 'inv_prehrc_interactive'

  try {
    tmuxServerEvents.push({ owner: 'harness', action: 'start-server', socketPath })

    const importSibling = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<Record<string, unknown>>
    const { createInvocationManager } = await importSibling(
      '../../../harness-broker/src/invocation-manager'
    )
    const { createInvocationEventSequencer } = await importSibling(
      '../../../harness-broker/src/events'
    )
    const driverSpecifier = [
      '../../../harness-broker/src',
      'drivers',
      'claude-code-tmux',
      'driver',
    ].join('/')
    const { createClaudeCodeTmuxDriver } = await importSibling(driverSpecifier)

    const createManager = createInvocationManager as DynamicFactory<
      [unknown],
      InProcessInvocationManager
    >
    const createSequencer = createInvocationEventSequencer as DynamicFactory<[unknown], unknown>
    const createTmuxDriver = createClaudeCodeTmuxDriver as DynamicFactory<[unknown], unknown>

    const manager = createManager({
      sequencer: createSequencer({
        now: () => new Date('2026-05-26T12:00:00.000Z'),
      }),
      onEvent: (event: InvocationEventEnvelope) => {
        events.push(event)
        ledger.append(event)
      },
    })
    const driver = createTmuxDriver({
      tmux: {
        socketPath,
        tmuxBin,
        exec: async (argv: string[]) => {
          driverTmuxArgv.push([...argv])
          if (argv.includes('start-server') || argv.includes('kill-server')) {
            throw new Error('driver attempted to own tmux server')
          }
          if (argv.includes('list-panes')) {
            throw new Error("can't find session: hostSession")
          }
          if (argv.includes('new-session')) {
            return { stdout: '$1\t@1\t%7\thrc-host-sessio\n', stderr: '' }
          }
          return { stdout: '', stderr: '' }
        },
      },
      hooks: {
        listen: async (handler: typeof hookHandler) => {
          hookHandler = handler
          return {
            socketPath: `${socketPath}.hooks`,
            close: async () => {
              hookListenerClosed = true
            },
          }
        },
      },
      now: () => new Date('2026-05-26T12:00:00.000Z'),
    })

    const response = await manager.start(startRequest.spec, driver, undefined, dispatchEnv, {
      tmux: { socketPath },
    })
    if (hookHandler === undefined) {
      throw new Error('interactive-tmux driver did not install a hook listener')
    }

    const inputResponse = await manager.input({
      invocationId: response.invocationId,
      input: {
        inputId: startRequest.initialInput?.inputId,
        kind: 'user',
        content: [
          {
            type: 'text',
            text: runtimeOptions?.userInputText ?? 'drive deterministic interactive tmux turn',
          },
        ],
      },
      policy: { whenBusy: 'reject' },
    })
    if (inputResponse.turnId === undefined) {
      throw new Error('interactive-tmux input did not return a turn id')
    }

    await hookHandler({
      invocationId: response.invocationId,
      generation: 1,
      callbackSocket: `${socketPath}.hooks`,
      hookData: { hook_event_name: 'UserPromptSubmit', prompt: 'deterministic input' },
    })
    await hookHandler({
      invocationId: response.invocationId,
      generation: 1,
      callbackSocket: `${socketPath}.hooks`,
      hookData: {
        hook_event_name: 'PreToolUse',
        tool_use_id: 'toolu_prehrc_1',
        tool_name: 'Bash',
        tool_input: { command: 'false' },
      },
    })
    await hookHandler({
      invocationId: response.invocationId,
      generation: 1,
      callbackSocket: `${socketPath}.hooks`,
      hookData: {
        hook_event_name: 'PostToolUse',
        tool_use_id: 'toolu_prehrc_1',
        tool_name: 'Bash',
        tool_input: { command: 'false' },
        is_error: true,
        tool_response: { exit_code: 1, stderr: 'failed deterministically' },
      },
    })
    if (runtimeOptions?.includePermissionEvents === true) {
      await hookHandler({
        invocationId: response.invocationId,
        generation: 1,
        callbackSocket: `${socketPath}.hooks`,
        hookData: {
          hook_event_name: 'PermissionRequest',
          permission_request_id: 'perm_prehrc_1',
          kind: 'command',
          subject_display: 'Bash false',
          default_decision: 'deny',
        },
      })
      await hookHandler({
        invocationId: response.invocationId,
        generation: 1,
        callbackSocket: `${socketPath}.hooks`,
        hookData: {
          hook_event_name: 'PermissionResolved',
          permission_request_id: 'perm_prehrc_1',
          decision: 'deny',
          decided_by: 'policy',
        },
      })
    }
    await hookHandler({
      invocationId: response.invocationId,
      generation: 1,
      callbackSocket: `${socketPath}.hooks`,
      hookData: { hook_event_name: 'Stop' },
    })
    await hookHandler({
      invocationId: response.invocationId,
      generation: 1,
      callbackSocket: `${socketPath}.hooks`,
      hookData: { hook_event_name: 'SessionEnd' },
    })
    await hookHandler({
      invocationId: response.invocationId,
      generation: 1,
      callbackSocket: `${socketPath}.hooks`,
      hookData: { hook_event_name: 'SubagentStop' },
    })

    await manager.stop({ invocationId: response.invocationId, reason: 'prehrc clean exit' })
    if (runtimeOptions?.simulateQueuedInputLeftForTest !== true) {
      await manager.dispose({ invocationId: response.invocationId })
      driverDisposed = true
    }
    tmuxServerEvents.push({ owner: 'harness', action: 'kill-server', socketPath })
    tmuxServerTornDown = true
    const queuedInputLeft = manager.status(response.invocationId).state !== 'disposed'

    const surfaceEvent = events.find((event) => event.type === 'terminal.surface.reported')
    const surfacePayload = asRecord(surfaceEvent?.payload)
    const surface =
      surfacePayload !== undefined &&
      typeof surfacePayload['socketPath'] === 'string' &&
      typeof surfacePayload['sessionName'] === 'string' &&
      typeof surfacePayload['paneId'] === 'string'
        ? {
            socketPath: surfacePayload['socketPath'],
            sessionName: surfacePayload['sessionName'],
            paneId: surfacePayload['paneId'],
          }
        : undefined

    const interactiveTmux: InteractiveTmuxResult = {
      attempted: true,
      socketPath,
      tmuxServerEvents,
      driverTmuxArgv,
      hookListenerClosed,
      driverDisposed,
      queuedInputLeft,
      inputTurnId: inputResponse.turnId,
      surface,
    }

    const ledgerFailures = [
      ...ledger.requireMonotonicSeq(),
      ...ledger.requireNoDuplicates(),
      ...ledger.requireOnlyNormalizedEventTypes({ allowLegacyPermissionEvent }),
      ...assertInteractiveTmuxEvents({
        events,
        socketPath,
        inputTurnId: inputResponse.turnId,
        driverDisposed,
        hookListenerClosed,
        queuedInputLeft,
        tmuxServerEvents,
        driverTmuxArgv,
      }),
    ]

    return {
      brokerStart: {
        attempted: true,
        response,
        events,
        eventTypes: events.map((event) => event.type),
        permissionAudit: [],
      },
      interactiveTmux,
      failures: ledgerFailures,
    }
  } catch (error) {
    return {
      brokerStart: { attempted: false, reason: 'broker-start-failed' },
      interactiveTmux: { attempted: false, reason: 'interactive-tmux-failed' },
      failures: [
        {
          code: 'broker_start_failed',
          message: error instanceof Error ? error.message : String(error),
          redactedDetails: { invocationId },
        },
      ],
    }
  } finally {
    if (!tmuxServerTornDown) {
      tmuxServerEvents.push({ owner: 'harness', action: 'kill-server', socketPath })
    }
  }
}

export async function runPreHrcBrokerContractHarness(
  input: PreHrcBrokerContractHarnessInput
): Promise<PreHrcBrokerContractHarnessResult> {
  const mode = harnessMode(input)
  const compileResponse = await compileRuntimePlan(input.compileRequest, {
    clientAspHome: input.aspHome,
  })
  const compiledPlan = compileResponse.ok ? compileResponse.plan : undefined

  // Select the harness-broker profile via the shared named helper (P2). Failure
  // to find a compatible profile is surfaced as a structured failure rather than
  // an unhandled throw so the assertion report stays complete.
  const selectionFailures: ContractHarnessFailure[] = []
  let selectedProfile: BrokerExecutionProfile | undefined
  if (!compileResponse.ok) {
    selectionFailures.push({
      code: 'compile_failed',
      message: 'compileRuntimePlan returned diagnostics instead of a compiled plan.',
      redactedDetails: { diagnostics: compileResponse.diagnostics },
    })
  } else {
    try {
      selectedProfile =
        mode === 'interactive-tmux'
          ? selectInteractiveTmuxProfile(compileResponse.plan, input.profileSelector)
          : selectBrokerProfile(compileResponse.plan, input.profileSelector)
    } catch (error) {
      if (error instanceof ContractHarnessFailureError) {
        selectionFailures.push(error.failure)
      } else {
        throw error
      }
    }
  }

  // TEST-ONLY seam: simulate local code mutating the start request between
  // compile and broker start so the closure verifier below can be exercised.
  if (selectedProfile !== undefined && input.mutateProfileForTest !== undefined) {
    input.mutateProfileForTest(selectedProfile)
  }

  // Compiler-closure verification (P3): recompute spec/start-request hashes and
  // assert immutability BEFORE any broker start. Deep-freezes the start request
  // on success.
  const verification =
    selectedProfile !== undefined ? verifyBrokerStartContract(selectedProfile) : undefined

  const routeDecision =
    compiledPlan !== undefined && selectedProfile !== undefined
      ? createPreHrcRouteDecision(compiledPlan, selectedProfile)
      : undefined

  const failures: ContractHarnessFailure[] = [
    ...selectionFailures,
    ...assertBrokerProfileClosure(compileResponse, selectedProfile),
    ...(verification?.failures ?? []),
    ...assertPreHrcRouteDecision(routeDecision, selectedProfile, compileResponse),
  ]

  const contractVerificationFailed = verification !== undefined && !verification.ok
  let brokerStart: PreHrcBrokerContractHarnessResult['brokerStart']
  let interactiveTmux: PreHrcBrokerContractHarnessResult['interactiveTmux']
  let brokerEvents: InvocationEventEnvelope[] = []
  if (mode === 'broker-start' && !contractVerificationFailed && selectedProfile !== undefined) {
    const placementDispatchEnv =
      (input.compileRequest.placement as { dispatchEnv?: Record<string, string> | undefined })
        .dispatchEnv ?? {}
    const dispatchEnv = {
      ...buildCorrelationEnvVars(
        input.compileRequest.placement as unknown as Parameters<typeof buildCorrelationEnvVars>[0]
      ),
      ...placementDispatchEnv,
    }
    const brokerResult = await startBrokerInvocation(
      selectedProfile,
      dispatchEnv,
      input.compileRequest.hrcPolicy.capabilityPolicy,
      input.timeoutMs ?? selectedProfile.policy.resourceLimits?.turnTimeoutMs ?? 10_000,
      input.allowLegacyPermissionEvent === true
    )
    brokerStart = brokerResult.brokerStart
    brokerEvents =
      brokerResult.brokerStart.attempted === true ? brokerResult.brokerStart.events : []
    failures.push(...brokerResult.failures)
    if (brokerResult.brokerStart.attempted === true) {
      if (input.brokerStartAssertions?.baseline !== undefined) {
        failures.push(
          ...assertBrokerStartBaselineEvents(
            brokerResult.brokerStart.events,
            input.brokerStartAssertions.baseline
          )
        )
      }
      if (input.brokerStartAssertions?.realCodexHappyPath !== undefined) {
        failures.push(
          ...assertRealCodexHappyPath(brokerResult.brokerStart.events, {
            ...input.brokerStartAssertions.realCodexHappyPath,
            expectedCwd:
              input.brokerStartAssertions.realCodexHappyPath.expectedCwd ??
              selectedProfile.harnessInvocation.startRequest.spec.process.cwd,
          })
        )
      }
    }
  }
  if (mode === 'interactive-tmux' && !contractVerificationFailed && selectedProfile !== undefined) {
    const placementDispatchEnv =
      (input.compileRequest.placement as { dispatchEnv?: Record<string, string> | undefined })
        .dispatchEnv ?? {}
    const dispatchEnv = {
      ...buildCorrelationEnvVars(
        input.compileRequest.placement as unknown as Parameters<typeof buildCorrelationEnvVars>[0]
      ),
      ...placementDispatchEnv,
    }
    const interactiveResult = await runInteractiveTmuxInvocation(
      selectedProfile,
      input.interactiveTmux,
      dispatchEnv,
      input.allowLegacyPermissionEvent === true
    )
    brokerStart = interactiveResult.brokerStart
    interactiveTmux = interactiveResult.interactiveTmux
    brokerEvents =
      interactiveResult.brokerStart.attempted === true ? interactiveResult.brokerStart.events : []
    failures.push(...interactiveResult.failures)
  }

  const assertionReport: PreHrcBrokerContractAssertionReport = {
    schemaVersion: 'pre-hrc-broker-contract-assertion-report/v1',
    ok: failures.length === 0,
    failures,
    diagnostics: compileResponse.diagnostics,
  }

  let artifactFailures: ContractHarnessFailure[] = []
  let artifacts: PreHrcBrokerContractHarnessResult['artifacts']
  if (input.artifactDir !== undefined) {
    const written = await writePreHrcBrokerContractArtifacts({
      artifactDir: input.artifactDir,
      compileRequest: input.compileRequest,
      compiledPlan,
      selectedProfile,
      routeDecision,
      brokerEvents,
      assertionReport,
      writeRawStartRequest: input.writeRawStartRequest,
    })
    artifacts = written.manifest
    artifactFailures = written.failures
  }

  const allFailures = [...failures, ...artifactFailures]
  const finalAssertionReport: PreHrcBrokerContractAssertionReport = {
    ...assertionReport,
    ok: allFailures.length === 0,
    failures: allFailures,
  }

  return {
    schemaVersion: 'pre-hrc-broker-contract-harness-result/v1',
    ok: allFailures.length === 0,
    mode,
    compileResponse,
    compiledPlan,
    selectedProfile,
    routeDecision,
    artifacts,
    assertionReport: finalAssertionReport,
    brokerStart:
      brokerStart ??
      (mode === 'dry-run-compile'
        ? { attempted: false, reason: 'dry-run-compile' }
        : { attempted: false, reason: 'contract-verification-failed' }),
    interactiveTmux:
      interactiveTmux ??
      (mode === 'interactive-tmux'
        ? { attempted: false, reason: 'contract-verification-failed' }
        : { attempted: false, reason: 'not-interactive-tmux' }),
  }
}
