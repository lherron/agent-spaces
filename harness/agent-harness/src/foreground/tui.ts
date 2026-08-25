import { type AgentSessionRuntime, InteractiveMode } from '@earendil-works/pi-coding-agent'
import {
  type LoadAgentOptions,
  RESOURCE_LOADER_THEME_NAME,
  createAgentHarnessRuntime,
  loadAgent,
} from 'agent-harness-runtime'

export interface ForegroundTuiDependencies {
  loadAgent: typeof loadAgent
  createRuntime: typeof createAgentHarnessRuntime
  runInteractiveMode: (runtime: AgentSessionRuntime, initialMessage?: string) => Promise<void>
}

const productionDependencies: ForegroundTuiDependencies = {
  loadAgent,
  createRuntime: createAgentHarnessRuntime,
  async runInteractiveMode(runtime, initialMessage) {
    await new InteractiveMode(runtime, {
      ...(initialMessage !== undefined ? { initialMessage } : {}),
      initialThemeSetting: RESOURCE_LOADER_THEME_NAME,
    }).run()
  },
}

/** Run a local Pi TUI using the same shared runtime as the broker facade. */
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
    ...(options.resume !== undefined ? { continuationKey: options.resume } : {}),
  })
  try {
    await dependencies.runInteractiveMode(runtime, options.prompt)
  } finally {
    await runtime.dispose()
  }
}
