import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  InvocationCapabilities,
  InvocationInput,
  TurnId,
} from 'spaces-harness-broker-protocol'
import {
  BrokerErrorCode,
  CONSERVATIVE_LIFECYCLE_CAPABILITIES,
} from 'spaces-harness-broker-protocol'
import { BrokerError } from '../../errors'
import { HrcptyPtyController } from '../../runtime/hrcpty'
import { TmuxPaneNotQuiescentError } from '../../runtime/tmux'
import type { ApplyInputResult, Driver, DriverContext } from '../driver'
import { hasChildHarnessProcess, withDeliveryEvidence, withSteerRequiresOwnTurn } from '../driver'
import { ANTIGRAVITY_CLI_HRCPTY_AUTHORITY } from '../evidence-authority'
import {
  type HookListenerHandle,
  buildHookSocketPath,
  listenForHookEnvelopes,
} from '../hook-callback/listener'
import { extractText } from '../tmux-shared'
import { type AntigravityHookEnvelope, WORKSPACE_MISMATCH } from './hook-bridge'
import { createAntigravityHookEvents } from './hook-events'
import { selectAntigravityInput } from './input-box'
import { ANTIGRAVITY_DRIVER_KIND, buildAntigravityLaunch } from './launch'

const DEFAULT_READY_TIMEOUT_MS = 30_000

const CAPABILITIES: InvocationCapabilities = {
  admission: { classes: ['steer', 'queue', 'exclusive', 'preempt'] },
  bracketMintingMode: 'harness-evidence',
  queue: { cancelHarnessLocal: false },
  preempt: { mode: 'quiescence' },
  steer: { landingEvidence: 'transcript' },
  interrupt: { landingEvidence: 'ack' },
  input: {
    user: true,
    steer: true,
    appendContext: false,
    localImages: false,
    fileRefs: false,
    queue: true,
  },
  turns: { concurrency: 'single', interrupt: 'process' },
  continuation: { supported: true, provider: 'google', keyKind: 'conversation' },
  events: { assistantDeltas: false, toolCalls: true, usage: true, diagnostics: true },
  control: { stop: true, dispose: true, attach: true, driverAttachExistingSurface: false },
  lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
}

