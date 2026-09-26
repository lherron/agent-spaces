import type {
  AgentSession,
  BashOperations,
  ExtensionFactory,
  SessionManager,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { ResolvedAgentResourceSources, RunMode, RuntimePlacement } from 'spaces-config'
import type { AgentSystemPromptInspection, ContextResolverContext } from 'spaces-runtime'
import type { PiProviderModelCatalogEntry } from 'spaces-runtime-contracts'

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
  runtimeId?: string | undefined
  invocationId?: string | undefined
  initialInputId?: string | undefined
  model?: string | undefined
  provider?: 'openai' | 'openai-codex' | 'anthropic' | 'anthropic-max' | undefined
  reasoningEffort?: string | undefined
  lockedEnv?: Record<string, string> | undefined
  dispatchEnv?: Record<string, string> | undefined
  /**
   * Deterministic environment base for placement and direct ASP source
   * resolution. Omit only for foreground execution, which intentionally keeps
   * the caller's process environment.
   */
  baseEnvironment?: NodeJS.ProcessEnv | undefined
  resolverContext?: ContextResolverContext | undefined
}

export interface ResolvedAgent {
  input: LoadAgentOptions
  agentId: string
  projectId?: string | undefined
  aspHome: string
  placement: RuntimePlacement
  model: PiProviderModelCatalogEntry
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
  /** `true` continues the most recent session; a string selects one explicit session. */
  continuationKey?: string | boolean | undefined
  extensionFactories?: ExtensionFactory[] | undefined
  customTools?: ToolDefinition[] | undefined
  /** Host-owned execution boundary for the built-in Pi bash tool. */
  bashOperations?: BashOperations | undefined
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
