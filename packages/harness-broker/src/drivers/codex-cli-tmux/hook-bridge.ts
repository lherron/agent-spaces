import { parseHookJson, postEnvelope, readAll, runHookBridgeCli } from '../hook-bridge-transport'
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

/** CLI entrypoint: `harness-broker codex-hook --socket <path>`. */
export async function runCodexHookBridgeCli(args: string[]): Promise<void> {
  await runHookBridgeCli({
    commandName: 'codex-hook',
    args,
    run: ({ socketPath }) => runCodexHookBridge({ socketPath }),
  })
}
