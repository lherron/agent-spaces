import { parseHookJson, postEnvelope, readAll, runHookBridgeCli } from '../hook-bridge-transport'
import { buildPiHookEnvelopeFromEnv } from './hook-ingestion'

export interface PiHookBridgeOptions {
  socketPath: string
  stdin?: NodeJS.ReadableStream | undefined
  env?: Record<string, string | undefined> | undefined
}

/**
 * Broker-owned Pi hook bridge. The Pi TUI route uses the generated
 * asp-hrc-events.bridge.js extension, but points HRC_LAUNCH_HOOK_CLI at this
 * wrapper instead of HRC. The generated extension forwards Pi lifecycle/message/
 * tool events as JSON; this bridge adds broker invocation identity and posts the
 * envelope to the driver's callback socket.
 */
export async function runPiHookBridge(options: PiHookBridgeOptions): Promise<void> {
  const env = options.env ?? process.env
  const stdin = options.stdin ?? process.stdin
  const raw = await readAll(stdin)
  const hookData = parseHookJson(raw)
  const envelope = buildPiHookEnvelopeFromEnv(hookData, env)
  await postEnvelope(options.socketPath, envelope)
}

/** CLI entrypoint: `harness-broker pi-hook --socket <path>`. */
export async function runPiHookBridgeCli(args: string[]): Promise<void> {
  await runHookBridgeCli({
    commandName: 'pi-hook',
    args,
    run: ({ socketPath }) => runPiHookBridge({ socketPath }),
  })
}
