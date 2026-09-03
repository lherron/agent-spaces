import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { runClaudeHookDecisionBridge } from '../../src/drivers/claude-code-tmux/hook-bridge'
import type { ClaudeCodeHookEnvelope } from '../../src/drivers/claude-code-tmux/hook-events'
import { HRC_MAIL_STOP_SOCKET_ENV, queryMailHintDecision } from '../../src/drivers/mail-stop-gate'
import { listenForHookEnvelopes } from '../../src/drivers/tmux-shared'

const tempRoots: string[] = []

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

const stdin = (text: string): NodeJS.ReadableStream => Readable.from([Buffer.from(text)])

async function startHintDecisionServer(options: {
  response: unknown
  delayMs?: number | undefined
  status?: number | undefined
}): Promise<{
  socketPath: string
  requests: Array<{ url?: string; body: string }>
  close: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'mail-hint-decision-'))
  tempRoots.push(root)
  const socketPath = join(root, 'hrc.sock')
  const requests: Array<{ url?: string; body: string }> = []
  const server = createHttpServer((request, reply) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({ url: request.url, body: Buffer.concat(chunks).toString('utf8') })
      const respond = () => {
        reply.writeHead(options.status ?? 200, { 'content-type': 'application/json' })
        reply.end(JSON.stringify(options.response))
      }
      if (options.delayMs === undefined) respond()
      else setTimeout(respond, options.delayMs)
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return {
    socketPath,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function hookEnv(callbackSocket: string, hrcSocket?: string): Record<string, string> {
  return {
    HARNESS_BROKER_INVOCATION_ID: 'inv-mail-hint',
    HARNESS_BROKER_HOOK_GENERATION: '1',
    HARNESS_BROKER_RUNTIME_ID: 'runtime-mail-hint',
    HARNESS_BROKER_CALLBACK_SOCKET: callbackSocket,
    ...(hrcSocket !== undefined ? { [HRC_MAIL_STOP_SOCKET_ENV]: hrcSocket } : {}),
  }
}

async function runPostToolUse(options: {
  hrcSocket?: string | undefined
}): Promise<{ envelope: ClaudeCodeHookEnvelope | undefined; output: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mail-hint-broker-'))
  tempRoots.push(root)
  const brokerSocket = join(root, 'broker.sock')
  let envelope: ClaudeCodeHookEnvelope | undefined
  let resolveEnvelope: (received: ClaudeCodeHookEnvelope) => void = () => {}
  const envelopeReceived = new Promise<ClaudeCodeHookEnvelope>((resolve) => {
    resolveEnvelope = resolve
  })
  const listener = await listenForHookEnvelopes<ClaudeCodeHookEnvelope>(
    brokerSocket,
    (received) => {
      envelope = received
      resolveEnvelope(received)
    }
  )
  let output = ''
  await runClaudeHookDecisionBridge({
    socketPath: brokerSocket,
    stdin: stdin(JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })),
    env: hookEnv(brokerSocket, options.hrcSocket),
    stdout: {
      write(chunk) {
        output += String(chunk)
        return true
      },
    },
  })
  envelope = await envelopeReceived
  await listener.close()
  return { envelope, output }
}

describe('Claude PostToolUse mail hint bridge', () => {
  test('writes exact additionalContext and records the handed-off hint on the broker envelope', async () => {
    const hint = 'Mail hint from HRC: 2 envelopes are held for this seat. They present at turn end.'
    const hrc = await startHintDecisionServer({
      response: { hint, heldCount: 2, driveAttemptId: 'drive-hint-1', reason: 'first' },
    })
    try {
      const { envelope, output } = await runPostToolUse({ hrcSocket: hrc.socketPath })
      expect(output).toBe(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: hint },
        })
      )
      expect(envelope?.mailHint).toEqual({ hint, driveAttemptId: 'drive-hint-1' })
      expect(hrc.requests).toEqual([
        {
          url: '/v1/internal/mail/hint-decision',
          body: '{"runtimeId":"runtime-mail-hint"}',
        },
      ])
    } finally {
      await hrc.close()
    }
  })

  test('writes nothing and posts the ordinary envelope when HRC returns no hint', async () => {
    const hrc = await startHintDecisionServer({ response: {} })
    try {
      const { envelope, output } = await runPostToolUse({ hrcSocket: hrc.socketPath })
      expect(output).toBe('')
      expect(envelope?.mailHint).toBeUndefined()
      expect(envelope?.hookData).toEqual({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })
    } finally {
      await hrc.close()
    }
  })

  test('times the HRC query out at 250 ms, writes nothing, and still posts to the broker', async () => {
    const hrc = await startHintDecisionServer({
      response: { hint: 'too late', driveAttemptId: 'drive-too-late' },
      delayMs: 1_000,
    })
    try {
      const startedAt = Date.now()
      const { envelope, output } = await runPostToolUse({ hrcSocket: hrc.socketPath })
      const elapsedMs = Date.now() - startedAt
      expect(elapsedMs).toBeGreaterThanOrEqual(200)
      expect(elapsedMs).toBeLessThan(750)
      expect(output).toBe('')
      expect(envelope?.hookData).toEqual({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })
      expect(envelope?.mailHint).toBeUndefined()
    } finally {
      await hrc.close()
    }
  })

  test('does not query HRC when either required environment value is missing', async () => {
    const hrc = await startHintDecisionServer({
      response: { hint: 'must not be read', driveAttemptId: 'drive-unread' },
    })
    try {
      expect(
        await queryMailHintDecision(
          { hook_event_name: 'PostToolUse' },
          { [HRC_MAIL_STOP_SOCKET_ENV]: hrc.socketPath }
        )
      ).toBeUndefined()
      expect(
        await queryMailHintDecision(
          { hook_event_name: 'PostToolUse' },
          { HARNESS_BROKER_RUNTIME_ID: 'runtime-mail-hint' }
        )
      ).toBeUndefined()
      expect(hrc.requests).toEqual([])
    } finally {
      await hrc.close()
    }
  })
})
