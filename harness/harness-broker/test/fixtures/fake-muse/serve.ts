/**
 * Fake `muse serve` peer for muse-serve driver tests (T-08589).
 *
 * Speaks the spike-probed MSP surface over newline-delimited JSON-RPC:
 * initialize → initialized → session/start|resume → turn/start|steer|interrupt.
 * Scenarios via argv[2]:
 * - ok: turn runs to completed with usage + an agentMessage item.
 * - long: turn stays running until turn/interrupt (→ cancelled) or turn/cancel.
 * - approve: turn opens an approval/request; the decided choiceId is echoed in
 *   the closing agentMessage text, then the turn completes.
 * - bad-fingerprint: initialize answers a non-matching schema fingerprint.
 */
import { MSP_SCHEMA_FINGERPRINT } from '../../../src/drivers/muse-serve/driver'

process.on('SIGTERM', () => {
  process.exit(0)
})

const scenario = process.argv[2] ?? 'ok'

interface RpcMessage {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: Record<string, unknown>
}

let buffer = ''
let nextServerId = 9000
let sessionId = ''
let activeTurn: string | undefined
let cursor = 0

const viewCursor = (): string => {
  cursor += 1
  return `v:${sessionId}:${cursor}`
}

const sourceRange = (): Record<string, unknown> => ({
  stream: { kind: 'session', id: sessionId },
  first: { id: 'rec-1', sequence: 1 },
  last: { id: 'rec-1', sequence: 1 },
})

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function notify(method: string, params: Record<string, unknown>): void {
  send({ jsonrpc: '2.0', method, params })
}

function respond(id: number, result: unknown): void {
  send({ jsonrpc: '2.0', id, result })
}

function respondError(id: number, code: number, message: string, data?: unknown): void {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } })
}

function commandRejected(id: number, commandId: string, reason: string): void {
  respondError(id, -32030, `command rejected: ${reason}`, {
    kind: 'commandRejected',
    retryable: false,
    commandId,
    reason,
  })
}

function completeTurn(turnId: string, terminal: 'completed' | 'cancelled', text?: string): void {
  if (text !== undefined) {
    notify('item/completed', {
      sessionId,
      viewCursor: viewCursor(),
      sourceRange: sourceRange(),
      item: {
        itemId: 'item-agent-1',
        kind: 'agentMessage',
        turnId,
        revision: 1,
        status: 'completed',
        text,
      },
    })
  }
  notify('session/statusChanged', { sessionId, status: 'idle', viewCursor: viewCursor() })
  notify('turn/completed', {
    sessionId,
    viewCursor: viewCursor(),
    sourceRange: sourceRange(),
    turnId,
    terminal,
    durationMs: 5,
    ...(terminal === 'completed'
      ? { usage: { inputTokens: 10, outputTokens: 4 } }
      : { reason: 'interrupted by test' }),
  })
  if (activeTurn === turnId) activeTurn = undefined
}

async function handleApproval(turnId: string): Promise<void> {
  nextServerId += 1
  const serverId = nextServerId
  const approvalId = 'apr-1'
  const params = {
    approvalId,
    availableChoices: [
      { choiceId: 'allow-once', decision: 'approved', label: 'Allow once', scope: 'turn' },
      { choiceId: 'deny-once', decision: 'denied', label: 'Deny', scope: 'turn' },
    ],
    currentRequirementId: 'req-1',
    itemId: 'item-tool-1',
    judgeEscalated: false,
    protectedWrite: false,
    rawArgs: 'ls /tmp',
    sessionId,
    sourceRange: sourceRange(),
    subject: { tool: 'shell', command: 'ls /tmp' },
    taskId: 'task-1',
    toolCallId: 'call-1',
    toolName: 'shell',
    turnId,
    viewCursor: viewCursor(),
  }
  const decided = new Promise<string>((resolve) => {
    pendingDecide.set(approvalId, resolve)
  })
  send({ jsonrpc: '2.0', id: serverId, method: 'approval/request', params })
  const choiceId = await decided
  completeTurn(turnId, 'completed', `decided:${choiceId}`)
}

const pendingDecide = new Map<string, (choiceId: string) => void>()

