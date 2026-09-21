import { InteractiveMode } from '@earendil-works/pi-coding-agent'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { RESOURCE_LOADER_THEME_NAME } from 'agent-harness-runtime'
import { type PiSdkSession, createPiSdkDriver } from 'spaces-harness-broker-pi-sdk'

import { applyAgentHarnessTuiEnvironment } from '../foreground/tui.js'
import {
  createResolvedAgentSession,
  resolvedAgentSessionRuntime,
} from './invocation-session-factory.js'

export const AGENT_HARNESS_TMUX_DRIVER_KIND = 'agent-harness-tmux'
const USER_EXIT_REASON = 'prompt_input_exit'

/**
 * Child-side driver. It owns Pi and the TUI, but speaks only the standard
 * harness-broker protocol supplied by the broker server around it.
 */
export function createAgentHarnessTmuxLeafDriver() {
  const modes = new WeakMap<PiSdkSession, InteractiveMode>()
  return createPiSdkDriver({
    driverKind: AGENT_HARNESS_TMUX_DRIVER_KIND,
    requiredHarnessTransport: 'native-worker',
    createSession: createResolvedAgentSession,
    observeOperatorTurns: true,
    additionalExtensionFactories: ({ ctx }): ExtensionFactory[] => [
      (pi) => {
        let announced = false
        pi.on('session_shutdown', async (event) => {
          if (event.reason !== 'quit' || announced) return
          announced = true
          ctx.emit(
            'continuation.cleared',
            { reason: USER_EXIT_REASON },
            {
              driver: {
                kind: AGENT_HARNESS_TMUX_DRIVER_KIND,
                rawType: 'tui.user_exit',
              },
            }
          )
          // Pi exits the child after awaited shutdown hooks. Yielding lets the
          // standard broker socket write reach the kernel before process.exit.
          await new Promise<void>((resolve) => setImmediate(resolve))
        })
      },
    ],
    async onSessionStarted(session, { spec, ctx }) {
      const runtime = resolvedAgentSessionRuntime(session)
      if (runtime === undefined) throw new Error('agent-harness TUI session has no runtime')
      applyAgentHarnessTuiEnvironment(process.env)
      const mode = new InteractiveMode(runtime, {
        initialThemeSetting: RESOURCE_LOADER_THEME_NAME,
      })
      modes.set(session, mode)
      await mode.init()
      const sessionFile = session.sessionFile
      const provider = spec.sdk?.provider
      if (sessionFile !== undefined && provider !== undefined) {
        ctx.emit(
          'continuation.updated',
          { provider, key: sessionFile, kind: 'session' },
          { driver: { kind: AGENT_HARNESS_TMUX_DRIVER_KIND, rawType: 'tui.ready' } }
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
