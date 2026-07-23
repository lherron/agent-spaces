import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { runClaudeHookDecisionBridge } from '../../src/drivers/claude-code-tmux/hook-bridge'
import type { ClaudeCodeHookEnvelope } from '../../src/drivers/claude-code-tmux/hook-events'
import { runCodexHookBridge } from '../../src/drivers/codex-cli-tmux/hook-bridge'
import type { CodexCliTmuxHookEnvelope } from '../../src/drivers/codex-cli-tmux/hook-events'
import { HRC_MAIL_STOP_SOCKET_ENV, queryMailStopDecision } from '../../src/drivers/mail-stop-gate'
import { listenForHookEnvelopes } from '../../src/drivers/tmux-shared'

const tempRoots: string[] = []

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

const stdin = (text: string): NodeJS.ReadableStream => Readable.from([Buffer.from(text)])

async function startMailDecisionServer(response: Record<string, unknown>): Promise<{
  socketPath: string
  requests: Array<{ url?: string; body: string }>
  close: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'mail-stop-decision-'))
  tempRoots.push(root)
  const socketPath = join(root, 'hrc.sock')
  const requests: Array<{ url?: string; body: string }> = []
  const server = createHttpServer((request, reply) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({ url: request.url, body: Buffer.concat(chunks).toString('utf8') })
      reply.writeHead(200, { 'content-type': 'application/json' })
      reply.end(JSON.stringify(response))
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return {
    socketPath,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('mail Stop gate', () => {
  test('queries HRC only for Stop and fails open when the daemon is unreachable', async () => {
    const hrc = await startMailDecisionServer({
      decision: 'block',
      reason: 'Run hrcmail inbox.',
    })
    try {
      const env = {
        HARNESS_BROKER_RUNTIME_ID: 'runtime-mail-stop',
        [HRC_MAIL_STOP_SOCKET_ENV]: hrc.socketPath,
      }
      expect(await queryMailStopDecision({ hook_event_name: 'PreToolUse' }, env)).toBeUndefined()
      expect(hrc.requests).toHaveLength(0)
      expect(await queryMailStopDecision({ hook_event_name: 'Stop' }, env)).toEqual({
        decision: 'block',
        reason: 'Run hrcmail inbox.',
      })
      expect(hrc.requests).toEqual([
        {
          url: '/v1/internal/mail/stop-decision',
          body: '{"runtimeId":"runtime-mail-stop"}',
        },
      ])
    } finally {
      await hrc.close()
    }

    expect(
      await queryMailStopDecision(
        { hook_event_name: 'Stop' },
        {
          HARNESS_BROKER_RUNTIME_ID: 'runtime-mail-stop',
          [HRC_MAIL_STOP_SOCKET_ENV]: '/tmp/hrc-mail-stop-does-not-exist.sock',
        }
      )
    ).toBeUndefined()
  })

  test('Claude and Codex read one broker decision and emit the native block response', async () => {
    const hrc = await startMailDecisionServer({
      decision: 'block',
      reason: 'Drain envelope env_1 with hrcmail inbox.',
    })
    const root = await mkdtemp(join(tmpdir(), 'mail-stop-broker-'))
    tempRoots.push(root)
    const env = {
      HARNESS_BROKER_INVOCATION_ID: 'inv-mail-stop',
      HARNESS_BROKER_HOOK_GENERATION: '1',
      HARNESS_BROKER_RUNTIME_ID: 'runtime-mail-stop',
      HARNESS_BROKER_CALLBACK_SOCKET: '',
      [HRC_MAIL_STOP_SOCKET_ENV]: hrc.socketPath,
    }
    const rawStop = JSON.stringify({ hook_event_name: 'Stop', turn_id: 'turn-mail-stop' })

    try {
      const claudeSocket = join(root, 'claude.sock')
      let claudeEnvelope: ClaudeCodeHookEnvelope | undefined
      const claudeListener = await listenForHookEnvelopes<ClaudeCodeHookEnvelope>(
        claudeSocket,
        (envelope) => {
          claudeEnvelope = envelope
          return envelope.mailStopDecision
        }
      )
      let claudeOutput = ''
      await runClaudeHookDecisionBridge({
        socketPath: claudeSocket,
        stdin: stdin(rawStop),
        env: { ...env, HARNESS_BROKER_CALLBACK_SOCKET: claudeSocket },
        stdout: {
          write(chunk) {
            claudeOutput += String(chunk)
            return true
          },
        },
      })
      await claudeListener.close()
      expect(claudeEnvelope?.mailStopDecision).toEqual({
        decision: 'block',
        reason: 'Drain envelope env_1 with hrcmail inbox.',
      })
      expect(claudeOutput).toBe(
        '{"decision":"block","reason":"Drain envelope env_1 with hrcmail inbox."}'
      )

      const codexSocket = join(root, 'codex.sock')
      let codexEnvelope: CodexCliTmuxHookEnvelope | undefined
      const codexListener = await listenForHookEnvelopes<CodexCliTmuxHookEnvelope>(
        codexSocket,
        (envelope) => {
          codexEnvelope = envelope
          return envelope.mailStopDecision
        }
      )
      let codexOutput = ''
      await runCodexHookBridge({
        socketPath: codexSocket,
        stdin: stdin(rawStop),
        env,
        stdout: {
          write(chunk) {
            codexOutput += String(chunk)
            return true
          },
        },
      })
      await codexListener.close()
      expect(codexEnvelope?.mailStopDecision).toEqual({
        decision: 'block',
        reason: 'Drain envelope env_1 with hrcmail inbox.',
      })
      expect(codexOutput).toBe(
        '{"decision":"block","reason":"Drain envelope env_1 with hrcmail inbox."}'
      )
    } finally {
      await hrc.close()
    }
  })
})
