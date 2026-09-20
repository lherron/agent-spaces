import { createAgentSpacesClient } from 'agent-spaces'
import type { AspcCompiler } from 'spaces-aspc'
import {
  ClaudeAdapter,
  detectAgentLocalComponents,
  harnessRegistry,
  planPlacementRuntime,
  prepareAgentToolRuntime,
  prepareCodexRuntimeHome,
  resolveCodexRuntimeHomePath,
} from 'spaces-execution'

export interface RuntimeCompilerOptions {
  claudeStatuslineSource?:
    | {
        path: string
        sha256: string
        required: true
      }
    | undefined
}

function createRuntimeDependencies(options: RuntimeCompilerOptions = {}) {
  const releaseClaudeAdapter =
    options.claudeStatuslineSource === undefined
      ? undefined
      : new ClaudeAdapter({ statuslineSource: options.claudeStatuslineSource })
  return {
    getHarnessAdapter: (harnessId: Parameters<typeof harnessRegistry.getOrThrow>[0]) =>
      harnessId === 'claude' && releaseClaudeAdapter !== undefined
        ? releaseClaudeAdapter
        : harnessRegistry.getOrThrow(harnessId),
    detectAgentLocalComponents,
    planPlacementRuntime,
    prepareCodexRuntimeHome,
    resolveCodexRuntimeHomePath,
    prepareAgentToolRuntime,
  }
}

export const runtimeDependencies = createRuntimeDependencies()

export function createRuntimeCompiler(options: RuntimeCompilerOptions = {}): AspcCompiler {
  const dependencies = createRuntimeDependencies(options)
  return async (req, compileOptions) => {
    const client = createAgentSpacesClient({
      ...(compileOptions?.aspHome !== undefined ? { aspHome: compileOptions.aspHome } : {}),
      runtime: dependencies,
    })
    return client.compileRuntimePlan(
      req,
      compileOptions?.compileContext !== undefined
        ? {
            compileContext: compileOptions.compileContext,
            ...(compileOptions.materializeCodexRuntimeHome !== undefined
              ? { materializeCodexRuntimeHome: compileOptions.materializeCodexRuntimeHome }
              : {}),
          }
        : compileOptions?.materializeCodexRuntimeHome !== undefined
          ? { materializeCodexRuntimeHome: compileOptions.materializeCodexRuntimeHome }
          : undefined
    )
  }
}

export const runtimeCompiler = createRuntimeCompiler()
