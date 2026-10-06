import { readFile } from 'node:fs/promises'
import type {
  ArrisHostDescriptor,
  HarnessInvocationSpec,
  InvocationCapabilities,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
} from 'spaces-harness-broker-protocol'
import {
  BrokerErrorCode,
  CONSERVATIVE_LIFECYCLE_CAPABILITIES,
  validateArrisHostDescriptor,
} from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import type { ApplyInputResult, Driver, DriverContext, DriverStartResult } from '../driver'
import { withDeliveryEvidence } from '../driver'
import { ARRIS_RESIDENT_AUTHORITY } from '../evidence-authority'
import { type ArrisControlClient, createArrisControlClient } from './control-client'
import {
  ARRIS_RESIDENT_DRIVER_KIND,
  type ArrisResidentDriverSpec,
  assertDescriptorMatchesSpec,
  parseSpec,
} from './driver-spec'
import { createHostStateAnnouncer } from './host-state-notices'
import { createInputReceiptLedger } from './input-receipts'
import { createArrisJournal } from './journal'
import { createResidentState } from './resident-state'

const ARRIS_RESIDENT_DRIVER_VERSION = '0.1.0'

export interface ArrisResidentDriverOptions {
  pollIntervalMs?: number | undefined
  readDescriptor?: ((path: string) => Promise<unknown>) | undefined
  createControlClient?: ((socketPath: string) => ArrisControlClient) | undefined
}

const ARRIS_CAPABILITIES: InvocationCapabilities = {
  admission: { classes: ['queue', 'steer'] },
  bracketMintingMode: 'observed',
  queue: { cancelHarnessLocal: false },
  preempt: { mode: null },
  steer: { landingEvidence: 'transcript' },
  interrupt: { landingEvidence: null },
  input: {
    user: true,
    steer: false,
    appendContext: false,
    localImages: false,
    fileRefs: false,
    queue: true,
  },
  turns: { concurrency: 'single', interrupt: 'unsupported' },
  continuation: { supported: false },
  events: {
    assistantDeltas: true,
    toolCalls: true,
    usage: false,
    diagnostics: true,
    replay: true,
    ack: true,
  },
  control: {
    stop: true,
    dispose: true,
    attach: true,
    status: true,
    snapshot: true,
    eventsSince: true,
    eventTypeFilter: true,
    liveness: 'cached',
    driverAttachExistingSurface: true,
  },
  lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
}

/**
 * Drives a resident Arris host the broker did not launch: binds to the host's
 * published descriptor, writes inputs through its control socket, and reads
 * turns back from its event journal, polling the descriptor for rebinds.
 */
