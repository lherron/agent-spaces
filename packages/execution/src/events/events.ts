/**
 * Structured Run Events (JSONL format)
 *
 * WHY: Multi-agent runs need structured event emission for:
 * - Control-plane observability of run lifecycle
 * - Session correlation across distributed agents
 * - Heartbeat monitoring for stalled agent detection
 * - Artifact indexing and transcript collection
 *
 * Events are emitted as JSONL (one JSON object per line) to a file
 * or stdout, enabling easy parsing by the control-plane.
 */

import { type WriteStream, createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CpContext } from './cp-context.js'

// ============================================================================
// Event Types
// ============================================================================

/** Base event fields included in all events */
export interface BaseEvent {
  /** Event type identifier */
  event: string
  /** ISO 8601 timestamp */
  timestamp: string
  /** CP context (included when available) */
  cpContext?: CpContext | undefined
}

/** Emitted when a job starts */
export interface JobStartedEvent extends BaseEvent {
  event: 'job_started'
  /** Harness identifier */
  harness: string
  /** Target name being run */
  target?: string | undefined
  /** Process ID */
  pid?: number | undefined
  /** Working directory */
  cwd?: string | undefined
}

/** Emitted when a session starts within a job */
export interface SessionStartedEvent extends BaseEvent {
  event: 'session_started'
  /** Session identifier (provider-specific) */
  sessionId?: string | undefined
  /** Path to session file (if applicable) */
  sessionPath?: string | undefined
}

/** Emitted for user or assistant messages */
export interface MessageEvent extends BaseEvent {
  event: 'message'
  /** Message role */
  role: 'user' | 'assistant' | 'system'
  /** Message content (may be truncated for large messages) */
  content?: string | undefined
  /** Content truncated indicator */
  truncated?: boolean | undefined
}

/** Emitted when a tool is called */
export interface ToolCallEvent extends BaseEvent {
  event: 'tool_call'
  /** Tool name */
  tool: string
  /** Tool input (may be truncated) */
  input?: unknown
  /** Tool call ID (for correlation with result) */
  callId?: string | undefined
}

/** Emitted when a tool returns a result */
export interface ToolResultEvent extends BaseEvent {
  event: 'tool_result'
  /** Tool name */
  tool: string
  /** Tool call ID (for correlation with call) */
  callId?: string | undefined
  /** Tool exit code (0 = success) */
  exitCode?: number | undefined
  /** Result summary (may be truncated) */
  output?: unknown
}

/** Emitted periodically to indicate the job is still running */
export interface HeartbeatEvent extends BaseEvent {
  event: 'heartbeat'
  /** Duration since job started (milliseconds) */
  durationMs?: number | undefined
  /** Number of messages processed so far */
  messageCount?: number | undefined
}

/** Emitted when a job completes */
export interface JobCompletedEvent extends BaseEvent {
  event: 'job_completed'
  /** Exit code from the harness */
  exitCode: number
  /** Total duration (milliseconds) */
  totalDurationMs?: number | undefined
  /** Outcome descriptor */
  outcome?: 'success' | 'failure' | 'cancelled' | 'timeout' | undefined
  /** Error message if failed */
  error?: string | undefined
}

/** Union of all event types */
export type RunEvent =
  | JobStartedEvent
  | SessionStartedEvent
  | MessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | HeartbeatEvent
  | JobCompletedEvent

// ============================================================================
// Event Emitter
// ============================================================================

/** Options for creating an event emitter */
export interface EventEmitterOptions {
  /** Path to write events (JSONL file) */
  outputPath?: string | undefined
  /** Write to stdout instead of file */
  stdout?: boolean | undefined
  /** CP context to include in all events */
  cpContext?: CpContext | undefined
  /** Heartbeat interval in milliseconds (0 to disable) */
  heartbeatIntervalMs?: number | undefined
}

/**
 * Event emitter for structured run events.
 *
 * Writes JSONL events to a file or stdout for control-plane consumption.
 */
export class RunEventEmitter {
  private readonly outputPath: string | undefined
  private readonly stdout: boolean
  private readonly cpContext: CpContext | undefined
  private stream: WriteStream | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private startTime: number
  private messageCount = 0
  private closed = false

