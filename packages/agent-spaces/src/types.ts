import type { LintWarning } from 'spaces-config'

export type SpaceSpec = { spaces: string[] } | { target: { targetName: string; targetDir: string } }

export interface SessionCallbacks {
  onEvent(event: AgentEvent): void | Promise<void>
}

export type SessionState = 'running' | 'complete' | 'error'

export interface RunTurnRequest {
  externalSessionId: string
  externalRunId: string
  aspHome: string
  spec: SpaceSpec
  harness: string
  model?: string | undefined
  harnessSessionId?: string | undefined
  cwd: string
  env?: Record<string, string> | undefined
  prompt: string
  attachments?: string[] | undefined
  callbacks: SessionCallbacks
}

export interface RunTurnResponse {
  harnessSessionId?: string | undefined
  harness: string
  model?: string | undefined
  result: RunResult
}

export interface ResolveRequest {
  aspHome: string
  spec: SpaceSpec
}

export interface ResolveResponse {
  ok: boolean
  error?: AgentSpacesError | undefined
}

export interface DescribeRequest {
  aspHome: string
  spec: SpaceSpec
  registryPath?: string | undefined
  harness?: string | undefined
  model?: string | undefined
  cwd?: string | undefined
  sessionId?: string | undefined
  runLint?: boolean | undefined
}

export interface DescribeResponse {
  hooks: string[]
  skills: string[]
  tools: string[]
  agentSdkSessionParams?: Array<{ paramName: string; paramValue: unknown }> | undefined
  lintWarnings?: LintWarning[] | undefined
}

export interface HarnessCapabilities {
  harnesses: Array<{
    id: string
    models: string[]
  }>
}

export interface RunResult {
  success: boolean
  finalOutput?: string | undefined
  error?: AgentSpacesError | undefined
}

export interface AgentSpacesError {
  message: string
  code?: 'resolve_failed' | 'harness_session_not_found' | 'model_not_supported' | undefined
  details?: Record<string, unknown> | undefined
}

export interface BaseEvent {
  ts: string
  seq: number
  externalSessionId: string
  externalRunId: string
  harnessSessionId?: string | undefined
}

export type AgentEvent =
  | (BaseEvent & { type: 'state'; state: SessionState })
  | (BaseEvent & { type: 'message'; role: 'user' | 'assistant'; content: string })
  | (BaseEvent & { type: 'message_delta'; role: 'assistant'; delta: string })
  | (BaseEvent & { type: 'tool_call'; toolUseId: string; toolName: string; input: unknown })
  | (BaseEvent & {
      type: 'tool_result'
      toolUseId: string
      toolName: string
      output: unknown
      isError: boolean
    })
  | (BaseEvent & {
      type: 'log'
      level: 'debug' | 'info' | 'warn' | 'error'
      message: string
      fields?: Record<string, unknown> | undefined
    })
  | (BaseEvent & { type: 'complete'; result: RunResult })

export interface AgentSpacesClient {
  runTurn(req: RunTurnRequest): Promise<RunTurnResponse>
  resolve(req: ResolveRequest): Promise<ResolveResponse>
  describe(req: DescribeRequest): Promise<DescribeResponse>
  getHarnessCapabilities(): Promise<HarnessCapabilities>
}
