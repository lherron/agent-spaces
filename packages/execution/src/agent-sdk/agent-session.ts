import { query } from '@anthropic-ai/claude-agent-sdk'
import type { HookEventBusAdapter } from './hooks-bridge.js'
import { HooksBridge, processSDKMessage } from './hooks-bridge.js'
import { PromptQueue } from './prompt-queue.js'

/**
 * Configuration for an agent session.
 */
export interface AgentSessionConfig {
  ownerId: string
  cwd: string
  model: 'haiku' | 'sonnet' | 'opus' | 'opus-4-5'
  allowedTools?: string[]
  maxTurns?: number
  sessionId?: string
  plugins?: Array<{ type: 'local'; path: string }>
  /** Custom system prompt to override default Claude Code prompt */
  systemPrompt?: string
}

/**
 * State of an agent session.
 */
export type AgentSessionState = 'idle' | 'running' | 'stopped' | 'error'

/**
 * Manages a single Claude Agent SDK session for an owner (project/run/session).
 *
 * Each owner gets one AgentSession that:
 * - Owns the SDK query iterator
 * - Accepts user prompts via the prompt queue
 * - Streams outputs and hook callbacks back to the host
 */
export class AgentSession {
  private readonly promptQueue: PromptQueue
  private readonly hooksBridge: HooksBridge
  private outputIterator: AsyncIterator<unknown> | null = null
  private state: AgentSessionState = 'idle'
  private isListening = false
  private lastActivityAt: number = Date.now()
  private pid?: number
  private lastResponse = ''
  private sdkSessionId?: string
  private readonly onSdkSessionId: ((sdkSessionId: string) => void) | undefined

  constructor(
    private readonly config: AgentSessionConfig,
    private readonly hookEventBus: HookEventBusAdapter,
    opts?: { onSdkSessionId?: (sdkSessionId: string) => void }
  ) {
    this.promptQueue = new PromptQueue(config.sessionId)
    this.hooksBridge = new HooksBridge(config.ownerId, hookEventBus, config.cwd, config.sessionId)
    this.onSdkSessionId = opts?.onSdkSessionId
  }

