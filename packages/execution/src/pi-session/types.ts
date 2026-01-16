import type { ExtensionFactory, Skill } from '@mariozechner/pi-coding-agent'

export interface HookPermissionResponse {
  decision: 'allow' | 'deny'
  updatedInput?: unknown
  message?: string
  interrupt?: boolean
}

export interface PiHookEventBusAdapter {
  emitHook(ownerId: string, hook: Record<string, unknown>): void
  requestPermission(ownerId: string, hook: Record<string, unknown>): Promise<HookPermissionResponse>
  isToolAutoAllowed(ownerId: string, toolName: string): boolean
}

export type PiSessionState = 'idle' | 'running' | 'streaming' | 'stopped' | 'error'

export interface PiAgentSessionEvent {
  type: string
  toolName?: string
  toolCallId?: string
  args?: Record<string, unknown>
  result?: unknown
  isError?: boolean
  reason?: string
  turnId?: string
  toolResults?: unknown[]
  message?: unknown
  messageId?: string
  assistantMessageEvent?: unknown
  partialResult?: unknown
  [key: string]: unknown
}

export interface PiSessionConfig {
  ownerId: string
  cwd: string
  model?: string
  provider?: string
  thinkingLevel?: 'none' | 'low' | 'medium' | 'high'
  persistSessions?: boolean
  sessionPath?: string
  sessionId?: string
  systemPrompt?: string
  agentDir?: string
  globalAgentDir?: string
  additionalExtensionPaths?: string[]
  extensions?: ExtensionFactory[]
  skills?: Skill[]
  contextFiles?: Array<{ path: string; content: string }>
  hookEventBus?: PiHookEventBusAdapter
  onEvent?: (event: PiAgentSessionEvent, runId?: string) => void
}

export interface PiSessionStartOptions {
  skills?: Skill[]
  extensions?: ExtensionFactory[]
  contextFiles?: Array<{ path: string; content: string }>
  agentDir?: string
  globalAgentDir?: string
}
