import {
  parseHookJson,
  postEnvelopeAndRead,
  readAll,
  runHookBridgeCli,
} from '../hook-bridge-transport'
import { queryMailStopDecision } from '../mail-stop-gate'
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
  stdout?: Pick<NodeJS.WriteStream, 'write'> | undefined
}

export async function runCodexHookBridge(options: CodexHookBridgeOptions): Promise<void> {
  const env = options.env ?? process.env
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const raw = await readAll(stdin)
  const hookData = parseHookJson(raw)
  const mailStopDecision = await queryMailStopDecision(hookData, env)
  const envelope = buildCodexHookEnvelopeFromEnv(hookData, env)
  const response = await postEnvelopeAndRead(options.socketPath, {
    ...envelope,
    ...(mailStopDecision !== undefined ? { mailStopDecision } : {}),
  })
  const decision = parseBrokerStopDecision(response)
  if (decision !== undefined) {
    stdout.write(JSON.stringify({ decision: 'block', reason: decision.reason }))
  }
}

function parseBrokerStopDecision(raw: string): { reason: string } | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed === 'ok') return undefined
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isRecord(parsed) || parsed['decision'] !== 'block') return undefined
    const reason = parsed['reason']
    return typeof reason === 'string' && reason.length > 0 ? { reason } : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** CLI entrypoint: `harness-broker codex-hook --socket <path>`. */
export async function runCodexHookBridgeCli(args: string[]): Promise<void> {
  await runHookBridgeCli({
    commandName: 'codex-hook',
    args,
    run: ({ socketPath }) => runCodexHookBridge({ socketPath }),
  })
}
