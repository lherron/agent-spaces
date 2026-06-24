import {
  parseHookJson,
  postEnvelope,
  postEnvelopeAndRead,
  readAll,
  runHookBridgeCli,
} from '../hook-bridge-transport'
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

export async function runClaudeHookDecisionBridge(options: HookBridgeOptions): Promise<void> {
  const env = options.env ?? process.env
  const stdin = options.stdin ?? process.stdin
  const raw = await readAll(stdin)
  const hookData = parseHookJson(raw)
  const envelope = buildHookEnvelopeFromEnv(hookData, env)
  const response = await postEnvelopeAndRead(options.socketPath, envelope)
  const decision = parseClaudeHookDecisionResponse(response)
  if (decision !== undefined) {
    process.stdout.write(JSON.stringify(decision))
  }
}

function parseClaudeHookDecisionResponse(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed === 'ok') {
    return undefined
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isRecord(parsed)) {
      return undefined
    }
    if (
      typeof parsed['decision'] === 'string' ||
      typeof parsed['continue'] === 'boolean' ||
      typeof parsed['stopReason'] === 'string' ||
      typeof parsed['suppressOutput'] === 'boolean'
    ) {
      return parsed
    }
  } catch {
    return undefined
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** CLI entrypoint: `harness-broker claude-hook --socket <path>`. */
export async function runClaudeHookBridgeCli(args: string[]): Promise<void> {
  await runHookBridgeCli({
    commandName: 'claude-hook',
    args,
    run: ({ socketPath }) => runClaudeHookBridge({ socketPath }),
  })
}

/** CLI entrypoint: `harness-broker claude-hook-decision --socket <path>`. */
export async function runClaudeHookDecisionBridgeCli(args: string[]): Promise<void> {
  await runHookBridgeCli({
    commandName: 'claude-hook-decision',
    args,
    run: ({ socketPath }) => runClaudeHookDecisionBridge({ socketPath }),
  })
}
