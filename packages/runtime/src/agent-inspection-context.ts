import {
  type AgentInspectionCompileContext,
  type AgentInspectionEvaluationContext,
  validateAgentInspectionEvaluationContext,
} from 'spaces-runtime-contracts'
import type { ContextResolverContext } from './context-resolver.js'

export type NormalizedAgentInspectionEvaluationContext = {
  evaluationContext: AgentInspectionEvaluationContext
  resolverContext: ContextResolverContext
  compileContext: AgentInspectionCompileContext
}

/**
 * Validate and normalize every ambient-sensitive input used by inspection.
 *
 * The resulting resolver context always carries pinned roots/search path, cwd,
 * time, template environment, predicate inputs, exec inputs, and service probe
 * responses. It never reads `process.cwd()`, `process.env`, or the wall clock.
 */
export function normalizeAgentInspectionEvaluationContext(
  value: unknown
): NormalizedAgentInspectionEvaluationContext {
  const context = validateAgentInspectionEvaluationContext(value)
  const { identifiers, paths } = context

  return {
    evaluationContext: context,
    resolverContext: {
      agentRoot: paths.agentRoot,
      agentsRoot: paths.agentsRoot,
      agentRootSearchPath: [paths.agentRoot, paths.agentsRoot],
      projectRoot: paths.projectRoot,
      projectId: identifiers.projectId,
      agentId: identifiers.agentId,
      agentName: identifiers.agentName ?? identifiers.agentId,
      taskId: identifiers.taskId,
      lane: identifiers.lane,
      runMode: identifiers.mode,
      scaffoldPackets: context.scaffoldPackets,
      agentProfile: context.agentProfile,
      now: new Date(context.nowIso),
      env: context.environment,
      cwd: paths.cwd,
      predicateCwd: context.predicateInputs.cwd,
      predicateEnv: context.predicateInputs.environment,
      execCwd: context.execInputs.cwd,
      execEnv: context.execInputs.environment,
      serviceProbeResponses: context.serviceProbeInputs.responses,
    },
    compileContext: context.compileContext,
  }
}