async function handle(message: RpcMessage): Promise<void> {
  if (message.id === undefined) {
    return
  }
  if (message.id !== undefined && message.method === undefined) {
    const result = (message as { result?: unknown }).result as Record<string, unknown> | undefined
    void result
    return
  }
  const method = message.method
  const params = message.params ?? {}
  const id = message.id as number
  switch (method) {
    case 'initialize': {
      respond(id, {
        serverInfo: { name: 'muse', version: '9.9.9-fake' },
        userAgent: 'fake-muse/9.9.9',
        museHome: '/tmp/fake-muse-home/.local/share/muse',
        platformFamily: 'unix',
        platformOs: 'macos',
        schema: {
          version: 1,
          fingerprint: scenario === 'bad-fingerprint' ? 'sha256:deadbeef' : MSP_SCHEMA_FINGERPRINT,
        },
        grantedCapabilities: [],
        experimentalApi: false,
        sessionDurability: 'durable',
      })
      return
    }
    case 'session/start': {
      sessionId = 'sess_fake_1'
      respond(id, {
        session: {
          sessionId,
          path: '/tmp/fake/session.jsonl',
          status: 'idle',
          activeTurnId: null,
          workspaceRoot: params['workspaceRoot'],
          providerId: 'echo',
          modelId: null,
          turnCount: 0,
          forkedFrom: null,
          approvalMode: { mode: params['approvalMode'] ?? 'onRequest', source: 'startup' },
        },
      })
      notify('session/started', { session: { sessionId, status: 'idle' } })
      return
    }
    case 'session/resume': {
      if (params['sessionId'] === 'sess_known') {
        sessionId = 'sess_known'
        respond(id, { session: { sessionId, status: 'idle' }, history: { mode: 'none' } })
      } else {
        commandRejected(id, String(params['commandId'] ?? ''), 'missing_session')
      }
      return
    }
    case 'turn/start': {
      const commandId = String(params['commandId'] ?? '')
      const turnId = commandId
      activeTurn = turnId
      respond(id, {
        commandId,
        status: 'accepted',
        turnId,
        startedNewTurn: true,
        disposition: 'started',
      })
      notify('turn/started', {
        sessionId,
        viewCursor: viewCursor(),
        sourceRange: sourceRange(),
        turnId,
        commandId,
      })
      notify('session/statusChanged', { sessionId, status: 'running', viewCursor: viewCursor() })
      if (scenario === 'ok') {
        setTimeout(() => completeTurn(turnId, 'completed', 'fake done'), 20)
      } else if (scenario === 'approve') {
        setTimeout(() => void handleApproval(turnId), 20)
      } else if (scenario === 'multi') {
        setTimeout(() => {
          notify('item/delta', {
            sessionId,
            itemId: 'item-agent-stream',
            turnId,
            field: 'text',
            delta: 'streamed run ',
          })
          for (const text of ['first message', 'second message']) {
            notify('item/completed', {
              sessionId,
              viewCursor: viewCursor(),
              sourceRange: sourceRange(),
              item: {
                itemId: `item-agent-${text}`,
                kind: 'agentMessage',
                turnId,
                revision: 1,
                status: 'completed',
                text,
              },
            })
          }
          completeTurn(turnId, 'completed')
        }, 20)
      }
      return
    }
    case 'turn/steer': {
      const expected = String(params['expectedTurnId'] ?? '')
      const commandId = String(params['commandId'] ?? '')
      if (activeTurn === undefined || activeTurn !== expected) {
        commandRejected(id, commandId, 'missing_run')
        return
      }
      respond(id, { commandId, status: 'accepted', turnId: activeTurn })
      notify('item/delta', {
        sessionId,
        itemId: 'item-agent-1',
        turnId: activeTurn,
        field: 'text',
        delta: 'steered',
      })
      return
    }
    case 'turn/interrupt':
    case 'turn/cancel': {
      const commandId = String(params['commandId'] ?? '')
      const target = (params['turnId'] as string | undefined) ?? activeTurn
      if (target === undefined || target !== activeTurn) {
        commandRejected(id, commandId, 'missing_run')
        return
      }
      respond(id, { commandId, status: 'accepted' })
      completeTurn(target, 'cancelled')
      return
    }
    case 'approval/decide': {
      respond(id, { commandId: params['commandId'], status: 'accepted' })
      const resolve = pendingDecide.get(String(params['approvalId'] ?? ''))
      resolve?.(String(params['choiceId'] ?? ''))
      return
    }
    default: {
      respondError(id, -32601, `fake-muse: unknown method ${method}`)
    }
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  while (true) {
    const index = buffer.indexOf('\n')
    if (index < 0) return
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    void handle(JSON.parse(line) as RpcMessage)
  }
})
