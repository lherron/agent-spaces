import { createAgentSpacesClient } from 'agent-spaces'
import type { AspcCompiler } from 'spaces-aspc'
import {
  detectAgentLocalComponents,
  harnessRegistry,
  planPlacementRuntime,
  prepareAgentToolRuntime,
  prepareCodexRuntimeHome,
} from 'spaces-execution'

export const runtimeDependencies = {
  getHarnessAdapter: (harnessId: Parameters<typeof harnessRegistry.getOrThrow>[0]) =>
    harnessRegistry.getOrThrow(harnessId),
  detectAgentLocalComponents,
  planPlacementRuntime,
  prepareCodexRuntimeHome,
  prepareAgentToolRuntime,
}

export const runtimeCompiler: AspcCompiler = async (req, options) => {
  const client = createAgentSpacesClient({
    ...(options?.aspHome !== undefined ? { aspHome: options.aspHome } : {}),
    runtime: runtimeDependencies,
  })
  return client.compileRuntimePlan(
    req,
    options?.compileContext !== undefined ? { compileContext: options.compileContext } : undefined
  )
}
