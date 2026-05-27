import { connect } from 'node:net'
import { buildHookEnvelopeFromEnv } from './hook-ingestion'

/**
 * Broker-owned Claude hook bridge (H3). The `claude-code-tmux` driver installs
 * a `--settings` hook overlay whose commands invoke this bridge for each Claude
 * hook event (`UserPromptSubmit`/`MessageDisplay`/`PreToolUse`/`Stop`/…). The
 * bridge reads the raw hook JSON on stdin, wraps it in a hook ENVELOPE built
 * from the `HARNESS_BROKER_*` launch env (the real turn id lives at the env
 * level, not in the raw hook JSON — cody's Phase 3 seam), and writes the
 * envelope to the broker callback unix socket.
 *
 * This is the REAL runtime path: there is no hrc-runtime dependency and no TUI
 * stdout parsing — Claude posts hooks out-of-band to the broker socket.
 */
export interface HookBridgeOptions {
  socketPath: string
  stdin?: NodeJS.ReadableStream | undefined
  env?: Record<string, string | undefined> | undefined
}

export async function runClaudeHookBridge(options: HookBridgeOptions): Promise<void> {
  const env = options.env ?? process.env
  const stdin = options.stdin ?? process.stdin
  const raw = await readAll(stdin)
  const hookData = parseHookJson(raw)
  const envelope = buildHookEnvelopeFromEnv(hookData, env)
  await postEnvelope(options.socketPath, envelope)
}

function parseHookJson(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return {}
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    // A non-JSON hook payload is still forwarded verbatim so the broker can see
    // (and diagnose) it rather than silently dropping the event.
    return { raw: trimmed }
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function postEnvelope(socketPath: string, envelope: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const conn = connect(socketPath)
    conn.on('error', reject)
    conn.on('connect', () => {
      conn.end(JSON.stringify(envelope))
    })
    conn.on('close', () => resolve())
  })
}

/** CLI entrypoint: `harness-broker claude-hook --socket <path>`. */
export async function runClaudeHookBridgeCli(args: string[]): Promise<void> {
  const socketIdx = args.indexOf('--socket')
  const socketPath = socketIdx !== -1 ? args[socketIdx + 1] : undefined
  if (socketPath === undefined || socketPath.length === 0) {
    process.stderr.write('claude-hook requires --socket <path>\n')
    process.exit(1)
    return
  }
  try {
    await runClaudeHookBridge({ socketPath })
  } catch (error) {
    // Never fail the Claude turn because the broker socket is unavailable: the
    // hook is best-effort observability, not a turn gate.
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`claude-hook delivery failed: ${message}\n`)
  }
}
