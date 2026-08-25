import type { AgentSessionRuntime } from '@earendil-works/pi-coding-agent'
import { createAgentHarnessRuntime, loadAgent } from 'agent-harness-runtime'
import type { PiSdkSession, PiSdkSessionFactoryInput } from 'spaces-harness-broker-pi-sdk'

export interface ResolvedAgentSessionDependencies {
  loadAgent: typeof loadAgent
  createRuntime: typeof createAgentHarnessRuntime
}

const productionDependencies: ResolvedAgentSessionDependencies = {
  loadAgent,
  createRuntime: createAgentHarnessRuntime,
}

/**
 * Resolve broker-provided semantic inputs into the shared direct runtime.
 * Authentication, permissions, structured output, continuation, environment,
 * and event mapping deliberately remain owned by the broker and Pi SDK driver.
 */
export async function createResolvedAgentSession(
  input: PiSdkSessionFactoryInput,
  dependencies: ResolvedAgentSessionDependencies = productionDependencies
): Promise<PiSdkSession> {
  const semantic = input.spec.agent
  if (semantic === undefined) {
    throw new Error('agent-harness requires spec.agent semantic inputs')
  }

  const agent = await dependencies.loadAgent({
    agentId: semantic.agentId,
    ...(semantic.projectId !== undefined ? { projectId: semantic.projectId } : {}),
    ...(semantic.agentRoot !== undefined ? { agentRoot: semantic.agentRoot } : {}),
    ...(semantic.projectRoot !== undefined ? { projectRoot: semantic.projectRoot } : {}),
    cwd: input.spec.process.cwd,
    ...(semantic.aspHome !== undefined ? { aspHome: semantic.aspHome } : {}),
    ...(semantic.runMode !== undefined ? { runMode: semantic.runMode } : {}),
    ...(semantic.scopeRef !== undefined ? { scopeRef: semantic.scopeRef } : {}),
    ...(semantic.laneRef !== undefined ? { laneRef: semantic.laneRef } : {}),
    ...(semantic.runId !== undefined ? { runId: semantic.runId } : {}),
    ...(semantic.hostSessionId !== undefined ? { hostSessionId: semantic.hostSessionId } : {}),
    ...(semantic.generation !== undefined ? { generation: semantic.generation } : {}),
    model: input.spec.sdk?.modelId,
    provider:
      input.spec.harness.provider === 'anthropic' || input.spec.harness.provider === 'openai'
        ? input.spec.harness.provider
        : undefined,
    reasoningEffort: input.spec.sdk?.thinkingLevel,
    lockedEnv: input.spec.process.lockedEnv,
    dispatchEnv: definedEnvironment(input.environment),
  })
  const runtime = await dependencies.createRuntime({
    agent,
    auth: input.auth,
    extensionFactories: [input.permissionExtension],
    customTools: [input.structuredTool],
    ...(input.spec.continuation?.key !== undefined
      ? { continuationKey: input.spec.continuation.key }
      : {}),
  })
  return runtimeBackedPiSdkSession(runtime)
}

/** Narrow a direct runtime to the broker's Pi SDK session shape. */
export function runtimeBackedPiSdkSession(runtime: AgentSessionRuntime): PiSdkSession {
  const session = runtime.session as unknown as PiSdkSession
  let disposal: Promise<void> | undefined
  Object.defineProperty(session, 'dispose', {
    configurable: true,
    value: () => {
      disposal ??= runtime.dispose()
      return disposal
    },
  })
  return session
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}
