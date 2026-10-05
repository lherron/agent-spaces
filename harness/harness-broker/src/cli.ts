import { readFile } from 'node:fs/promises'
import type {
  AspReleaseIdentity,
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationInput,
  InvocationStartRequest,
  JsonRpcNotification,
  PermissionDecision,
} from 'spaces-harness-broker-protocol'
import {
  SUPPORTED_BROKER_PROTOCOL_VERSIONS,
  validateInvocationStartRequest,
} from 'spaces-harness-broker-protocol'
import type { BrokerAttachIdentity } from './broker'
import { registerBrokerMethods } from './broker-methods'
import { formatError, readFlag } from './cli-args'
import { createDefaultBroker } from './default-broker'
import {
  runClaudeHookBridgeCli,
  runClaudeHookDecisionBridgeCli,
} from './drivers/claude-code-tmux/hook-bridge'
import type { CodexTuiLauncher } from './drivers/codex-app-server/codex-tui-wrapper'
import type { RendererLauncher } from './drivers/codex-app-server/renderer'
import { runCodexHookBridgeCli } from './drivers/codex-cli-tmux/hook-bridge'
import type { Driver } from './drivers/driver'
import { createEventLedger } from './event-ledger'
import { type BrokerObserverSocket, startBrokerObserverSocket } from './observer-socket'
import { runOfflineEvidenceCli } from './offline-evidence'
import { CAPTURE_USAGE, SUBMISSION_USAGE, captureCommand, submissionCommand } from './operator-cli'
import { createProtocolServer } from './protocol-server'
import type { TmuxHelperLauncher } from './runtime/tmux-launch-exec'
import { type ServedUnixBroker, serveUnixBroker } from './unix-broker'

export interface RunBrokerCliOptions {
  additionalDrivers?: Array<() => Driver> | undefined
  /**
   * Identity of the immutable ASP release this executable was built into
   * (T-08539). Reported in `broker.hello` on every transport.
   */
  releaseIdentity?: AspReleaseIdentity | undefined
  /**
   * T-08554: how this executable's codex-app-server viewer launches its renderer.
   * A standalone release passes its own payload (`<execPath> renderer`) so the
   * viewer runs from the same release as the worker.
   */
  rendererLauncher?: RendererLauncher | undefined
  /**
   * T-08556: how this executable's codex-app-server TUI launches its codex-tui
   * wrapper and codex hook receiver. A standalone release passes its own payload
   * so both run from the same release as the worker.
   */
  codexTuiLauncher?: CodexTuiLauncher | undefined
  /** T-08561: same compiled payload for Claude/Pi hook and tmux helpers. */
  tmuxHelperLauncher?: TmuxHelperLauncher | undefined
}

export async function runBrokerCli(options: RunBrokerCliOptions): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]

  if (command === 'run') {
    const transportIdx = args.indexOf('--transport')
    const transport = transportIdx !== -1 ? args[transportIdx + 1] : undefined

    if (transport === 'stdio') {
      await runStdio(args, options)
    } else if (transport === 'unix') {
      await runUnix(args, options)
    } else {
      process.stderr.write(`Unknown or missing transport: ${transport ?? '(none)'}\n`)
      process.exit(1)
    }
  } else if (command === 'desktop-join') {
    const { runDesktopJoinCli } = await import('./desktop-join-cli.js')
    await runDesktopJoinCli(args.slice(1))
  } else if (command === 'drivers') {
    const json = args.includes('--json')
    const broker = createDefaultBroker(undefined, undefined, {
      additionalDrivers: options.additionalDrivers,
      releaseIdentity: options.releaseIdentity,
      rendererLauncher: options.rendererLauncher,
      codexTuiLauncher: options.codexTuiLauncher,
      tmuxHelperLauncher: options.tmuxHelperLauncher,
    })
    const hello = await broker.hello({
      clientInfo: { name: 'harness-broker-cli' },
      protocolVersions: [...SUPPORTED_BROKER_PROTOCOL_VERSIONS],
    })
    if (json) {
      process.stdout.write(`${JSON.stringify(hello.drivers, null, 2)}\n`)
    } else {
      for (const driver of hello.drivers) {
        process.stdout.write(`${driver.kind}\t${driver.available ? 'available' : 'unavailable'}\n`)
      }
    }
  } else if (command === 'claude-hook') {
    await runClaudeHookBridgeCli(args.slice(1))
  } else if (command === 'claude-hook-decision') {
    await runClaudeHookDecisionBridgeCli(args.slice(1))
  } else if (command === 'codex-hook') {
    await runCodexHookBridgeCli(args.slice(1))
  } else if (command === 'run-once') {
    await runOnce(args.slice(1), options)
  } else if (command === 'validate-start-request') {
    await validateStartRequestCommand(args.slice(1))
  } else if (command === 'tmux-launch') {
    const { runTmuxLaunchCli } = await import('./runtime/tmux-launch-runner.js')
    await runTmuxLaunchCli(args.slice(1))
  } else if (command === 'codex-tui-wrapper') {
    const { runCodexTuiWrapper } = await import('./drivers/codex-app-server/codex-tui-wrapper.js')
    await runCodexTuiWrapper(args.slice(1)).catch((error) => {
      process.stderr.write(
        `codex-tui wrapper failed: ${error instanceof Error ? error.message : String(error)}\n`
      )
      process.exit(1)
    })
  } else if (command === 'renderer') {
    const rest = args.slice(1)
    const driverFlag = rest.indexOf('--driver')
    const driver = driverFlag !== -1 ? rest[driverFlag + 1] : 'codex-app-server'
    if (driver === 'muse-serve') {
      const { runMuseRendererEntry } = await import('./drivers/muse-serve/renderer-entry.js')
      await runMuseRendererEntry(rest)
    } else if (driver === 'codex-app-server') {
      const { runRendererEntry } = await import('./drivers/codex-app-server/renderer-entry.js')
      await runRendererEntry(rest)
    } else {
      process.stderr.write(`Unknown renderer driver: ${driver ?? '(missing)'}\n`)
      process.exit(1)
    }
  } else if (command === 'capture') {
    await captureCommand(args.slice(1))
  } else if (command === 'submission') {
    await submissionCommand(args.slice(1))
  } else if (command === 'evidence-read') {
    await runOfflineEvidenceCli(args.slice(1), options.releaseIdentity)
  } else {
    process.stderr.write(
      `Unknown command: ${command ?? '(none)'}\nUsage: harness-broker run --transport stdio\n${CAPTURE_USAGE}${SUBMISSION_USAGE}`
    )
    process.exit(1)
  }
}

