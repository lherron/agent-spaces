import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

type BridgeRunner = (options: {
  socketPath: string
  stdin?: NodeJS.ReadableStream | undefined
  env?: Record<string, string | undefined> | undefined
}) => Promise<void>

const tempRoots: string[] = []

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

const loadClaudeBridge = async (): Promise<BridgeRunner> => {
  const target = (await import('../../src/drivers/claude-code-tmux/hook-bridge')) as {
    runClaudeHookBridge: BridgeRunner
  }
  return target.runClaudeHookBridge
}

const loadCodexBridge = async (): Promise<BridgeRunner> => {
  const target = (await import('../../src/drivers/codex-cli-tmux/hook-bridge')) as {
    runCodexHookBridge: BridgeRunner
  }
  return target.runCodexHookBridge
}

const captureOnePost = async (): Promise<{
  socketPath: string
  bytes: Promise<string>
  close: () => Promise<void>
}> => {
  const root = await mkdtemp(join(tmpdir(), 'hook-bridge-bytes-'))
  tempRoots.push(root)
  const socketPath = join(root, 'hook.sock')
  let resolveBytes: (value: string) => void = () => {}
  const bytes = new Promise<string>((resolve) => {
    resolveBytes = resolve
  })
  const server = createServer((conn) => {
    const chunks: Buffer[] = []
    conn.on('data', (chunk: Buffer) => chunks.push(chunk))
    conn.on('end', () => {
      resolveBytes(Buffer.concat(chunks).toString('utf8'))
      conn.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return {
    socketPath,
    bytes,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const stdin = (text: string): NodeJS.ReadableStream => Readable.from([Buffer.from(text)])

describe('hook bridge transport characterization (T-04626/T-04628)', () => {
  test('Claude bridge posts byte-identical JSON envelope with required callbackSocket', async () => {
    const runBridge = await loadClaudeBridge()
    const capture = await captureOnePost()
    try {
      await runBridge({
        socketPath: capture.socketPath,
        stdin: stdin('{"hook_event_name":"PreToolUse","tool_input":{"command":"pwd"}}\n'),
        env: {
          HARNESS_BROKER_INVOCATION_ID: 'inv_bridge_claude',
          HARNESS_BROKER_HOOK_GENERATION: '7',
          HARNESS_BROKER_CALLBACK_SOCKET: capture.socketPath,
          HARNESS_BROKER_RUNTIME_ID: 'rt_bridge_claude',
          HARNESS_BROKER_TURN_ID: 'turn_bridge_claude',
        },
      })

      // Characterization guard: this exact byte sequence is the transport contract
      // the shared bridge extraction must preserve, including key order.
      expect(await capture.bytes).toBe(
        `{"invocationId":"inv_bridge_claude","generation":7,"callbackSocket":"${capture.socketPath}","runtimeId":"rt_bridge_claude","turnId":"turn_bridge_claude","hookData":{"hook_event_name":"PreToolUse","tool_input":{"command":"pwd"}}}`
      )
    } finally {
      await capture.close()
    }
  })

  test('Codex bridge posts byte-identical JSON envelope and keeps callbackSocket optional', async () => {
    const runBridge = await loadCodexBridge()
    const capture = await captureOnePost()
    try {
      await runBridge({
        socketPath: capture.socketPath,
        stdin: stdin('not-json hook payload\n'),
        env: {
          HARNESS_BROKER_INVOCATION_ID: 'inv_bridge_codex',
          HARNESS_BROKER_HOOK_GENERATION: '3',
          HARNESS_BROKER_RUNTIME_ID: 'rt_bridge_codex',
          HARNESS_BROKER_TURN_ID: 'turn_bridge_codex',
        },
      })

      // Codex currently differs from Claude: HARNESS_BROKER_CALLBACK_SOCKET is
      // not required for envelope construction, even though socketPath is used
      // as the transport destination. Pin that divergence during extraction.
      expect(await capture.bytes).toBe(
        '{"invocationId":"inv_bridge_codex","generation":3,"runtimeId":"rt_bridge_codex","turnId":"turn_bridge_codex","hookData":{"raw":"not-json hook payload"}}'
      )
    } finally {
      await capture.close()
    }
  })

  test('empty stdin is parsed as an empty hook object before posting', async () => {
    const runBridge = await loadCodexBridge()
    const capture = await captureOnePost()
    try {
      await runBridge({
        socketPath: capture.socketPath,
        stdin: stdin(' \n\t '),
        env: {
          HARNESS_BROKER_INVOCATION_ID: 'inv_empty',
          HARNESS_BROKER_HOOK_GENERATION: '1',
        },
      })

      expect(await capture.bytes).toBe('{"invocationId":"inv_empty","generation":1,"hookData":{}}')
    } finally {
      await capture.close()
    }
  })
})
