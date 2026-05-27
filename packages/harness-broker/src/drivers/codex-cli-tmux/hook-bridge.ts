import { connect } from 'node:net'
import { buildCodexHookEnvelopeFromEnv } from './hook-ingestion'

/**
 * Broker-owned Codex hook bridge for the pre-HRC codex-cli-tmux path.
 *
 * Codex still uses the ASP/HRC hook materialization shape (`hooks.json` command
 * calls `bun "$HRC_LAUNCH_HOOK_CLI"`), but the driver points that env var at a
 * broker-owned wrapper. This bridge reads the raw Codex hook JSON, wraps it in a
 * broker hook envelope, and posts it to the broker callback socket. It never
 * emits hrc-runtime ingest envelopes and has no hrc-runtime dependency.
 */
export interface CodexHookBridgeOptions {
  socketPath: string
  stdin?: NodeJS.ReadableStream | undefined
  env?: Record<string, string | undefined> | undefined
}

export async function runCodexHookBridge(options: CodexHookBridgeOptions): Promise<void> {
  const env = options.env ?? process.env
  const stdin = options.stdin ?? process.stdin
  const raw = await readAll(stdin)
  const hookData = parseHookJson(raw)
  const envelope = buildCodexHookEnvelopeFromEnv(hookData, env)
  await postEnvelope(options.socketPath, envelope)
}

function parseHookJson(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return {}
  try {
    return JSON.parse(trimmed)
  } catch {
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

/** CLI entrypoint: `harness-broker codex-hook --socket <path>`. */
export async function runCodexHookBridgeCli(args: string[]): Promise<void> {
  const socketIdx = args.indexOf('--socket')
  const socketPath = socketIdx !== -1 ? args[socketIdx + 1] : undefined
  if (socketPath === undefined || socketPath.length === 0) {
    process.stderr.write('codex-hook requires --socket <path>\n')
    process.exit(1)
    return
  }
  try {
    await runCodexHookBridge({ socketPath })
  } catch (error) {
    // Codex hooks are observability inputs; do not fail the model turn because
    // the callback socket is unavailable.
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`codex-hook delivery failed: ${message}\n`)
  }
}
