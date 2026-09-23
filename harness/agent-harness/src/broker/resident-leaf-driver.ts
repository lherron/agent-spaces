import { InteractiveMode } from '@earendil-works/pi-coding-agent'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { RESOURCE_LOADER_THEME_NAME } from 'agent-harness-runtime'
import type { Driver } from 'spaces-harness-broker'
import {
  type PiSdkSession,
  type PiSdkSessionFactoryInput,
  createPiSdkDriver,
} from 'spaces-harness-broker-pi-sdk'

import { applyAgentHarnessTuiEnvironment } from '../foreground/tui.js'
import {
  type ResidentDetachControl,
  type ResidentDetachReason,
  createResidentDetachControl,
} from '../resident-detach.js'
import {
  type ResolvedAgentSessionContribution,
  createResolvedAgentSession,
  resolvedAgentSessionRuntime,
} from './invocation-session-factory.js'

/** Pane-owning native-worker kinds this builder may serve. Headless agent-harness has no pane. */
const RESIDENT_LEAF_DRIVER_KINDS: ReadonlySet<string> = new Set([
  'agent-harness-tmux',
  'foundry-resident',
])
const USER_EXIT_REASON = 'prompt_input_exit'

export interface ResidentLeafDriverOptions {
  driverKind: string
  /** Caller additions to the resolved session; mandatory broker inputs are always kept. */
  session?:
    | ((
        input: PiSdkSessionFactoryInput
      ) => ResolvedAgentSessionContribution | Promise<ResolvedAgentSessionContribution>)
    | undefined
  /** Detach instead of exiting on /quit, Ctrl-D and double Ctrl-C. Omit to exit on quit. */
  onDetachRequest?: ((reason: ResidentDetachReason) => void | Promise<void>) | undefined
  doubleCtrlCWindowMs?: number | undefined
}

/**
 * Child-side resident driver. It owns Pi and the TUI on its pane, but speaks
 * only the standard harness-broker protocol supplied by the broker server
 * around it.
 */
export function createResidentLeafDriver(options: ResidentLeafDriverOptions): Driver {
  const { driverKind } = options
  if (!RESIDENT_LEAF_DRIVER_KINDS.has(driverKind)) {
    throw new Error(`createResidentLeafDriver does not serve driver kind '${driverKind}'`)
  }
  const modes = new WeakMap<PiSdkSession, InteractiveMode>()
  let detach: ResidentDetachControl | undefined

  return createPiSdkDriver({
    driverKind,
    requiredHarnessTransport: 'native-worker',
    createSession: async (input) =>
      createResolvedAgentSession(input, undefined, await options.session?.(input)),
    observeOperatorTurns: true,
    additionalExtensionFactories: ({ ctx }): ExtensionFactory[] => {
      if (options.onDetachRequest !== undefined) {
        detach = createResidentDetachControl({
          onDetachRequest: options.onDetachRequest,
          doubleCtrlCWindowMs: options.doubleCtrlCWindowMs,
        })
        return [detach.extensionFactory]
      }
      return [
        (pi) => {
          let announced = false
          pi.on('session_shutdown', async (event) => {
            if (event.reason !== 'quit' || announced) return
            announced = true
            ctx.emit(
              'continuation.cleared',
              { reason: USER_EXIT_REASON },
              { driver: { kind: driverKind, rawType: 'tui.user_exit' } }
            )
            // Pi exits the child after awaited shutdown hooks. Yielding lets the
            // standard broker socket write reach the kernel before process.exit.
            await new Promise<void>((resolve) => setImmediate(resolve))
          })
        },
      ]
    },
    async onSessionStarted(session, { spec, ctx }) {
      const runtime = resolvedAgentSessionRuntime(session)
      if (runtime === undefined) throw new Error('agent-harness TUI session has no runtime')
      applyAgentHarnessTuiEnvironment(process.env)
      const mode = new InteractiveMode(runtime, {
        initialThemeSetting: RESOURCE_LOADER_THEME_NAME,
      })
      modes.set(session, mode)
      await mode.init()
      detach?.assertReady()
      const sessionFile = session.sessionFile
      const provider = spec.sdk?.provider
      if (sessionFile !== undefined && provider !== undefined) {
        ctx.emit(
          'continuation.updated',
          { provider, key: sessionFile, kind: 'session' },
          { driver: { kind: driverKind, rawType: 'tui.ready' } }
        )
      }
      void mode.run()
    },
    async beforeSessionDispose(session) {
      modes.get(session)?.stop()
      modes.delete(session)
    },
  })
}