export function createArrisResidentDriver(options: ArrisResidentDriverOptions = {}): Driver {
  const pollIntervalMs = options.pollIntervalMs ?? 100
  const readDescriptor = options.readDescriptor ?? readJsonFile
  const openControl = options.createControlClient ?? createArrisControlClient
  let ctx: DriverContext | undefined
  let spec: ArrisResidentDriverSpec | undefined
  let descriptor: ArrisHostDescriptor | undefined
  let control: ArrisControlClient | undefined
  let controlSocketPath: string | undefined
  let poller: ReturnType<typeof setInterval> | undefined
  let stopped = true
  const state = createResidentState()
  const hostState = createHostStateAnnouncer()

  function requireCtx(): DriverContext {
    if (ctx === undefined)
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Arris driver is not started')
    return ctx
  }

  function activeDescriptor(): ArrisHostDescriptor {
    if (descriptor === undefined)
      throw new BrokerError(
        BrokerErrorCode.InvalidInvocationState,
        'Arris descriptor is not loaded'
      )
    return descriptor
  }

  function activeControl(): ArrisControlClient {
    if (control === undefined) {
      throw withDeliveryEvidence(
        new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          'Arris control socket is not ready'
        ),
        'not_written'
      )
    }
    return control
  }

  const receipts = createInputReceiptLedger(state, {
    ctx: requireCtx,
    descriptor: activeDescriptor,
    control: activeControl,
  })
  const journal = createArrisJournal(state, { ctx: requireCtx, descriptor: activeDescriptor })

  function readJournal(): void {
    if (stopped || descriptor === undefined) return
    journal.readNew(descriptor)
  }

  async function refreshDescriptor(): Promise<void> {
    const activeSpec = spec
    if (activeSpec === undefined) return
    const parsed = validateArrisHostDescriptor(await readDescriptor(activeSpec.descriptorPath))
    if (!parsed.ok)
      throw new BrokerError(
        BrokerErrorCode.DispatchValidationFailed,
        'Invalid Arris host descriptor',
        { issues: parsed.issues }
      )
    assertDescriptorMatchesSpec(activeSpec, parsed.value)
    descriptor = parsed.value
    hostState.announce(ctx?.emit, parsed.value)
    if (parsed.value.events.dropped_records > 0)
      state.healthReason = `Arris host dropped ${parsed.value.events.dropped_records} event record(s)`
    const socketPath = parsed.value.control.socket_path
    if (socketPath === null) {
      control = undefined
      controlSocketPath = undefined
    } else if (socketPath !== controlSocketPath) {
      control = openControl(socketPath)
      controlSocketPath = socketPath
      await receipts.reconcileUnresolved(control)
    }
    journal.retarget(parsed.value.events.path)
  }

  function cleanup(): void {
    stopped = true
    hostState.silence()
    if (poller !== undefined) clearInterval(poller)
    poller = undefined
  }

  return {
    kind: ARRIS_RESIDENT_DRIVER_KIND,
    version: ARRIS_RESIDENT_DRIVER_VERSION,
    bracketMintingMode: 'observed',
    evidenceAuthority: ARRIS_RESIDENT_AUTHORITY,
    nativeSourceKind: 'provider-jsonl',
    preemptMode: null,
    steerLandingEvidence: 'transcript',
    interruptLandingEvidence: null,
    steerNeverStartsTurn: true,
    blocksAdmissionWhileHarnessLocalQueued: true,
    confirmsSubmissionExecutionOnOwnAttribution: true,
    capabilities: () => ARRIS_CAPABILITIES,
    captureNormalizer: () => journal.normalize,
    runtimeHealth: () =>
      state.healthReason === undefined
        ? { state: 'healthy' }
        : { state: 'degraded', reason: state.healthReason },
    probeAdmissionState: () => ({ harnessLocalQueueDepth: state.retryHold ? 1 : 0 }),

    async start(
      startSpec: HarnessInvocationSpec,
      driverCtx: DriverContext
    ): Promise<DriverStartResult> {
      cleanup()
      const parsedSpec = parseSpec(startSpec)
      ctx = driverCtx
      spec = parsedSpec
      stopped = false
      state.healthReason = undefined
      state.currentNeutralTurnId = undefined
      state.retryHold = false
      hostState.reset()
      controlSocketPath = undefined
      receipts.reset()
      state.brokerInputByHostInput.clear()
      journal.resetSeen(driverCtx.capture?.records() ?? [])
      await refreshDescriptor()
      const active = activeDescriptor()
      if (active.events.dropped_records > 0) {
        driverCtx.emit('capture.warning', {
          kind: 'arris_journal_records_dropped',
          message: `Arris host dropped ${active.events.dropped_records} journal record(s)`,
          raw: { dropped_records: active.events.dropped_records },
        })
      }
      driverCtx.emit(
        'invocation.started',
        {
          pid: active.host_incarnation.process.pid,
          command: active.host_incarnation.process.executable,
          args: [],
          cwd: startSpec.process.cwd,
        },
        { driver: { kind: ARRIS_RESIDENT_DRIVER_KIND, rawType: 'host-descriptor' } }
      )
      hostState.begin()
      hostState.announce(driverCtx.emit, active)
      readJournal()
      driverCtx.capture?.replayPending(journal.normalize)
      poller = setInterval(() => {
        void refreshDescriptor()
          .then(readJournal)
          .catch((error) => {
            state.healthReason = error instanceof Error ? error.message : String(error)
          })
      }, pollIntervalMs)
      poller.unref?.()
      if (active.control.socket_path !== null && active.readiness.accepts_input) {
        driverCtx.emit('invocation.ready', { state: 'ready' })
      }
      return { ok: true }
    },

    async applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
      await refreshDescriptor()
      const identity = receipts.identityFor(input)
      const reconciled = await receipts.reconcileBeforeWrite(identity)
      if (reconciled !== undefined) return reconciled
      return receipts.queueResult(await activeControl().queue(identity, inputText(input)))
    },

    async applySteerNow(input: InvocationInput): Promise<void> {
      await refreshDescriptor()
      const identity = receipts.identityFor(input)
      receipts.settleSteer(
        await activeControl().steer(identity, state.currentNeutralTurnId ?? null, inputText(input))
      )
    },

    async interrupt(_req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      return {
        accepted: false,
        effect: 'unsupported',
        reason: 'Arris resident does not expose interrupt or preempt',
      }
    },
    async stop(_req: InvocationStopRequest): Promise<InvocationStopResponse> {
      cleanup()
      return { accepted: true, state: 'exited' }
    },
    async dispose(): Promise<void> {
      cleanup()
      journal.clear()
      control = undefined
      controlSocketPath = undefined
      descriptor = undefined
      ctx = undefined
      spec = undefined
    },
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

function inputText(input: InvocationInput): string {
  return input.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}
