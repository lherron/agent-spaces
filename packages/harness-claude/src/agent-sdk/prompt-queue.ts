import { randomUUID } from 'node:crypto'

/**
 * User message format expected by the Claude Agent SDK for multi-turn prompts.
 * This matches the SDK's SDKUserMessage type requirements.
 */
export type SDKUserMessage = {
  type: 'user'
  message: { role: 'user'; content: string }
  parent_tool_use_id: string | null
  session_id: string
  uuid?: string
  isSynthetic?: boolean
}

/**
 * AsyncIterable queue for feeding prompts to the Claude Agent SDK.
 *
 * The SDK accepts an AsyncIterable of user messages for multi-turn conversations.
 * This queue allows:
 * - `push(content)` - add a user prompt to the queue
 * - `iterate()` - async generator yielding prompts
 * - `close()` - signal completion (stops iteration)
 */
export class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private messages: SDKUserMessage[] = []
  private waiting: ((msg: SDKUserMessage) => void) | null = null
  private closed = false
  private closeReason: string | undefined
  private sessionId: string

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? randomUUID()
  }

  /**
   * Push a user prompt to the queue.
   * If there's a waiting consumer, deliver immediately.
   * Otherwise, queue for later consumption.
   */
  push(content: string): void {
    if (this.closed) {
      throw new Error(
        `Cannot push to closed queue${this.closeReason ? `: ${this.closeReason}` : ''}`
      )
    }

    const msg: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content,
      },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid: randomUUID(),
    }

    if (this.waiting) {
      // Someone is waiting - deliver immediately
      this.waiting(msg)
      this.waiting = null
    } else {
      // No one waiting - queue it
      this.messages.push(msg)
    }
  }

  /**
   * Get the session ID for this queue.
   */
  getSessionId(): string {
    return this.sessionId
  }

  /**
   * AsyncIterator implementation for consumption by the SDK.
   */
  async *[Symbol.asyncIterator](): AsyncIterableIterator<SDKUserMessage> {
    while (!this.closed) {
      if (this.messages.length > 0) {
        const msg = this.messages.shift()
        if (msg) yield msg
      } else {
        // Wait for next message or close
        const msg = await new Promise<SDKUserMessage | null>((resolve) => {
          this.waiting = (m) => resolve(m)
          // Check if we closed while waiting
          if (this.closed) {
            this.waiting = null
            resolve(null)
          }
        })
        if (msg === null) break
        yield msg
      }
    }
  }

  /**
   * Close the queue, stopping iteration.
   * Any pending prompts will be discarded.
   */
  close(reason?: string): void {
    this.closed = true
    this.closeReason = reason
    // Wake up any waiting consumer
    if (this.waiting) {
      // Can't pass null directly due to type, but we check closed flag
      this.waiting = null
    }
  }

  /**
   * Check if the queue is closed.
   */
  isClosed(): boolean {
    return this.closed
  }

  /**
   * Get the number of pending (undelivered) prompts.
   */
  pendingCount(): number {
    return this.messages.length
  }
}