/**
 * `--experimental-observer-socket` / `--experimental-observer-mode` (or their
 * env twins). Exits on a mode other than `observe`, the only one implemented.
 */
function readObserverFlags(args: string[]): { socketPath?: string | undefined; mode: string } {
  const socketPath =
    readFlag(args, '--experimental-observer-socket') ??
    process.env['HARNESS_BROKER_OBSERVER_SOCKET']
  const mode =
    readFlag(args, '--experimental-observer-mode') ??
    process.env['HARNESS_BROKER_OBSERVER_MODE'] ??
    'observe'
  if (socketPath !== undefined && mode !== 'observe') {
    process.stderr.write(
      `Unsupported --experimental-observer-mode ${JSON.stringify(mode)}; only "observe" is implemented\n`
    )
    process.exit(1)
  }
  return { socketPath, mode }
}

async function runStdio(args: string[], options: RunBrokerCliOptions): Promise<void> {
  const { socketPath: observerSocketPath } = readObserverFlags(args)

  const server = createProtocolServer({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  })

  let observer: BrokerObserverSocket | undefined

  function emitEvent(event: InvocationEventEnvelope): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'invocation.event',
      params: event,
    }
    server.notify(notification)
    observer?.notify(event)
  }

  // Wire ask-client permission decisions to the broker→client request transport.
  const eventLedger = createEventLedger()
  const broker = createDefaultBroker(
    emitEvent,
    (params) => server.request<PermissionDecision>('invocation.permission.request', params),
    // Stdio broker event replay is ephemeral and process-local: it backs
    // inspection reads only. The path-backed, controller-fenced durable ledger
    // remains exclusive to the unix transport.
    {
      eventLedger,
      additionalDrivers: options.additionalDrivers,
      releaseIdentity: options.releaseIdentity,
      rendererLauncher: options.rendererLauncher,
      codexTuiLauncher: options.codexTuiLauncher,
      tmuxHelperLauncher: options.tmuxHelperLauncher,
    }
  )

  if (observerSocketPath !== undefined) {
    observer = await startBrokerObserverSocket({ socketPath: observerSocketPath, broker })
  }

  registerBrokerMethods(server, broker, {
    experimentalObserverEnabled: observerSocketPath !== undefined,
  })

  void server.start()

  process.stdin.on('end', () => {
    setImmediate(() => {
      void Promise.all([server.close(), observer?.close()]).then(() => {
        process.exit(0)
      })
    })
  })
}

async function readAttachIdentityFile(attachTokenFile: string): Promise<string> {
  return (await readFile(attachTokenFile, 'utf8')).trim()
}

