#!/usr/bin/env bun

/**
 * T-11837: one terminal assistant message per claude-code-tmux turn, however
 * fast the Stop hook returns.
 *
 * Claude Code appends transcript rows behind a 100 ms flush timer, so the
 * turn's closing `assistant` row can still be in memory when the Stop hook
 * reaches the broker. Whether it is depends on how fast the hook path is:
 *
 *   --stop-bridge checkout  the checkout `harness-broker claude-hook` (~120 ms
 *                           Bun startup), what the pre-HRC matrix uses
 *   --stop-bridge compiled  a release-shaped compiled broker whose own binary
 *                           is the hook bridge (~90 ms), what HRC runs
 *   --stop-bridge fast      (default) compiled, but Stop is answered by a small
 *                           shell launcher (jq + curl + perl, ~20 ms) standing
 *                           in for a hook path with no Bun startup in it; like
 *                           the real bridge it waits (up to 1 s) for the reply
 *   --stop-bridge fast-detached
 *                           the same launcher, but it does not wait for the
 *                           broker's reply: Claude moves on and writes the
 *                           turn's closing rows while the Stop is in flight
 *
 * Every mode asks the stub HRC mail endpoint (`HRC_MAIL_STOP_SOCKET`) for the
 * stop decision, which answers after `--stop-delay-ms` (0 is the Rust HRC shape,
 * ~10 the Bun one). The compiled broker is built from THIS checkout.
 *
 * Each turn runs one Bash command then asks for a unique reply token, so every
 * `assistant.message.completed` is assigned to the turn whose token it carries,
 * whichever turn id (if any) it was stamped with. The run passes when every turn
 * has exactly one; it writes summary.json, per-turn.json and events.ndjson.
 *
 * Run with the Claude seat variables stripped:
 *   env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION \
 *     -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u TMUX \
 *     bun scripts/claude-tmux-stop-fallback-e2e.ts --turns 50 --stop-delay-ms 0 --out <dir>
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { BrokerClient } from 'spaces-harness-broker-client'
import type {
  InvocationEventEnvelope,
  InvocationId,
  InvocationRuntimeContext,
} from 'spaces-harness-broker-protocol'

import { allocatePreHrcTmuxPane } from '../compiler/agent-spaces/src/testing/pre-hrc-tmux-allocator.js'
import {
  buildMatrixDispatchOptions,
  compileForMatrix,
  createFixture,
  createRequest,
  realExecutable,
  runTmux,
} from './pre-hrc-broker-matrix-e2e.ts'

const STOP_BRIDGES = ['checkout', 'compiled', 'fast', 'fast-detached'] as const
type StopBridge = (typeof STOP_BRIDGES)[number]

type Args = {
  turns: number
  stopDelayMs: number
  out: string
  turnTimeoutMs: number
  model: string | undefined
  toolSleepS: number
  stopBridge: StopBridge
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    turns: 50,
    stopDelayMs: 0,
    out: '',
    turnTimeoutMs: 120_000,
    model: undefined,
    toolSleepS: 0,
    stopBridge: 'fast',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[++index]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    if (flag === '--turns') args.turns = Number(value)
    else if (flag === '--stop-delay-ms') args.stopDelayMs = Number(value)
    else if (flag === '--out') args.out = value
    else if (flag === '--turn-timeout-ms') args.turnTimeoutMs = Number(value)
    else if (flag === '--model') args.model = value
    else if (flag === '--tool-sleep-s') args.toolSleepS = Number(value)
    else if (flag === '--stop-bridge') {
      if (!STOP_BRIDGES.includes(value as StopBridge)) {
        throw new Error(`--stop-bridge must be one of: ${STOP_BRIDGES.join(', ')}`)
      }
      args.stopBridge = value as StopBridge
    } else throw new Error(`Unknown argument: ${flag}`)
  }
  if (!Number.isSafeInteger(args.turns) || args.turns < 1) throw new Error('--turns must be >= 1')
  if (!Number.isFinite(args.stopDelayMs) || args.stopDelayMs < 0) {
    throw new Error('--stop-delay-ms must be >= 0')
  }
  if (args.out.length === 0) throw new Error('--out <dir> is required')
  return args
}

/** The stub HRC mail-decision endpoint: always allow, after a fixed delay. */
function startStopDecisionStub(socketPath: string, delayMs: number) {
  const calls: Array<{ path: string; atMs: number; answeredInMs: number }> = []
  const server = Bun.serve({
    unix: socketPath,
    async fetch(request) {
      const started = performance.now()
      await request.text()
      if (delayMs > 0) await Bun.sleep(delayMs)
      const path = new URL(request.url).pathname
      calls.push({ path, atMs: Date.now(), answeredInMs: performance.now() - started })
      return Response.json(path.endsWith('/hint-decision') ? {} : { decision: 'allow' })
    },
  })
  return { calls, stop: () => server.stop(true) }
}

