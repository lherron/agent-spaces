import type {
  AgentSession,
  ExtensionFactory,
  SessionManager,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { ResolvedAgentResourceSources, RunMode, RuntimePlacement } from 'spaces-config'
import type { AgentSystemPromptInspection, ContextResolverContext } from 'spaces-runtime'
import type { PiSdkModelCatalogEntry } from 'spaces-runtime-contracts'

export interface LoadAgentOptions {
  agentId: string
  projectId?: string | undefined
  agentRoot?: string | undefined
  projectRoot?: string | undefined
  cwd?: string | undefined
  aspHome?: string | undefined
  runMode?: RunMode | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  runId?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  model?: string | undefined
  provider?: 'openai' | 'anthropic' | undefined
  reasoningEffort?: string | undefined
  lockedEnv?: Record<string, string> | undefined
  dispatchEnv?: Record<string, string> | undefined
  resolverContext?: ContextResolverContext | undefined
}

export interface ResolvedAgent {
  input: LoadAgentOptions
  agentId: string
  projectId?: string | undefined
  aspHome: string
  placement: RuntimePlacement
  model: PiSdkModelCatalogEntry
  reasoningEffort?: string | undefined
  environment: NodeJS.ProcessEnv
  prompt?: { content: string; mode: 'append' | 'replace' } | undefined
  reminder?: string | undefined
  inspection?: AgentSystemPromptInspection | undefined
  sources: ResolvedAgentResourceSources
  /** Ordered direct ASP source paths. No generated Pi bundle is represented here. */
  skillPaths: string[]
  warnings: string[]
}

export interface PiAgentSessionAuth {
  authMode: 'api-key' | 'oauth'
  authPath: string
  providerId: string
}

export interface CreateSessionOptions {
  agentDir?: string | undefined
  authStorePath?: string | undefined
  continuationKey?: string | undefined
  extensionFactories?: ExtensionFactory[] | undefined
  customTools?: ToolDefinition[] | undefined
  auth?: PiAgentSessionAuth | undefined
}

export interface CreateAgentHarnessRuntimeOptions extends CreateSessionOptions {
  agent: ResolvedAgent
  cwd?: string | undefined
  sessionManager?: SessionManager | undefined
}

export interface RuntimeBackedSession extends AgentSession {
  dispose(): void | Promise<void>
}