export function createAntigravityHrcptyDriver(
  ipcDir: string = join(tmpdir(), 'harness-broker'),
  attachToken?: string
): Driver {
  let hooks: ReturnType<typeof createAntigravityHookEvents> | undefined
  let controller: HrcptyPtyController | undefined
  let listener: HookListenerHandle | undefined
  let delivery = Promise.resolve()
  let stopChild: Promise<void> | undefined
  let interruptRequest: { turn: TurnId; sent: Promise<void> } | undefined

  function requireController(): HrcptyPtyController {
    if (controller === undefined) {
      throw withDeliveryEvidence(
        new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Antigravity is not running'),
        'not_written'
      )
    }
    return controller
  }

  function serializeDelivery<T>(work: () => Promise<T>): Promise<T> {
    const pending = delivery.then(work)
    delivery = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  async function paste(pty: HrcptyPtyController, text: string): Promise<void> {
    if (!(await pty.waitForInputReady(selectAntigravityInput, DEFAULT_READY_TIMEOUT_MS))) {
      throw new TmuxPaneNotQuiescentError('before_paste')
    }
    await pty.sendPastedLine(text, { selectInput: selectAntigravityInput })
  }

  async function dispose(): Promise<void> {
    hooks?.close()
    hooks = undefined
    const pty = controller
    controller = undefined
    await stopChild
    pty?.close()
    await listener?.close()
    listener = undefined
  }

  function submitMissedMail(ctx: DriverContext, text: string): void {
    void serializeDelivery(async () => {
      try {
        await paste(requireController(), text)
      } catch (error) {
        if (controller === undefined) return
        ctx.emit('diagnostic', {
          level: 'error',
          source: 'driver',
          message: `Could not submit Antigravity mail after a missed Stop reply: ${String(error)}`,
        })
      }
    })
  }

  return {
    kind: ANTIGRAVITY_DRIVER_KIND,
    version: '0.1.0',
    bracketMintingMode: 'harness-evidence',
    nativeSourceKind: 'provider-jsonl',
    evidenceAuthority: ANTIGRAVITY_CLI_HRCPTY_AUTHORITY,
    preemptMode: 'quiescence',
    steerLandingEvidence: 'transcript',
    resolvesSteerAtActuation: true,
    interruptLandingEvidence: 'ack',
    capabilities: () => CAPABILITIES,

    async start(spec, ctx) {
      const lease = ctx.runtime?.terminalSurface
      if (!hasChildHarnessProcess(spec) || lease?.kind !== 'hrcpty' || lease.ownership !== 'hrc') {
        throw new BrokerError(
          BrokerErrorCode.DispatchValidationFailed,
          'antigravity-cli-hrcpty requires a child process and an HRC-owned hrcpty lease'
        )
      }
      const pty = new HrcptyPtyController({
        socketPath: lease.socketPath,
        allowedOps: lease.allowedOps,
        ...(attachToken === undefined ? {} : { token: async () => attachToken }),
      })
      controller = pty

      const startup = Promise.withResolvers<void>()
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const hello = await pty.hello()
        const runtimeId = spec.correlation?.['runtimeId']
        const callbackSocket = buildHookSocketPath(ipcDir, 'agy-hooks', {
          invocationId: ctx.invocationId,
          runtimeId,
        })
        const launch = buildAntigravityLaunch(spec, ctx, callbackSocket, hello.size)
        const driver = { kind: ANTIGRAVITY_DRIVER_KIND }
        const hookEvents = createAntigravityHookEvents({
          ctx,
          env: launch.env,
          callbackSocket,
          onReady: (provenance) => {
            ctx.emit(
              'invocation.ready',
              { state: 'ready' },
              {
                driver: { ...driver, rawType: 'StatusLine' },
                provenance,
              }
            )
            startup.resolve()
          },
          onWorkspaceMismatch: () => {
            stopChild = pty.signal('TERM').catch((error: unknown) => {
              ctx.emit('diagnostic', {
                level: 'warn',
                source: 'driver',
                message: `Could not stop Antigravity after ${WORKSPACE_MISMATCH}: ${String(error)}`,
              })
            })
            void stopChild.then(dispose)
            startup.resolve()
          },
          onMissedMail: (text) => submitMissedMail(ctx, text),
        })
        hooks = hookEvents
        listener = await listenForHookEnvelopes<AntigravityHookEnvelope>(
          callbackSocket,
          hookEvents.accept
        )
        ctx.emit(
          'invocation.started',
          {
            command: spec.process.command,
            args: spec.process.args,
            cwd: spec.process.cwd,
          },
          { driver }
        )
        ctx.emit(
          'terminal.surface.reported',
          {
            kind: 'hrcpty-socket',
            socketPath: lease.socketPath,
          },
          { driver }
        )
        await pty.spawn(launch)
        timeout = setTimeout(
          () =>
            startup.reject(
              new Error(
                'Antigravity did not report an idle status line before the startup deadline'
              )
            ),
          spec.process.limits?.startupTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
        )
        await startup.promise
        return { ok: true }
      } catch (error) {
        await dispose()
        throw error
      } finally {
        clearTimeout(timeout)
      }
    },

    applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
      return serializeDelivery(async () => {
        const pty = requireController()
        const text = extractText(input)
        const events = hooks
        const turnId = events?.prepareDelivery(text, input.inputId)
        try {
          await paste(pty, text)
        } catch (error) {
          const evidence =
            error instanceof TmuxPaneNotQuiescentError && error.phase === 'before_paste'
              ? 'not_written'
              : 'possibly_written'
          if (turnId !== undefined && evidence === 'not_written') events?.clearDelivery(turnId)
          throw withDeliveryEvidence(error, evidence)
        }
        return { turnId }
      })
    },

    async applySteerNow(input): Promise<void> {
      requireController()
      if (hooks?.activeTurn === undefined) {
        throw withSteerRequiresOwnTurn(
          withDeliveryEvidence(new Error('Antigravity has no open turn to steer'), 'not_written')
        )
      }
      return hooks.holdSteer(extractText(input), input.inputId)
    },

    async interrupt() {
      const turn = hooks?.activeTurn
      if (turn === undefined || controller === undefined) {
        return { accepted: false, effect: 'no_active_turn' }
      }
      if (turn !== interruptRequest?.turn) {
        interruptRequest = { turn, sent: controller.interrupt() }
      }
      await interruptRequest.sent
      return { accepted: true, effect: 'turn_interrupted' }
    },

    async stop() {
      // Outside the workspace guard, HRC owns the child and supervisor lease.
      await dispose()
      return { accepted: true, state: 'exited' }
    },

    dispose,
  }
}