const repoRoot = new URL('..', import.meta.url).pathname

/**
 * Compile a release-shaped broker from this checkout. Like
 * scripts/asp-release/entries/harness-broker.ts, its tmux helpers (and so the
 * Claude hook bridge) run from its own binary, unless `helper` replaces them.
 */
async function buildCompiledBroker(dir: string, helper: string | undefined): Promise<string> {
  const entry = join(dir, 'broker-entry.ts')
  const cli = join(repoRoot, 'harness/harness-broker/src/cli.ts')
  const launcher = helper === undefined ? 'process.execPath' : JSON.stringify(helper)
  writeFileSync(
    entry,
    `const { runBrokerCli } = await import(${JSON.stringify(cli)})
await runBrokerCli({
  rendererLauncher: { command: process.execPath, args: ['renderer'] },
  codexTuiLauncher: { command: process.execPath },
  tmuxHelperLauncher: { command: ${launcher} },
})
`
  )
  const outfile = join(dir, 'harness-broker')
  const build = Bun.spawnSync(['bun', 'build', '--compile', '--outfile', outfile, entry], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (build.exitCode !== 0) throw new Error(`broker compile failed: ${build.stderr.toString()}`)
  return outfile
}

/**
 * Hook launcher for `--stop-bridge fast`: answers the Stop decision hook
 * itself with the same envelope and stub query the Bun bridge sends, and hands
 * every other helper invocation to the compiled broker unchanged.
 */
function writeFastStopLauncher(dir: string, broker: string, detached: boolean): string {
  const path = join(dir, 'fast-stop-launcher.sh')
  // `nc -U` returns at stdin EOF without reading the reply; the perl client
  // reads it, capped at the real bridge's 1 s read timeout.
  const send = detached
    ? 'nc -U "$socket"'
    : `perl -MIO::Socket::UNIX -e 'alarm 1; my $s = IO::Socket::UNIX->new(Peer => $ARGV[0]) or exit 0; local $/; my $in = <STDIN>; print $s $in; $s->flush; my $r = <$s>; print $r' "$socket"`
  writeFileSync(
    path,
    `#!/bin/bash
BROKER=${JSON.stringify(broker)}
if [[ "$1" == "claude-hook-decision" ]]; then
  payload=$(cat)
  if [[ "$(jq -r '.hook_event_name // empty' <<<"$payload")" == "Stop" ]]; then
    socket=""
    while [[ $# -gt 0 ]]; do [[ "$1" == "--socket" ]] && socket="$2"; shift; done
    if [[ -n "$HRC_MAIL_STOP_SOCKET" && -n "$HARNESS_BROKER_RUNTIME_ID" ]]; then
      curl -s -m 1 --unix-socket "$HRC_MAIL_STOP_SOCKET" \\
        -d "{\\"runtimeId\\":\\"$HARNESS_BROKER_RUNTIME_ID\\"}" \\
        http://hrc/v1/internal/mail/stop-decision >/dev/null
    fi
    response=$(jq -c \\
      --arg inv "$HARNESS_BROKER_INVOCATION_ID" --arg gen "$HARNESS_BROKER_HOOK_GENERATION" \\
      --arg cb "$HARNESS_BROKER_CALLBACK_SOCKET" --arg rt "$HARNESS_BROKER_RUNTIME_ID" \\
      --arg turn "$HARNESS_BROKER_TURN_ID" \\
      '{invocationId: $inv, generation: ($gen | tonumber), callbackSocket: $cb, hookData: .}
        + (if $rt != "" then {runtimeId: $rt} else {} end)
        + (if $turn != "" then {turnId: $turn} else {} end)' <<<"$payload" | ${send})
    if [[ -n "$response" && "$response" != "ok" ]]; then printf '%s' "$response"; fi
    exit 0
  fi
  printf '%s' "$payload" | exec "$BROKER" "$@"
fi
exec "$BROKER" "$@"
`
  )
  chmodSync(path, 0o755)
  return path
}

/** Keep Claude's own session JSONL beside the events: it is the row-level evidence. */
function copyTranscript(events: InvocationEventEnvelope[], roots: string[], out: string): void {
  const session = events.find((event) => event.type === 'continuation.updated')?.payload as
    | { key?: string }
    | undefined
  if (session?.key === undefined) return
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const match of new Bun.Glob(`**/${session.key}.jsonl`).scanSync({ cwd: root })) {
      copyFileSync(join(root, match), join(out, 'claude-transcript.jsonl'))
      return
    }
  }
}

