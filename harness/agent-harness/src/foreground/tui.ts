import { type AgentSessionRuntime, InteractiveMode } from '@earendil-works/pi-coding-agent'
import {
  type LoadAgentOptions,
  RESOURCE_LOADER_THEME_NAME,
  createAgentHarnessRuntime,
  loadAgent,
} from 'agent-harness-runtime'

import { resolveForegroundAuthStorePath } from './auth-store.js'
import { createAgentScopeStatusExtension } from './scope-status.js'

export interface ForegroundTuiDependencies {
  loadAgent: typeof loadAgent
  createRuntime: typeof createAgentHarnessRuntime
  runInteractiveMode: (runtime: AgentSessionRuntime, initialMessage?: string) => Promise<void>
}

/** Keep Pi's regular-mode footer anchored after transient status rows disappear. */
export function applyAgentHarnessTuiEnvironment(environment: NodeJS.ProcessEnv): void {
  environment['PI_CLEAR_ON_SHRINK'] ??= '1'
}

const productionDependencies: ForegroundTuiDependencies = {
  loadAgent,
  createRuntime: createAgentHarnessRuntime,
  async runInteractiveMode(runtime, initialMessage) {
    applyAgentHarnessTuiEnvironment(process.env)
    await new InteractiveMode(runtime, {
      ...(initialMessage !== undefined ? { initialMessage } : {}),
      initialThemeSetting: RESOURCE_LOADER_THEME_NAME,
    }).run()
  },
}

/** Run the separate, direct local Pi TUI surface. It is never a broker child. */
export async function runAgentHarnessTui(
  options: LoadAgentOptions & {
    prompt?: string | undefined
    resume?: string | boolean | undefined
  },
  dependencies: ForegroundTuiDependencies = productionDependencies
): Promise<void> {
  const agent = await dependencies.loadAgent(options)
  const runtime = await dependencies.createRuntime({
    agent,
    authStorePath: resolveForegroundAuthStorePath(agent.environment),
    ...(options.resume !== undefined ? { continuationKey: options.resume } : {}),
    extensionFactories: [createAgentScopeStatusExtension(agent)],
  })
  try {
    await dependencies.runInteractiveMode(runtime, options.prompt)
  } finally {
    await runtime.dispose()
  }
}
