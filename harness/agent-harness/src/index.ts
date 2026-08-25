import { createSession, loadAgent } from 'agent-harness-runtime'
import {
  type PiSdkSession,
  type PiSdkSessionFactoryInput,
  createPiSdkDriver,
  runBrokerCli,
} from 'spaces-harness-broker-pi-sdk'

export function createAgentHarnessDriver() {
  return createPiSdkDriver({
    driverKind: 'agent-harness',
    createSession: createResolvedAgentSession,
  })
}

export async function runAgentHarness(): Promise<void> {
  await runBrokerCli({ additionalDrivers: [createAgentHarnessDriver] })
}

async function createResolvedAgentSession(input: PiSdkSessionFactoryInput): Promise<PiSdkSession> {
  const semantic = input.spec.agent
  if (semantic === undefined) {
    throw new Error('agent-harness requires spec.agent semantic inputs')
  }
  const agent = await loadAgent({
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
    dispatchEnv: Object.fromEntries(
      Object.entries(input.environment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    ),
  })
  return (await createSession(agent, {
    auth: input.auth,
    extensionFactories: [input.permissionExtension],
    customTools: [input.structuredTool],
    ...(input.spec.continuation?.key !== undefined
      ? { continuationKey: input.spec.continuation.key }
      : {}),
  })) as PiSdkSession
}

export { loadAgent, createSession } from 'agent-harness-runtime'