  constructor(options: EventEmitterOptions = {}) {
    this.outputPath = options.outputPath
    this.stdout = options.stdout ?? false
    this.cpContext = options.cpContext
    this.startTime = Date.now()

    // Start heartbeat if interval provided
    if (options.heartbeatIntervalMs && options.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        this.emitHeartbeat()
      }, options.heartbeatIntervalMs)
    }
  }

  /**
   * Initialize the event stream (create file if needed).
   */
  async init(): Promise<void> {
    if (this.outputPath && !this.stdout) {
      await mkdir(dirname(this.outputPath), { recursive: true })
      this.stream = createWriteStream(this.outputPath, { flags: 'a' })
    }
  }

  /**
   * Emit an event.
   */
  emit<T extends RunEvent>(event: Omit<T, 'timestamp' | 'cpContext'>): void {
    if (this.closed) return

    const fullEvent: RunEvent = {
      ...event,
      timestamp: new Date().toISOString(),
      cpContext: this.cpContext,
    } as RunEvent

    // Track message count for heartbeats
    if (event.event === 'message') {
      this.messageCount++
    }

    this.writeEvent(fullEvent)
  }

  /**
   * Emit a job_started event.
   */
  emitJobStarted(data: Omit<JobStartedEvent, 'event' | 'timestamp' | 'cpContext'>): void {
    this.startTime = Date.now()
    this.emit<JobStartedEvent>({ event: 'job_started', ...data })
  }

  /**
   * Emit a session_started event.
   */
  emitSessionStarted(data: Omit<SessionStartedEvent, 'event' | 'timestamp' | 'cpContext'>): void {
    this.emit<SessionStartedEvent>({ event: 'session_started', ...data })
  }

  /**
   * Emit a message event.
   */
  emitMessage(data: Omit<MessageEvent, 'event' | 'timestamp' | 'cpContext'>): void {
    this.emit<MessageEvent>({ event: 'message', ...data })
  }

  /**
   * Emit a tool_call event.
   */
  emitToolCall(data: Omit<ToolCallEvent, 'event' | 'timestamp' | 'cpContext'>): void {
    this.emit<ToolCallEvent>({ event: 'tool_call', ...data })
  }

  /**
   * Emit a tool_result event.
   */
  emitToolResult(data: Omit<ToolResultEvent, 'event' | 'timestamp' | 'cpContext'>): void {
    this.emit<ToolResultEvent>({ event: 'tool_result', ...data })
  }

  /**
   * Emit a heartbeat event.
   */
  emitHeartbeat(): void {
    if (this.closed) return
    this.emit<HeartbeatEvent>({
      event: 'heartbeat',
      durationMs: Date.now() - this.startTime,
      messageCount: this.messageCount,
    })
  }

  /**
   * Emit a job_completed event and close the emitter.
   */
  emitJobCompleted(
    data: Omit<JobCompletedEvent, 'event' | 'timestamp' | 'cpContext' | 'totalDurationMs'>
  ): void {
    this.emit<JobCompletedEvent>({
      event: 'job_completed',
      totalDurationMs: Date.now() - this.startTime,
      ...data,
    })
  }

  /**
   * Close the event emitter.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true

    // Stop heartbeat timer
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }

    // Close file stream
    if (this.stream) {
      const stream = this.stream
      await new Promise<void>((resolve, reject) => {
        stream.end((err: Error | null | undefined) => {
          if (err) reject(err)
          else resolve()
        })
      })
      this.stream = undefined
    }
  }

  private writeEvent(event: RunEvent): void {
    const line = `${JSON.stringify(event)}\n`

    if (this.stdout) {
      process.stdout.write(line)
    } else if (this.stream) {
      this.stream.write(line)
    }
  }
}

/**
 * Create an event emitter from options.
 */
export async function createEventEmitter(options: EventEmitterOptions): Promise<RunEventEmitter> {
  const emitter = new RunEventEmitter(options)
  await emitter.init()
  return emitter
}

/**
 * Determine the events output path for a run.
 *
 * @param artifactDir - Base artifact directory
 * @param runId - Run identifier (optional, uses 'default' if not provided)
 * @returns Path to events.jsonl file
 */
export function getEventsOutputPath(artifactDir: string, runId?: string): string {
  const runDir = runId ?? 'default'
  return `${artifactDir}/runs/${runDir}/events.jsonl`
}
