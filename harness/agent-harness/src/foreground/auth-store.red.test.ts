import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionRuntime } from '@earendil-works/pi-coding-agent'
import type { ResolvedAgent } from 'agent-harness-runtime'

import { runAgentHarnessPrint } from './print'
import { runAgentHarnessTui } from './tui'

type RuntimeOptions = Parameters<
  NonNullable<Parameters<typeof runAgentHarnessTui>[1]>['createRuntime']
>[0]

/**
 * T-07552 foreground OAuth acceptance seam.
 *
 * Foreground launch owns only selection of Pi's user auth store. The shared runtime
 * must still receive an explicit path, and broker dispatch must keep supplying its
 * separately authenticated store (covered in invocation-session-factory.test.ts).
 */
describe('foreground Pi OAuth auth-store resolution', () => {
  test.each([
    {
      mode: 'tui' as const,
      environment: {},
      expected: join(homedir(), '.pi', 'agent', 'auth.json'),
    },
    {
      mode: 'print' as const,
      environment: { PI_CODING_AGENT_DIR: '/var/tmp/pi-user-agent' },
      expected: '/var/tmp/pi-user-agent/auth.json',
    },
  ])(
    '$mode uses Pi standard per-user auth store $expected',
    async ({ mode, environment, expected }) => {
      const observed = await runForeground(mode, environment)

      expect(observed).toMatchObject({ authStorePath: expected })
    }
  )

  test.each(['tui', 'print'] as const)(
    '%s gives explicit HARNESS_PI_AUTH_STORE precedence over the Pi user directory',
    async (mode) => {
      const observed = await runForeground(mode, {
        HARNESS_PI_AUTH_STORE: '/credentials/foreground-auth.json',
        PI_CODING_AGENT_DIR: '/var/tmp/pi-user-agent',
      })

      expect(observed).toMatchObject({
        authStorePath: '/credentials/foreground-auth.json',
      })
    }
  )
})

async function runForeground(
  mode: 'tui' | 'print',
  environment: NodeJS.ProcessEnv
): Promise<RuntimeOptions> {
  let runtimeOptions: RuntimeOptions | undefined
  const agent = { environment } as ResolvedAgent
  const runtime = {
    async dispose() {},
  } as unknown as AgentSessionRuntime
  const sharedDependencies = {
    async loadAgent() {
      return agent
    },
    async createRuntime(options: RuntimeOptions) {
      runtimeOptions = options
      return runtime
    },
  }

  if (mode === 'tui') {
    await runAgentHarnessTui(
      { agentId: 'smokey' },
      {
        ...sharedDependencies,
        async runInteractiveMode() {},
      }
    )
  } else {
    await runAgentHarnessPrint(
      { agentId: 'smokey', prompt: 'foreground auth check' },
      {
        ...sharedDependencies,
        async runPrintMode() {
          return 0
        },
      }
    )
  }

  if (runtimeOptions === undefined) throw new Error('foreground did not create a runtime')
  return runtimeOptions
}
