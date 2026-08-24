import type { AgentSpacesClientOptions } from 'agent-spaces'
import {
  detectAgentLocalComponents,
  harnessRegistry,
  planPlacementRuntime,
  prepareAgentToolRuntime,
  prepareCodexRuntimeHome,
} from 'spaces-execution'

export const compilerRuntime: NonNullable<AgentSpacesClientOptions['runtime']> = {
  getHarnessAdapter: (harnessId) => harnessRegistry.getOrThrow(harnessId),
  detectAgentLocalComponents,
  planPlacementRuntime,
  prepareCodexRuntimeHome,
  prepareAgentToolRuntime,
}
