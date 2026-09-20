import type { AgentSpacesClientOptions } from 'agent-spaces'
import {
  detectAgentLocalComponents,
  harnessRegistry,
  planPlacementRuntime,
  prepareAgentToolRuntime,
  prepareCodexRuntimeHome,
  resolveCodexRuntimeHomePath,
} from 'spaces-execution'

export const runtimeDependencies: NonNullable<AgentSpacesClientOptions['runtime']> = {
  getHarnessAdapter: (harnessId) => harnessRegistry.getOrThrow(harnessId),
  detectAgentLocalComponents,
  planPlacementRuntime,
  prepareCodexRuntimeHome,
  resolveCodexRuntimeHomePath,
  prepareAgentToolRuntime,
}