  /**
   * Start the SDK session by initializing the query.
   */
  start(): void {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start session in state: ${this.state}`)
    }

    this.state = 'running'
    this.lastActivityAt = Date.now()

    // Store PID of current process (the SDK runs in-process)
    this.pid = process.pid

    // Map short model names to full SDK model names
    const modelMap: Record<string, string> = {
      haiku: 'claude-haiku',
      sonnet: 'claude-sonnet',
      opus: 'claude-opus-4',
      'opus-4-5': 'claude-opus-4-5',
    }
    const sdkModel = modelMap[this.config.model] ?? this.config.model

    // Initialize the SDK query with the prompt queue as input
    const permissionMode = 'default' as const
    const options = {
      maxTurns: this.config.maxTurns ?? 100,
      model: sdkModel,
      cwd: this.config.cwd,
      permissionMode,
      // biome-ignore lint/suspicious/noExplicitAny: SDK type compatibility for canUseTool callback
      canUseTool: this.hooksBridge.createCanUseToolCallback() as any,
      ...(this.config.allowedTools ? { allowedTools: this.config.allowedTools } : {}),
      ...(this.config.plugins ? { plugins: this.config.plugins } : {}),
      ...(this.config.systemPrompt ? { systemPrompt: this.config.systemPrompt } : {}),
    }

    const result = query({
      // biome-ignore lint/suspicious/noExplicitAny: SDK type compatibility - accepts simpler message formats at runtime
      prompt: this.promptQueue as any,
      options,
    })

    this.outputIterator = result[Symbol.asyncIterator]()
    this.startOutputListener()
  }

  /**
   * Send a user prompt to the session.
   */
  sendPrompt(content: string): void {
    if (this.state !== 'running') {
      throw new Error(`Cannot send prompt in state: ${this.state}`)
    }
    this.lastActivityAt = Date.now()
    this.promptQueue.push(content)
  }

  /**
   * Stop the session.
   */
  stop(reason?: string): void {
    if (this.state === 'stopped') return

    this.state = 'stopped'
    this.promptQueue.close(reason)
    this.hooksBridge.emitSessionEnd()
  }

  /**
   * Get the current session state.
   */
  getState(): AgentSessionState {
    return this.state
  }

  /**
   * Get the PID of the session (for status reporting).
   */
  getPid(): number | undefined {
    return this.pid
  }

  /**
   * Get the SDK session ID (for session resume via `claude -r`).
   * This is captured from the SDK's system/init message.
   */
  getSdkSessionId(): string | undefined {
    return this.sdkSessionId
  }

  /**
   * Get the last activity timestamp.
   */
  getLastActivityAt(): number {
    return this.lastActivityAt
  }

  /**
   * Check if the session is healthy.
   */
  isHealthy(): boolean {
    return this.state === 'running'
  }

  /**
   * Start listening to SDK output messages.
   */
  private startOutputListener(): void {
    if (this.isListening) return
    this.isListening = true

    this.listenToOutput().catch((error) => {
      console.error(`[agent-sdk] Error in session ${this.config.ownerId}:`, error)
      this.state = 'error'
      this.hooksBridge.emitStop()
    })
  }

  /**
   * Listen to SDK output and process messages.
   */
  private async listenToOutput(): Promise<void> {
    if (!this.outputIterator) return

    try {
      while (true) {
        const { value, done } = await this.outputIterator.next()
        if (done) break

        this.lastActivityAt = Date.now()

        const msg = value as Record<string, unknown>
        const msgType = typeof msg['type'] === 'string' ? msg['type'] : undefined

        // Capture SDK session ID from system/init message
        if (msgType === 'system' && msg['subtype'] === 'init') {
          const sessionId = msg['session_id']
          if (typeof sessionId === 'string' && this.sdkSessionId !== sessionId) {
            this.sdkSessionId = sessionId
            this.onSdkSessionId?.(sessionId)
          }
          const pluginList = Array.isArray(msg['plugins']) ? msg['plugins'] : []
          const pluginNames = pluginList
            .map((plugin) => {
              if (plugin && typeof plugin === 'object' && typeof plugin.name === 'string') {
                return plugin.name
              }
              return null
            })
            .filter((name): name is string => Boolean(name))
          if (pluginNames.length > 0) {
            console.log(
              `[agent-sdk] init plugins for ${this.config.ownerId}: ${pluginNames.join(', ')}`
            )
          }
        }

        // Extract assistant response text from SDK messages
        const responseText = this.extractResponseText(value)
        if (responseText) {
          this.lastResponse = responseText
        }

        processSDKMessage(value, this.hooksBridge)

        // When we receive a result message, emit Stop to complete the current run
        // The SDK session stays alive for subsequent prompts
        if (msgType === 'result') {
          this.hooksBridge.emitStop(undefined, this.lastResponse || undefined)
          // Clear lastResponse for next prompt
          this.lastResponse = ''
        }
      }
    } finally {
      this.isListening = false
      if (this.state === 'running') {
        this.state = 'stopped'
      }
      // Emit final stop if session ends without a result
      if (this.lastResponse) {
        this.hooksBridge.emitStop(undefined, this.lastResponse)
      }
    }
  }

  /**
   * Extract text response from SDK message.
   */
  private extractResponseText(message: unknown): string | undefined {
    if (!message || typeof message !== 'object') return undefined

    const msg = message as Record<string, unknown>

    // Handle result messages (final completion with result string)
    if (msg['type'] === 'result' && typeof msg['result'] === 'string') {
      return msg['result']
    }

    // Handle assistant messages
    if (msg['type'] === 'assistant' && msg['message']) {
      const assistantMsg = msg['message'] as Record<string, unknown>
      const content = assistantMsg['content']

      if (typeof content === 'string') {
        return content
      }

      if (Array.isArray(content)) {
        // Extract text from content blocks
        const textParts: string[] = []
        for (const block of content) {
          if (block && typeof block === 'object') {
            const blockObj = block as Record<string, unknown>
            if (blockObj['type'] === 'text' && typeof blockObj['text'] === 'string') {
              textParts.push(blockObj['text'])
            }
          }
        }
        if (textParts.length > 0) {
          return textParts.join('\n')
        }
      }
    }

    return undefined
  }
}
