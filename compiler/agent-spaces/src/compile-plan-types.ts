import type { RuntimePlacement } from 'spaces-config'
import type { InvocationDispatchRequest } from 'spaces-harness-broker-protocol'
import type {
  CompileContext,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'

import type { ResolvedHarnessExecution } from './harness-selection/types.js'
import type { AgentSpacesRuntimeDependencies } from './placement-api.js'

/**
 * The compile request placement, narrowed to the spaces-config RuntimePlacement
 * shape it actually carries plus the typed env channels the compiler reads.
 *
 * Intersecting the contract placement with the spaces-config RuntimePlacement
 * makes this an honest refinement of `RuntimeCompileRequest['placement']`: it is
 * a valid downcast (no `as unknown as RuntimePlacement` bridge) and is directly
 * assignable to the strict RuntimePlacement that prepare-cli-runtime expects.
 * Replaces the former scattered cast cluster.
 */
export type CompilePlacement = RuntimeCompileRequest['placement'] &
  RuntimePlacement & {
    env?: Record<string, string> | undefined
    lockedEnv?: Record<string, string> | undefined
    dispatchEnv?: Record<string, string> | undefined
  }

export type CompileRuntimePlanOptions = {
  clientAspHome?: string | undefined
  clientRegistryPath?: string | undefined
  clientRuntime?: AgentSpacesRuntimeDependencies | undefined
  /**
   * Pinned, serializable compile context (T-04133). When present, `nowIso`
   * sources `createdAt` and `idSalt`/`toolchainManifest` feed deterministic id
   * derivation. Production callers omit it (real time, unsalted derivation).
   */
  compileContext?: CompileContext | undefined
  /** Inspection/preview projects a launch plan but must not mutate CODEX_HOME. */
  materializeCodexRuntimeHome?: boolean | undefined
  dispatch?: Omit<InvocationDispatchRequest, 'startRequest'> | undefined
}

/** One recipe builder: turns a resolved harness execution into a compiled plan. */
export type ResolvedRecipeBuilder = (
  req: RuntimeCompileRequest,
  placement: CompilePlacement,
  resolved: ResolvedHarnessExecution,
  options?: CompileRuntimePlanOptions
) => Promise<RuntimeCompileResponse>