async function runUnix(args: string[], options: RunBrokerCliOptions): Promise<void> {
  const socketPath = readFlag(args, '--socket')
  if (!socketPath) {
    process.stderr.write('Usage: harness-broker run --transport unix --socket <path>\n')
    process.exit(1)
  }
  const { socketPath: observerSocketPath, mode: observerMode } = readObserverFlags(args)

  // Durability wiring (Phase C1): on-disk event ledger + attach identity gate.
  const ledgerPath = readFlag(args, '--event-ledger')
  const runtimeId = readFlag(args, '--runtime-id')
  const hostSessionId = readFlag(args, '--host-session-id')
  const generationRaw = readFlag(args, '--generation')
  const attachTokenFile = readFlag(args, '--attach-token-file')

  let attachIdentity: BrokerAttachIdentity | undefined
  if (
    runtimeId !== undefined &&
    hostSessionId !== undefined &&
    generationRaw !== undefined &&
    attachTokenFile !== undefined
  ) {
    attachIdentity = {
      runtimeId,
      hostSessionId,
      generation: Number(generationRaw),
      attachToken: await readAttachIdentityFile(attachTokenFile),
    }
  }

  // Participant-served startup posture (DESIGN rev6 C.5). EXPLICIT on purpose:
  // a unix broker launched without identity flags is an existing supported
  // non-participant route, so bootstrap posture is declared by the launcher and
  // never inferred from the absence of `--runtime-id`.
  const joinRaw = readFlag(args, '--join') ?? 'hrc-hosted'
  if (joinRaw !== 'hrc-hosted' && joinRaw !== 'participant-served') {
    process.stderr.write(
      `Unsupported --join ${JSON.stringify(joinRaw)}; expected "hrc-hosted" or "participant-served"\n`
    )
    process.exit(1)
  }

  let served: ServedUnixBroker
  try {
    served = await serveUnixBroker({
      socketPath,
      cliOptions: options,
      ...(ledgerPath === undefined ? {} : { ledgerPath }),
      ...(observerSocketPath === undefined ? {} : { observerSocketPath }),
      observerMode,
      participantBootstrap: joinRaw === 'participant-served',
      ...(attachIdentity === undefined ? {} : { attachIdentity }),
    })
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }

  const shutdown = (): void => {
    void served.close().then(() => {
      process.exit(0)
    })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  await new Promise<void>(() => {})
}

async function runOnce(args: string[], options: RunBrokerCliOptions): Promise<void> {
  let request: InvocationStartRequest
  try {
    request = await loadStartRequest(args)
  } catch (err) {
    process.stderr.write(`${formatError(err)}\n`)
    process.exit(1)
  }

  let resolveTurnDone: (() => void) | undefined
  const turnDone = new Promise<void>((resolve) => {
    resolveTurnDone = resolve
  })

  const broker = createDefaultBroker(
    (event) => {
      process.stdout.write(`${JSON.stringify(event)}\n`)
      if (
        event.type === 'turn.completed' ||
        event.type === 'turn.failed' ||
        event.type === 'turn.interrupted'
      ) {
        resolveTurnDone?.()
      }
    },
    undefined,
    {
      additionalDrivers: options.additionalDrivers,
      tmuxHelperLauncher: options.tmuxHelperLauncher,
    }
  )

  // Same path the BrokerClient drives: a single InvocationStartRequest with its
  // initialInput carries the first turn — no separate invocation.input call.
  const start = await broker.start(request)
  await turnDone
  await broker.stop({
    invocationId: start.invocationId,
    reason: 'run-once complete',
    graceMs: request.spec.process.limits?.stopGraceMs ?? 500,
  })
  await broker.dispose({ invocationId: start.invocationId })
}

/**
 * Resolve a single InvocationStartRequest from CLI flags. `--start-request`
 * (the ASP compiler's output shape) is preferred; `--spec`/`--input` is kept
 * for backward compatibility and folded into the same request shape. The
 * request is validated before it reaches the broker.
 */
async function loadStartRequest(args: string[]): Promise<InvocationStartRequest> {
  const startRequestPath = readFlag(args, '--start-request')
  if (startRequestPath) {
    const raw = (await Bun.file(startRequestPath).json()) as unknown
    return validateInvocationStartRequest(raw)
  }

  const specPath = readFlag(args, '--spec')
  const inputPath = readFlag(args, '--input')
  if (specPath && inputPath) {
    const spec = (await Bun.file(specPath).json()) as HarnessInvocationSpec
    const initialInput = (await Bun.file(inputPath).json()) as InvocationInput
    return validateInvocationStartRequest({ spec, initialInput })
  }

  throw new Error(
    'Usage: harness-broker run-once (--start-request start-request.json | --spec invocation.json --input input.json)'
  )
}

async function validateStartRequestCommand(args: string[]): Promise<void> {
  const filePath = readFlag(args, '--file')
  if (!filePath) {
    process.stderr.write('Usage: harness-broker validate-start-request --file start-request.json\n')
    process.exit(1)
  }

  try {
    const raw = (await Bun.file(filePath).json()) as unknown
    validateInvocationStartRequest(raw)
  } catch (err) {
    process.stderr.write(`${formatError(err)}\n`)
    process.exit(1)
  }

  process.stdout.write('valid\n')
}
