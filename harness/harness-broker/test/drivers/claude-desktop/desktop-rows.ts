/**
 * Claude Desktop transcript rows, shaped after a live desktop session on max3
 * (Claude Code 2.1.330, entrypoint `claude-desktop`, 2026-11-23): queue
 * enqueue/dequeue, a `turnOrigin` user row, one assistant row per content
 * block, and the `stop_hook_summary` system row the app's callback Stop hooks
 * always produce. Fields the observer does not read are trimmed.
 */
const SESSION = 'desktop-session-1'

const line = (row: Record<string, unknown>): string => `${JSON.stringify(row)}\n`

const meta = (uuid: string) => ({
  uuid,
  timestamp: '2026-11-23T21:24:06.504Z',
  userType: 'external',
  entrypoint: 'claude-desktop',
  cwd: '/Users/example/project',
  sessionId: SESSION,
  version: '2.1.330',
})

export const enqueue = (content: string): string =>
  line({ type: 'queue-operation', operation: 'enqueue', sessionId: SESSION, content })

export const dequeue = (): string =>
  line({ type: 'queue-operation', operation: 'dequeue', sessionId: SESSION })

export const removeQueued = (content: string): string =>
  line({
    type: 'queue-operation',
    operation: 'remove',
    sessionId: SESSION,
    content,
    reason: 'absorbed_mid_turn',
  })

export const queuedCommand = (prompt: string, origin?: Record<string, unknown>): string =>
  line({
    ...meta(`att-${prompt.length}`),
    type: 'attachment',
    attachment: { type: 'queued_command', prompt, ...(origin !== undefined ? { origin } : {}) },
  })

export const humanPrompt = (promptId: string, content: string, permissionMode = 'auto'): string =>
  line({
    ...meta(`user-${promptId}`),
    type: 'user',
    promptId,
    permissionMode,
    origin: { kind: 'human' },
    promptSource: 'sdk',
    turnOrigin: 'human',
    clientPlatform: 'desktop_app',
    message: { role: 'user', content },
  })

/** The meta row Claude writes immediately before some turns' opening row. */
export const turnCompanion = (promptId: string): string =>
  line({
    ...meta(`companion-${promptId}`),
    type: 'user',
    promptId,
    isMeta: true,
    turnCompanion: true,
    message: {
      role: 'user',
      content:
        '<system-reminder>\n<tools-used-before-summary>Bash</tools-used-before-summary>\n</system-reminder>',
    },
  })

export const PEER_SUFFIX =
  "\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf. Treat it as a teammate's request."

/** A message written to the session's messaging socket, as the session records it. */
export const peerPrompt = (promptId: string, body: string, verifiedPeerPid = 4242): string =>
  line({
    ...meta(`peer-${promptId}`),
    type: 'user',
    promptId,
    isMeta: true,
    permissionMode: 'auto',
    origin: { kind: 'peer', from: 'unknown', verifiedPeerPid },
    promptSource: 'system',
    turnOrigin: 'peer',
    message: {
      role: 'user',
      content: `Another Claude session sent a message:\n${body}${PEER_SUFFIX}`,
    },
  })

export const assistantText = (
  messageId: string,
  text: string,
  stopReason: 'end_turn' | 'tool_use' = 'end_turn'
): string =>
  line({
    ...meta(`asst-${messageId}-text`),
    type: 'assistant',
    message: {
      id: messageId,
      role: 'assistant',
      model: 'claude-opus-5-5',
      stop_reason: stopReason,
      content: [{ type: 'text', text }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  })

export const assistantToolUse = (messageId: string, toolUseId: string): string =>
  line({
    ...meta(`asst-${messageId}-tool`),
    type: 'assistant',
    message: {
      id: messageId,
      role: 'assistant',
      model: 'claude-opus-5-5',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'ls' } }],
      usage: { input_tokens: 12, output_tokens: 3 },
    },
  })

export const toolResult = (toolUseId: string, output: string): string =>
  line({
    ...meta(`result-${toolUseId}`),
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: output }],
    },
    toolUseResult: { stdout: output, stderr: '', interrupted: false },
  })

export const stopHookSummary = (uuid: string): string =>
  line({
    ...meta(`summary-${uuid}`),
    type: 'system',
    subtype: 'stop_hook_summary',
    hookCount: 2,
    hookInfos: [{ command: 'callback' }, { command: 'callback' }],
    hookErrors: [],
    preventedContinuation: false,
    stopReason: '',
    hasOutput: false,
    level: 'suggestion',
  })

/** Desktop-only bookkeeping rows the shared native-type table does not list. */
export const desktopNoise = (): string =>
  line({ type: 'data-flow-records', v: 1, sessionId: SESSION, records: [], snapshot: true }) +
  line({ type: 'last-prompt', sessionId: SESSION }) +
  line({ type: 'api-request', sessionId: SESSION })

/** One complete typed turn: prompt, a tool call, the answer and the terminal row. */
export function typedTurn(promptId: string, prompt: string, answer: string): string {
  return (
    enqueue(prompt) +
    dequeue() +
    humanPrompt(promptId, prompt) +
    desktopNoise() +
    assistantToolUse(`msg-${promptId}-1`, `tool-${promptId}`) +
    toolResult(`tool-${promptId}`, 'file.txt') +
    assistantText(`msg-${promptId}-2`, answer) +
    stopHookSummary(promptId)
  )
}

export const DESKTOP_SESSION_ID = SESSION

/**
 * The first prompt of a resumed desktop session (live max3, 2026-11-24): a
 * content-less enqueue/dequeue pair, then an opening row whose content is
 * text blocks, a harness system reminder ahead of what was typed.
 */
export function resumedSessionPrompt(promptId: string, typed: string): string {
  return (
    line({ type: 'queue-operation', operation: 'enqueue', sessionId: SESSION }) +
    line({ type: 'queue-operation', operation: 'dequeue', sessionId: SESSION }) +
    line({
      ...meta(`user-${promptId}`),
      type: 'user',
      promptId,
      turnPromptId: promptId,
      permissionMode: 'auto',
      origin: { kind: 'human' },
      promptSource: 'sdk',
      turnOrigin: 'human',
      clientPlatform: 'desktop_app',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<system-reminder>\nThe session "probe" you started finished a turn.\n</system-reminder>',
          },
          { type: 'text', text: typed },
        ],
      },
    })
  )
}
