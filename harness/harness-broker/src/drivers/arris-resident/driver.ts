import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type {
  ArrisControlReceipt,
  ArrisHostDescriptor,
  ArrisInputIdentity,
  ArrisJournalRecord,
  HarnessInvocationSpec,
  InputId,
  InvocationCapabilities,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  MessageId,
  ToolCallId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import {
  BrokerErrorCode,
  CONSERVATIVE_LIFECYCLE_CAPABILITIES,
  validateArrisHostDescriptor,
} from 'spaces-harness-broker-protocol'
import type { CapturedRecord, NormalizeOutcome } from '../../capture/capture-gate'
import { BrokerError } from '../../errors'
import type { ApplyInputResult, Driver, DriverContext, DriverStartResult } from '../driver'
import { withDeliveryEvidence } from '../driver'
import { ARRIS_RESIDENT_AUTHORITY } from '../evidence-authority'
import { createJsonlByteOffsetTailer } from '../jsonl-byte-tailer'
import { type ArrisControlClient, createArrisControlClient } from './control-client'

export const ARRIS_RESIDENT_DRIVER_KIND = 'arris-resident'
const ARRIS_RESIDENT_DRIVER_VERSION = '0.1.0'

export interface ArrisResidentDriverSpec {
  kind: typeof ARRIS_RESIDENT_DRIVER_KIND
  descriptorPath: string
  hostIncarnationId: string
  hostLifecycleOwner?: 'external' | 'hrc-managed' | undefined
  launchId?: string | null | undefined
}

export interface ArrisResidentDriverOptions {
  pollIntervalMs?: number | undefined
  readDescriptor?: ((path: string) => Promise<unknown>) | undefined
  createControlClient?: ((socketPath: string) => ArrisControlClient) | undefined
}

export class ArrisNotWrittenError extends BrokerError {
  readonly receipt: ArrisControlReceipt

  constructor(receipt: ArrisControlReceipt) {
    const outcome = receipt.outcome
    super(
      BrokerErrorCode.HarnessError,
      outcome.outcome === 'not_written' ? outcome.message : 'Arris input was not written',
      { receipt }
    )
    this.name = 'ArrisNotWrittenError'
    this.receipt = receipt
    withDeliveryEvidence(this, 'not_written')
  }
}

export class ArrisRetryableNotWrittenError extends ArrisNotWrittenError {
  readonly retryableNotWritten = true

  constructor(receipt: ArrisControlReceipt) {
    super(receipt)
    this.name = 'ArrisRetryableNotWrittenError'
  }
}

export class ArrisIndeterminateDeliveryError extends BrokerError {
  readonly receipt: ArrisControlReceipt

  constructor(receipt: ArrisControlReceipt) {
    const outcome = receipt.outcome
    super(
      BrokerErrorCode.HarnessError,
      outcome.outcome === 'indeterminate' ? outcome.message : 'Arris delivery is indeterminate',
      { receipt }
    )
    this.name = 'ArrisIndeterminateDeliveryError'
    this.receipt = receipt
    withDeliveryEvidence(this, 'possibly_written')
  }
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
  continuation: { supported: true, provider: 'arris', keyKind: 'host-incarnation' },
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

const KNOWN_IGNORED_EVENTS = new Set([
  'event_journal_opened',
  'control_ledger_opened',
  'control_channel_bound',
  'priming_turn_seeded',
  'host_turn_admitted',
  'resumable_confirmed',
  'control_request',
  'control_input_admitted',
  'control_input_reopened',
  'control_input_converged',
  'control_outcome',
  'control_input_turn_completed',
  'child_turn_completed_ignored',
])

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
  let healthReason: string | undefined
  let currentNeutralTurnId: string | undefined
  let retryHold = false
  const nextAttempts = new Map<string, number>()
  const receiptByInput = new Map<string, ArrisControlReceipt>()
  const brokerInputByHostInput = new Map<string, InputId>()
  const inputByNeutralTurn = new Map<string, InputId>()
  const neutralByCodexTurn = new Map<string, string>()
  const assistantText = new Map<string, string>()
  const assistantStarted = new Set<string>()
  const seenSequences = new Set<number>()
  const tailer = createJsonlByteOffsetTailer()

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

  function identityFor(input: InvocationInput): ArrisInputIdentity {
    if (input.inputId === undefined) {
      throw withDeliveryEvidence(
        new BrokerError(
          BrokerErrorCode.DispatchValidationFailed,
          'Arris input requires a broker input id'
        ),
        'not_written'
      )
    }
    const brokerInputId = input.inputId
    const inputId = input.metadata?.['envelopeId'] ?? brokerInputId
    brokerInputByHostInput.set(inputId, brokerInputId)
    return {
      platform: 'hrc',
      input_id: inputId,
      envelope_id: input.metadata?.['envelopeId'] ?? inputId,
      attempt: nextAttempts.get(inputId) ?? 1,
    }
  }

  function rememberReceipt(receipt: ArrisControlReceipt): void {
    assertReceiptTarget(receipt)
    receiptByInput.set(receipt.identity.input_id, receipt)
    const maximumAttempt = receipt.attempts_seen.reduce(
      (maximum, value) => Math.max(maximum, value),
      0
    )
    nextAttempts.set(receipt.identity.input_id, maximumAttempt + 1)
    if (receipt.outcome.outcome === 'written') {
      currentNeutralTurnId = receipt.outcome.neutral_turn_id
      const brokerInputId = brokerInputByHostInput.get(receipt.identity.input_id)
      if (brokerInputId !== undefined) {
        inputByNeutralTurn.set(receipt.outcome.neutral_turn_id, brokerInputId)
      }
      if (receipt.outcome.codex_turn_id !== null) {
        neutralByCodexTurn.set(receipt.outcome.codex_turn_id, receipt.outcome.neutral_turn_id)
      }
    }
    const brokerInputId = brokerInputByHostInput.get(receipt.identity.input_id)
    requireCtx().emit(
      'driver.notice',
      {
        code: 'ARRIS_CONTROL_RECEIPT',
        message: `Arris ${receipt.kind} receipt ${receipt.outcome.outcome}`,
        data: receipt,
      },
      {
        ...(brokerInputId !== undefined ? { inputId: brokerInputId } : {}),
        driver: { kind: ARRIS_RESIDENT_DRIVER_KIND, rawType: 'control.receipt' },
      }
    )
  }

  function assertReceiptTarget(receipt: ArrisControlReceipt): void {
    const expected = activeDescriptor().host_incarnation.host_incarnation_id
    if (receipt.host_incarnation_id !== expected) {
      throw new BrokerError(
        BrokerErrorCode.IdentityInstallConflict,
        `Arris receipt belongs to foreign host ${receipt.host_incarnation_id}`,
        { expectedHostIncarnationId: expected, receipt }
      )
    }
  }

  function receiptResult(receipt: ArrisControlReceipt): ApplyInputResult {
    rememberReceipt(receipt)
    if (receipt.outcome.outcome === 'not_written') {
      if (receipt.outcome.eligible_for_retry) {
        retryHold = true
        throw new ArrisRetryableNotWrittenError(receipt)
      }
      throw new ArrisNotWrittenError(receipt)
    }
    if (receipt.outcome.outcome === 'written' && receipt.presentation !== null) {
      return { turnId: receipt.outcome.neutral_turn_id as TurnId }
    }
    // in_flight, indeterminate and written-before-presentation all keep the
    // broker's pending-own-turn fence. Journal evidence settles the attempt.
    return {}
  }

  async function reconcileBeforeWrite(
    identity: ArrisInputIdentity
  ): Promise<ApplyInputResult | undefined> {
    const prior = receiptByInput.get(identity.input_id)
    if (
      prior === undefined ||
      (prior.outcome.outcome === 'not_written' && prior.outcome.eligible_for_retry)
    ) {
      return undefined
    }
    const reconciled = await activeControl().lookup(prior.identity)
    if (reconciled === null) {
      if (prior.outcome.outcome === 'indeterminate' || prior.outcome.outcome === 'in_flight') {
        rememberReceipt(prior)
        return {}
      }
      throw new BrokerError(
        BrokerErrorCode.HarnessError,
        `Arris lost the durable receipt for ${identity.input_id}`,
        { receipt: prior }
      )
    }
    if (reconciled.outcome.outcome === 'not_written' && reconciled.outcome.eligible_for_retry) {
      rememberReceipt(reconciled)
      return undefined
    }
    return receiptResult(reconciled)
  }

  async function reconcileUnresolved(): Promise<void> {
    if (control === undefined) return
    for (const receipt of await control.unresolved()) rememberReceipt(receipt)
  }

  // EXCEPTION(T-08503): one auditable switch keeps the closed Arris journal vocabulary and its stateful correlations together.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: event vocabulary mapper
  function normalizeRecord(captured: CapturedRecord): NormalizeOutcome {
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(captured.record.rawBytes).toString('utf8'))
    } catch {
      return {
        disposition: 'blocked-unknown',
        family: 'diagnostic',
        message: 'Invalid Arris journal JSON',
      }
    }
    if (!isJournalRecord(parsed)) {
      return {
        disposition: 'blocked-unknown',
        family: 'diagnostic',
        message: 'Invalid Arris journal record',
      }
    }
    const record = parsed
    const expected = activeDescriptor().host_incarnation.host_incarnation_id
    if (record.host_incarnation_id !== expected) {
      healthReason = `foreign Arris journal incarnation ${record.host_incarnation_id}`
      return { disposition: 'blocked-unknown', family: 'diagnostic', message: healthReason }
    }
    if (seenSequences.has(record.sequence)) return { disposition: 'duplicate', detail: record.kind }
    seenSequences.add(record.sequence)
    const extra = {
      driver: { kind: ARRIS_RESIDENT_DRIVER_KIND, rawType: record.kind },
      sourceTime: new Date(record.at_ms).toISOString(),
      provenance: captured.provenance(),
    }
    const detail = record.detail
    if (record.kind === 'host_readiness_changed') {
      const to = asRecord(detail['to'])
      if (to?.['accepts_input'] === true) {
        retryHold = false
        requireCtx().admissionStateChanged?.()
      }
      return { disposition: 'state-only', detail: record.kind }
    }
    if (record.kind === 'turn_started') {
      const neutral = stringValue(detail['neutral_turn_id'])
      const codex = stringValue(detail['codex_turn_id'])
      if (neutral === undefined)
        return {
          disposition: 'blocked-unknown',
          family: 'turn-bracket',
          message: 'Arris turn_started lacks neutral_turn_id',
        }
      currentNeutralTurnId = neutral
      if (codex !== undefined) neutralByCodexTurn.set(codex, neutral)
      const inputId = inputByNeutralTurn.get(neutral)
      requireCtx().emit(
        'turn.started',
        {
          turnId: neutral as TurnId,
          source: 'observed',
          sessionId: activeDescriptor().resident_binding.thread_id,
          ...(inputId !== undefined ? { inputId } : {}),
        },
        { ...extra, turnId: neutral as TurnId, ...(inputId !== undefined ? { inputId } : {}) }
      )
      const origin = stringValue(detail['origin'])
      requireCtx().emit(
        'turn.attributed',
        {
          turnId: neutral as TurnId,
          ownership: inputId !== undefined || origin === 'control' ? 'own' : 'foreign',
          origin:
            inputId !== undefined || origin === 'control'
              ? 'broker'
              : origin === 'attached_client'
                ? 'human'
                : 'autonomous',
          ...(inputId !== undefined ? { inputId } : {}),
        },
        { ...extra, turnId: neutral as TurnId, ...(inputId !== undefined ? { inputId } : {}) }
      )
      return { disposition: 'normalized', detail: record.kind }
    }
    if (record.kind === 'control_input_presented') {
      const hostInputId = stringValue(detail['input_id'])
      const inputId =
        hostInputId === undefined ? undefined : brokerInputByHostInput.get(hostInputId)
      const codex = stringValue(detail['codex_turn_id'])
      const neutral =
        (codex === undefined ? undefined : neutralByCodexTurn.get(codex)) ?? currentNeutralTurnId
      if (inputId === undefined || neutral === undefined)
        return { disposition: 'state-only', detail: 'presentation-awaiting-turn-correlation' }
      inputByNeutralTurn.set(neutral, inputId)
      requireCtx().emit(
        'turn.attributed',
        {
          turnId: neutral as TurnId,
          ownership: 'own',
          origin: 'broker',
          inputId,
        },
        { ...extra, turnId: neutral as TurnId, inputId }
      )
      return { disposition: 'normalized', detail: record.kind }
    }
    if (record.kind === 'assistant_text_delta') {
      const codex = stringValue(detail['codex_turn_id'])
      const neutral =
        (codex === undefined ? undefined : neutralByCodexTurn.get(codex)) ?? currentNeutralTurnId
      const delta = stringValue(detail['delta'])
      if (neutral === undefined || delta === undefined)
        return { disposition: 'state-only', detail: record.kind }
      const messageId = `arris-assistant:${neutral}` as MessageId
      if (!assistantStarted.has(neutral)) {
        assistantStarted.add(neutral)
        requireCtx().emit(
          'assistant.message.started',
          { messageId },
          { ...extra, turnId: neutral as TurnId, itemId: messageId }
        )
      }
      assistantText.set(neutral, `${assistantText.get(neutral) ?? ''}${delta}`)
      requireCtx().emit(
        'assistant.message.delta',
        { messageId, text: delta },
        { ...extra, turnId: neutral as TurnId, itemId: messageId }
      )
      return { disposition: 'normalized', detail: record.kind }
    }
    if (record.kind === 'turn_completed') {
      const neutral = stringValue(detail['neutral_turn_id']) ?? currentNeutralTurnId
      if (neutral === undefined)
        return {
          disposition: 'blocked-unknown',
          family: 'turn-bracket',
          message: 'Arris turn_completed lacks neutral turn correlation',
        }
      const text = assistantText.get(neutral) ?? ''
      if (assistantStarted.has(neutral)) {
        const messageId = `arris-assistant:${neutral}` as MessageId
        requireCtx().emit(
          'assistant.message.completed',
          {
            messageId,
            content: [{ type: 'text', text }],
            final: true,
          },
          { ...extra, turnId: neutral as TurnId, itemId: messageId }
        )
      }
      const status = stringValue(detail['status'])?.toLowerCase()
      requireCtx().emit(
        'turn.completed',
        {
          turnId: neutral as TurnId,
          status:
            status === 'failed' ? 'failed' : status === 'interrupted' ? 'interrupted' : 'completed',
          ...(text.length > 0 ? { finalOutput: text } : {}),
          producedContent: text.length > 0,
        },
        { ...extra, turnId: neutral as TurnId }
      )
      if (currentNeutralTurnId === neutral) currentNeutralTurnId = undefined
      retryHold = false
      requireCtx().admissionStateChanged?.()
      return { disposition: 'normalized', detail: record.kind }
    }
    if (record.kind === 'event_gap') {
      healthReason = 'Arris runtime event stream reported a gap'
      requireCtx().emit(
        'capture.warning',
        {
          message: healthReason,
          kind: 'arris_event_gap',
          raw: detail,
        },
        extra
      )
      return { disposition: 'normalized', detail: record.kind }
    }
    if (record.kind === 'item_observed') {
      requireCtx().emit(
        'driver.notice',
        {
          code: 'ARRIS_ITEM_OBSERVED',
          message: `Arris observed ${stringValue(detail['item_type']) ?? 'native item'}`,
          data: detail,
        },
        {
          ...extra,
          ...(currentNeutralTurnId !== undefined ? { turnId: currentNeutralTurnId as TurnId } : {}),
        }
      )
      return { disposition: 'normalized', detail: record.kind }
    }
    if (record.kind === 'dynamic_tool_call_answered') {
      const toolCallId = (stringValue(detail['action_id']) ??
        `arris-action:${record.sequence}`) as ToolCallId
      const name = stringValue(detail['tool']) ?? 'dynamic_tool'
      const turnExtra = {
        ...extra,
        ...(currentNeutralTurnId !== undefined ? { turnId: currentNeutralTurnId as TurnId } : {}),
        itemId: toolCallId,
      }
      requireCtx().emit('tool.call.started', { toolCallId, name, input: detail }, turnExtra)
      requireCtx().emit(
        'tool.call.completed',
        {
          toolCallId,
          name,
          result: detail,
          isError: detail['success'] !== true,
        },
        turnExtra
      )
      return { disposition: 'normalized', detail: record.kind }
    }
    if (
      record.kind === 'native_approval_offered' ||
      record.kind === 'helper_observed' ||
      record.kind === 'resident_rebound' ||
      record.kind === 'control_submission_fenced' ||
      record.kind === 'uncertain_bound_to_turn' ||
      record.kind === 'uncertain_resolved'
    ) {
      requireCtx().emit(
        'driver.notice',
        {
          code: `ARRIS_${record.kind.toUpperCase()}`,
          message: `Arris ${record.kind.replaceAll('_', ' ')}`,
          data: detail,
        },
        extra
      )
      return { disposition: 'normalized', detail: record.kind }
    }
    if (KNOWN_IGNORED_EVENTS.has(record.kind))
      return { disposition: 'ignored-known', detail: record.kind }
    return {
      disposition: 'blocked-unknown',
      family: 'diagnostic',
      message: `Unknown Arris journal kind ${record.kind}`,
    }
  }

  function readJournal(): void {
    if (stopped || descriptor === undefined) return
    const active = descriptor
    tailer.readNewLines((line) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        parsed = undefined
      }
      const sequence = isJournalRecord(parsed) ? parsed.sequence : -1
      if (sequence >= 0 && seenSequences.has(sequence)) return
      requireCtx().capture?.ingest(
        {
          provider: 'openai',
          driverKind: ARRIS_RESIDENT_DRIVER_KIND,
          sourceKind: 'provider-jsonl',
          sourceKey: `arris:${active.host_incarnation.host_incarnation_id}`,
          sourceCursor: sequence >= 0 ? { nativeSequence: String(sequence) } : {},
          nativeType: isJournalRecord(parsed) ? parsed.kind : 'unparseable',
          rawBytes: Buffer.from(line, 'utf8'),
          correlationHints: { hostIncarnationId: active.host_incarnation.host_incarnation_id },
        },
        normalizeRecord
      )
    })
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
    if (parsed.value.events.dropped_records > 0)
      healthReason = `Arris host dropped ${parsed.value.events.dropped_records} event record(s)`
    const socketPath = parsed.value.control.socket_path
    if (socketPath === null) {
      control = undefined
      controlSocketPath = undefined
    } else if (socketPath !== controlSocketPath) {
      control = openControl(socketPath)
      controlSocketPath = socketPath
      await reconcileUnresolved()
    }
    tailer.retarget(parsed.value.events.path)
  }

  function cleanup(): void {
    stopped = true
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
    captureNormalizer: () => normalizeRecord,
    runtimeHealth: () =>
      healthReason === undefined
        ? { state: 'healthy' }
        : { state: 'degraded', reason: healthReason },
    probeAdmissionState: () => ({ harnessLocalQueueDepth: retryHold ? 1 : 0 }),

    async start(
      startSpec: HarnessInvocationSpec,
      driverCtx: DriverContext
    ): Promise<DriverStartResult> {
      cleanup()
      const parsedSpec = parseSpec(startSpec)
      ctx = driverCtx
      spec = parsedSpec
      stopped = false
      healthReason = undefined
      currentNeutralTurnId = undefined
      retryHold = false
      controlSocketPath = undefined
      receiptByInput.clear()
      brokerInputByHostInput.clear()
      nextAttempts.clear()
      seenSequences.clear()
      for (const record of driverCtx.capture?.records() ?? []) {
        if (record.driverKind !== ARRIS_RESIDENT_DRIVER_KIND) continue
        const sequence = record.sourceCursor.nativeSequence
        if (typeof sequence === 'string' && /^\d+$/.test(sequence)) {
          seenSequences.add(Number(sequence))
        }
      }
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
      driverCtx.emit('continuation.updated', {
        provider: 'arris',
        kind: 'host-incarnation',
        key: active.host_incarnation.host_incarnation_id,
      })
      readJournal()
      driverCtx.capture?.replayPending(normalizeRecord)
      poller = setInterval(() => {
        void refreshDescriptor()
          .then(readJournal)
          .catch((error) => {
            healthReason = error instanceof Error ? error.message : String(error)
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
      const identity = identityFor(input)
      const reconciled = await reconcileBeforeWrite(identity)
      if (reconciled !== undefined) return reconciled
      return receiptResult(await activeControl().queue(identity, inputText(input)))
    },

    async applySteerNow(input: InvocationInput): Promise<void> {
      await refreshDescriptor()
      const identity = identityFor(input)
      const receipt = await activeControl().steer(
        identity,
        currentNeutralTurnId ?? null,
        inputText(input)
      )
      rememberReceipt(receipt)
      if (receipt.outcome.outcome === 'not_written') {
        if (receipt.outcome.eligible_for_retry) {
          retryHold = true
          throw new ArrisRetryableNotWrittenError(receipt)
        }
        throw new ArrisNotWrittenError(receipt)
      }
      if (receipt.outcome.outcome === 'indeterminate' || receipt.outcome.outcome === 'in_flight') {
        throw new ArrisIndeterminateDeliveryError(receipt)
      }
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
      tailer.clear()
      control = undefined
      controlSocketPath = undefined
      descriptor = undefined
      ctx = undefined
      spec = undefined
    },
  }
}

function parseSpec(startSpec: HarnessInvocationSpec): ArrisResidentDriverSpec {
  if (startSpec.driver.kind !== ARRIS_RESIDENT_DRIVER_KIND)
    throw new BrokerError(BrokerErrorCode.DriverUnavailable, 'Invalid Arris resident driver spec')
  const value = startSpec.driver as Record<string, unknown>
  if (typeof value['descriptorPath'] !== 'string' || !isAbsolute(value['descriptorPath'])) {
    throw new BrokerError(
      BrokerErrorCode.DispatchValidationFailed,
      'arris-resident descriptorPath must be absolute'
    )
  }
  if (typeof value['hostIncarnationId'] !== 'string' || value['hostIncarnationId'].length === 0) {
    throw new BrokerError(
      BrokerErrorCode.DispatchValidationFailed,
      'arris-resident hostIncarnationId is required'
    )
  }
  if (
    value['hostLifecycleOwner'] !== undefined &&
    value['hostLifecycleOwner'] !== 'external' &&
    value['hostLifecycleOwner'] !== 'hrc-managed'
  ) {
    throw new BrokerError(
      BrokerErrorCode.DispatchValidationFailed,
      'arris-resident hostLifecycleOwner is invalid'
    )
  }
  if (
    value['launchId'] !== undefined &&
    value['launchId'] !== null &&
    typeof value['launchId'] !== 'string'
  ) {
    throw new BrokerError(
      BrokerErrorCode.DispatchValidationFailed,
      'arris-resident launchId must be a string or null'
    )
  }
  return value as unknown as ArrisResidentDriverSpec
}

function assertDescriptorMatchesSpec(
  spec: ArrisResidentDriverSpec,
  descriptor: ArrisHostDescriptor
): void {
  const actual = descriptor.host_incarnation.host_incarnation_id
  if (actual !== spec.hostIncarnationId) {
    throw new BrokerError(
      BrokerErrorCode.IdentityInstallConflict,
      `Arris descriptor belongs to foreign host ${actual}`,
      { expectedHostIncarnationId: spec.hostIncarnationId }
    )
  }
  if (
    spec.hostLifecycleOwner !== undefined &&
    descriptor.lifecycle.host_lifecycle_owner !== spec.hostLifecycleOwner
  ) {
    throw new BrokerError(
      BrokerErrorCode.IdentityInstallConflict,
      'Arris host lifecycle owner does not match prepared binding'
    )
  }
  if (spec.launchId !== undefined && descriptor.lifecycle.launch_id !== spec.launchId) {
    throw new BrokerError(
      BrokerErrorCode.IdentityInstallConflict,
      'Arris host launch id does not match prepared binding'
    )
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isJournalRecord(value: unknown): value is ArrisJournalRecord {
  const row = asRecord(value)
  return (
    row !== undefined &&
    typeof row['host_incarnation_id'] === 'string' &&
    Number.isInteger(row['sequence']) &&
    typeof row['at_ms'] === 'number' &&
    typeof row['kind'] === 'string' &&
    asRecord(row['detail']) !== undefined
  )
}