const isTerminal = (event: InvocationEventEnvelope): boolean =>
  event.type === 'turn.completed' ||
  event.type === 'turn.failed' ||
  event.type === 'turn.interrupted'

const messageText = (event: InvocationEventEnvelope): string =>
  JSON.stringify((event.payload as { content?: unknown }).content ?? '')

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await Bun.sleep(25)
  }
  return predicate()
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(args.out, { recursive: true })
  const runTag = `${Date.now()}`
  const token = (turn: number) => `STOPRACE_${runTag}_T${turn}`
  // A tool call before the reply is the production shape that raced (T-11823
  // restart4: Bash, then the one-word answer).
  const command = (turn: number) =>
    args.toolSleepS > 0
      ? `sleep ${args.toolSleepS}; printf '${token(turn)}'`
      : `printf '${token(turn)}'`
  const prompt = (turn: number) =>
    `Run the Bash command: ${command(turn)} then reply with exactly ${token(turn)} and nothing else.`

  const binary = realExecutable('claude')
  if (binary === undefined) throw new Error('real claude binary is unavailable')
  process.env['ASP_CLAUDE_PATH'] = binary

  const fixture = createFixture('real-claude-tmux')
  const mailSocket = join(fixture.root, 'mail-stop.sock')
  const stub = startStopDecisionStub(mailSocket, args.stopDelayMs)
  const tmuxBin = Bun.which('tmux')
  if (tmuxBin === null) throw new Error('tmux is required')
  const tmuxSocket = join(fixture.root, 'e2e.tmux.sock')
  const tmuxEnv = { ...process.env }
  let broker: BrokerClient | undefined
  let invocationId: InvocationId | undefined
  const events: InvocationEventEnvelope[] = []
  try {
    let brokerCommand: { command: string; args: string[] } = {
      command: process.execPath,
      args: ['harness/harness-broker/bin/harness-broker.js'],
    }
    if (args.stopBridge !== 'checkout') {
      const buildDir = join(fixture.root, 'broker-build')
      const fastDir = join(fixture.root, 'broker-fast')
      mkdirSync(buildDir, { recursive: true })
      mkdirSync(fastDir, { recursive: true })
      let compiled = await buildCompiledBroker(buildDir, undefined)
      if (args.stopBridge === 'fast' || args.stopBridge === 'fast-detached') {
        // The fast launcher delegates to the plain build; the broker it is
        // installed into is a second build whose helpers ARE that launcher.
        const launcher = writeFastStopLauncher(
          fastDir,
          compiled,
          args.stopBridge === 'fast-detached'
        )
        compiled = await buildCompiledBroker(fastDir, launcher)
      }
      brokerCommand = { command: compiled, args: [] }
    }

    const request = createRequest('real-claude-tmux', fixture, `STOPRACE_${runTag}`)
    request.materialization.initialPrompt = prompt(1)
    if (args.model !== undefined) request.requested.model = args.model
    const response = await compileForMatrix('sdk', fixture, request, `STOPRACE_${runTag}`, {
      HRC_MAIL_STOP_SOCKET: mailSocket,
    })
    if (!response.ok) throw new Error(`compile failed: ${JSON.stringify(response.diagnostics)}`)
    const { execution } = response.plan

    await runTmux(tmuxBin, ['-S', tmuxSocket, 'start-server'], tmuxEnv)
    const allocated = await allocatePreHrcTmuxPane({
      tmuxBin,
      socketPath: tmuxSocket,
      sessionName: `stoprace-${runTag}`,
      env: tmuxEnv,
    })
    const terminalSurface: NonNullable<InvocationRuntimeContext['terminalSurface']> =
      allocated.lease

    broker = await BrokerClient.start({
      command: brokerCommand.command,
      args: [...brokerCommand.args, 'run', '--transport', 'stdio'],
      cwd: repoRoot,
    })
    await broker.hello({
      clientInfo: { name: 'claude-tmux-stop-fallback-e2e', version: 'v1' },
      protocolVersions: ['harness-broker/0.2'],
      capabilities: { permissionRequests: true },
    })
    broker.onPermissionRequest(async () => ({ decision: 'deny' }))
    const started = await broker.startInvocationFromRequest(
      execution.dispatchRequest.startRequest,
      buildMatrixDispatchOptions(execution, terminalSurface)
    )
    invocationId = started.invocationId as InvocationId
    const collecting = (async () => {
      for await (const event of started.events) events.push(event)
    })()

    const terminalCount = () => events.filter(isTerminal).length
    for (let turn = 1; turn <= args.turns; turn += 1) {
      if (turn > 1) {
        await broker.input({
          invocationId,
          input: { kind: 'user', content: [{ type: 'text', text: prompt(turn) }] },
        })
      }
      if (!(await waitFor(() => terminalCount() >= turn, args.turnTimeoutMs))) {
        throw new Error(`turn ${turn} reached no terminal within ${args.turnTimeoutMs}ms`)
      }
      console.error(`[stoprace] turn ${turn}/${args.turns} terminal`)
    }
    // A late transcript flush is exactly the defect: give it time to land.
    await Bun.sleep(5_000)
    await broker.dispose({ invocationId }).catch(() => undefined)
    invocationId = undefined
    await broker.close()
    broker = undefined
    await collecting.catch(() => undefined)
  } finally {
    if (broker !== undefined && invocationId !== undefined) {
      await broker.dispose({ invocationId }).catch(() => undefined)
    }
    await broker?.close().catch(() => undefined)
    await runTmux(tmuxBin, ['-S', tmuxSocket, 'kill-server'], tmuxEnv).catch(() => undefined)
    copyTranscript(events, [fixture.root, join(homedir(), '.claude', 'projects')], args.out)
    stub.stop()
    fixture.cleanup()
  }

  const messages = events.filter((event) => event.type === 'assistant.message.completed')
  const perTurn = Array.from({ length: args.turns }, (_, index) => {
    const turn = index + 1
    // Exact-token match: T1 must not also claim T10..T19.
    const needle = new RegExp(`${token(turn)}(?![0-9])`)
    const mine = messages.filter((event) => needle.test(messageText(event)))
    return {
      turn,
      messages: mine.length,
      messageIds: mine.map((event) => (event.payload as { messageId: string }).messageId),
      rawTypes: mine.map((event) => event.driver?.rawType ?? null),
      turnIds: mine.map((event) => event.turnId ?? null),
    }
  })
  const stopCalls = stub.calls.filter((call) => call.path.endsWith('/stop-decision'))
  const summary = {
    schemaVersion: 'claude-tmux-stop-fallback-e2e/v1',
    turns: args.turns,
    stopBridge: args.stopBridge,
    stopDelayMs: args.stopDelayMs,
    model: args.model ?? null,
    toolSleepS: args.toolSleepS,
    stopDecisionCalls: stopCalls.length,
    stopDecisionMaxAnswerMs: Math.max(0, ...stopCalls.map((call) => call.answeredInMs)),
    terminalTurns: events.filter(isTerminal).length,
    assistantMessages: messages.length,
    turnsWithExactlyOne: perTurn.filter((row) => row.messages === 1).length,
    turnsWithDuplicates: perTurn.filter((row) => row.messages > 1).length,
    turnsWithNone: perTurn.filter((row) => row.messages === 0).length,
    fallbackMessages: messages.filter((event) =>
      (event.payload as { messageId: string }).messageId.endsWith('_final')
    ).length,
    transcriptMessages: messages.filter((event) => event.driver?.rawType === 'transcript.assistant')
      .length,
    ok: perTurn.every((row) => row.messages === 1) && stopCalls.length >= args.turns,
  }
  writeFileSync(join(args.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  writeFileSync(join(args.out, 'per-turn.json'), `${JSON.stringify(perTurn, null, 2)}\n`)
  writeFileSync(join(args.out, 'events.ndjson'), events.map((e) => JSON.stringify(e)).join('\n'))
  console.log(JSON.stringify(summary, null, 2))
  if (!summary.ok) process.exitCode = 1
}

await main()
