import type {
  AgentSessionRuntime,
  BashOperations,
  ExtensionFactory,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { type LoadAgentOptions, createAgentHarnessRuntime, loadAgent } from 'agent-harness-runtime'
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
 * Caller additions to a resolved session. The mandatory broker inputs
 * (permission extension, broker-supplied extensions, structured tool) are
 * always placed first by the factory; callers only append.
 */
export interface ResolvedAgentSessionContribution {
  extensionFactories?: ExtensionFactory[] | undefined
  customTools?: ToolDefinition[] | undefined
  bashOperations?: BashOperations | undefined
}

const CONTRIBUTION_KEYS = new Set(['extensionFactories', 'customTools', 'bashOperations'])

const LOAD_AGENT_PROVIDERS = new Set<string>([
  'openai',
  'openai-codex',
  'anthropic',
  'anthropic-max',
])

const sessionRuntimes = new WeakMap<PiSdkSession, AgentSessionRuntime>()

/**
 * Resolve broker-provided semantic inputs into the shared direct runtime.
 * Authentication, permissions, structured output, continuation, environment,
 * and event mapping deliberately remain owned by the broker and Pi SDK driver.
 */
export async function createResolvedAgentSession(
  input: PiSdkSessionFactoryInput,
  dependencies: ResolvedAgentSessionDependencies = productionDependencies,
  contribution: ResolvedAgentSessionContribution = {}
): Promise<PiSdkSession> {
  assertContribution(contribution, input.structuredTool.name)
  const semantic = input.spec.agent
  if (semantic === undefined) {
    throw new Error('agent-harness requires spec.agent semantic inputs')
  }

  const launch = launchIdentity(input.spec)
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
    ...launch,
    model: input.spec.sdk?.modelId,
    provider: loadAgentProvider(input.spec.sdk?.provider ?? input.spec.harness.provider),
    reasoningEffort: input.spec.sdk?.thinkingLevel,
    lockedEnv: input.spec.process.lockedEnv,
    dispatchEnv: definedEnvironment(input.environment),
  })
  const runtime = await dependencies.createRuntime({
    agent,
    auth: input.auth,
    extensionFactories: [
      input.permissionExtension,
      ...(input.additionalExtensions ?? []),
      ...(contribution.extensionFactories ?? []),
    ],
    customTools: [input.structuredTool, ...(contribution.customTools ?? [])],
    ...(contribution.bashOperations !== undefined
      ? { bashOperations: contribution.bashOperations }
      : {}),
    ...(input.spec.continuation?.key !== undefined
      ? { continuationKey: input.spec.continuation.key }
      : {}),
  })
  const session = runtimeBackedPiSdkSession(runtime)
  sessionRuntimes.set(session, runtime)
  return session
}

/** Recover the runtime that backs a session created by this factory. */
export function resolvedAgentSessionRuntime(
  session: PiSdkSession
): AgentSessionRuntime | undefined {
  return sessionRuntimes.get(session)
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

/**
 * Launch identity the broker already holds for this invocation. A missing
 * source leaves its key absent; nothing here synthesizes an id.
 */
function launchIdentity(
  spec: PiSdkSessionFactoryInput['spec']
): Pick<LoadAgentOptions, 'runtimeId' | 'invocationId' | 'initialInputId'> {
  const runtimeId = spec.correlation?.['runtimeId']
  const initialInputId = spec.correlation?.['inputId']
  return {
    ...(runtimeId !== undefined ? { runtimeId } : {}),
    ...(spec.invocationId !== undefined ? { invocationId: spec.invocationId } : {}),
    ...(initialInputId !== undefined ? { initialInputId } : {}),
  }
}

function loadAgentProvider(provider: string | undefined): LoadAgentOptions['provider'] {
  return provider !== undefined && LOAD_AGENT_PROVIDERS.has(provider)
    ? (provider as LoadAgentOptions['provider'])
    : undefined
}

function assertContribution(
  contribution: ResolvedAgentSessionContribution,
  structuredToolName: string
): void {
  for (const key of Object.keys(contribution)) {
    if (!CONTRIBUTION_KEYS.has(key)) {
      throw new Error(`agent-harness session contribution has unknown key '${key}'`)
    }
  }
  if (contribution.customTools?.some((tool) => tool.name === structuredToolName)) {
    throw new Error(
      `agent-harness session contribution cannot replace the structured tool '${structuredToolName}'`
    )
  }
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}
