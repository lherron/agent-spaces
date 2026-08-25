import { type AgentSessionRuntime, runPrintMode } from '@earendil-works/pi-coding-agent'
import { type LoadAgentOptions, createAgentHarnessRuntime, loadAgent } from 'agent-harness-runtime'

import { resolveForegroundAuthStorePath } from './auth-store.js'

export interface ForegroundPrintDependencies {
  loadAgent: typeof loadAgent
  createRuntime: typeof createAgentHarnessRuntime
  runPrintMode: (
    runtime: AgentSessionRuntime,
    options: { mode: 'text'; initialMessage: string }
  ) => Promise<number>
}

const productionDependencies: ForegroundPrintDependencies = {
  loadAgent,
  createRuntime: createAgentHarnessRuntime,
  runPrintMode,
}

/** Run a one-shot Pi prompt using the direct shared runtime. */
export async function runAgentHarnessPrint(
  options: LoadAgentOptions & { prompt: string; resume?: string | boolean | undefined },
  dependencies: ForegroundPrintDependencies = productionDependencies
): Promise<number> {
  const agent = await dependencies.loadAgent(options)
  const runtime = await dependencies.createRuntime({
    agent,
    authStorePath: resolveForegroundAuthStorePath(agent.environment),
    ...(options.resume !== undefined ? { continuationKey: options.resume } : {}),
  })
  try {
    return await dependencies.runPrintMode(runtime, {
      mode: 'text',
      initialMessage: options.prompt,
    })
  } finally {
    await runtime.dispose()
  }
}
