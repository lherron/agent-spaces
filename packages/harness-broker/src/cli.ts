import type {
  HarnessInvocationSpec,
  InvocationDispatchRequest,
  InvocationEventEnvelope,
  InvocationInput,
  InvocationStartRequest,
  JsonRpcNotification,
  PermissionDecision,
} from 'spaces-harness-broker-protocol'
import { validateCommand, validateInvocationStartRequest } from 'spaces-harness-broker-protocol'
import { createDefaultBroker } from './default-broker'
import { runClaudeHookBridgeCli } from './drivers/claude-code-tmux/hook-bridge'
import { runCodexHookBridgeCli } from './drivers/codex-cli-tmux/hook-bridge'
import { createProtocolServer } from './protocol-server'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]

  if (command === 'run') {
    const transportIdx = args.indexOf('--transport')
    const transport = transportIdx !== -1 ? args[transportIdx + 1] : undefined

    if (transport !== 'stdio') {
      process.stderr.write(`Unknown or missing transport: ${transport ?? '(none)'}\n`)
      process.exit(1)
    }

    runStdio()
  } else if (command === 'drivers') {
    const json = args.includes('--json')
    const broker = createDefaultBroker()
    const hello = await broker.hello({
      clientInfo: { name: 'harness-broker-cli' },
      protocolVersions: ['harness-broker/0.1'],
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
  } else if (command === 'codex-hook') {
    await runCodexHookBridgeCli(args.slice(1))
  } else if (command === 'run-once') {
    await runOnce(args.slice(1))
  } else if (command === 'validate-start-request') {
    await validateStartRequestCommand(args.slice(1))
  } else {
    process.stderr.write(
      `Unknown command: ${command ?? '(none)'}\nUsage: harness-broker run --transport stdio\n`
    )
    process.exit(1)
  }
}

function runStdio(): void {
  const server = createProtocolServer({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  })

  function emitEvent(event: InvocationEventEnvelope): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'invocation.event',
      params: event,
    }
    server.notify(notification)
  }

  // Wire ask-client permission decisions to the broker→client request transport.
  const broker = createDefaultBroker(emitEvent, (params) =>
    server.request<PermissionDecision>('invocation.permission.request', params)
  )

  function validateParams(method: string, id: string | number | null, params: unknown): void {
    validateCommand({ jsonrpc: '2.0', id, method, params })
  }

  server.register('broker.hello', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.hello(params as Parameters<typeof broker.hello>[0])
  })

  server.register('broker.health', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.health((params ?? {}) as Parameters<typeof broker.health>[0])
  })

  server.register('invocation.start', async ({ id, method, params }) => {
    // validateCommand validates the full InvocationDispatchRequest envelope
    // (including dispatchEnv key-class + lockedEnv-shadow rules) before dispatch.
    validateParams(method, id, params)
    const dispatch = params as InvocationDispatchRequest
    return broker.start(
      dispatch.startRequest,
      dispatch.dispatchEnv,
      dispatch.runtime,
      dispatch.lifecyclePolicy
    )
  })

  server.register('invocation.input', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.input(params as Parameters<typeof broker.input>[0])
  })

  server.register('invocation.interrupt', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.interrupt(params as Parameters<typeof broker.interrupt>[0])
  })

  server.register('invocation.stop', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.stop(params as Parameters<typeof broker.stop>[0])
  })

  server.register('invocation.status', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.status(params as Parameters<typeof broker.status>[0])
  })

  server.register('invocation.dispose', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.dispose(params as Parameters<typeof broker.dispose>[0])
  })

  void server.start()

  process.stdin.on('end', () => {
    void server.close().then(() => {
      process.exit(0)
    })
  })
}

async function runOnce(args: string[]): Promise<void> {
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

  const broker = createDefaultBroker((event) => {
    process.stdout.write(`${JSON.stringify(event)}\n`)
    if (
      event.type === 'turn.completed' ||
      event.type === 'turn.failed' ||
      event.type === 'turn.interrupted'
    ) {
      resolveTurnDone?.()
    }
  })

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

function formatError(err: unknown): string {
  if (err && typeof err === 'object' && 'issues' in err) {
    const message = err instanceof Error ? err.message : 'Validation failed'
    return `${message}\n${JSON.stringify((err as { issues: unknown }).issues, null, 2)}`
  }
  return err instanceof Error ? err.message : String(err)
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

void main()
