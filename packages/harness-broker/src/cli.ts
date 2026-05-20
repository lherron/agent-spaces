import { createBroker } from './broker'
import { createCodexAppServerDriver } from './drivers/codex-app-server/driver'
import { createProtocolServer } from './protocol-server'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationInput,
  JsonRpcNotification,
} from 'spaces-harness-broker-protocol'

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
  } else if (command === 'run-once') {
    await runOnce(args.slice(1))
  } else {
    process.stderr.write(
      `Unknown command: ${command ?? '(none)'}\nUsage: harness-broker run --transport stdio\n`
    )
    process.exit(1)
  }
}

function createDefaultBroker(onEvent?: (event: InvocationEventEnvelope) => void) {
  return createBroker({
    drivers: [createCodexAppServerDriver()],
    ...(onEvent !== undefined ? { onEvent } : {}),
  })
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

  const broker = createDefaultBroker(emitEvent)

  server.register('broker.hello', async ({ params }) => {
    return broker.hello(params as Parameters<typeof broker.hello>[0])
  })

  server.register('broker.health', async ({ params }) => {
    return broker.health((params ?? {}) as Parameters<typeof broker.health>[0])
  })

  server.register('invocation.start', async ({ params }) => {
    return broker.start(params as Parameters<typeof broker.start>[0])
  })

  server.register('invocation.input', async ({ params }) => {
    return broker.input(params as Parameters<typeof broker.input>[0])
  })

  server.register('invocation.interrupt', async ({ params }) => {
    return broker.interrupt(params as Parameters<typeof broker.interrupt>[0])
  })

  server.register('invocation.stop', async ({ params }) => {
    return broker.stop(params as Parameters<typeof broker.stop>[0])
  })

  server.register('invocation.status', async ({ params }) => {
    return broker.status(params as Parameters<typeof broker.status>[0])
  })

  server.register('invocation.dispose', async ({ params }) => {
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
  const specPath = readFlag(args, '--spec')
  const inputPath = readFlag(args, '--input')
  if (!specPath || !inputPath) {
    process.stderr.write('Usage: harness-broker run-once --spec invocation.json --input input.json\n')
    process.exit(1)
  }

  const spec = (await Bun.file(specPath).json()) as HarnessInvocationSpec
  const input = (await Bun.file(inputPath).json()) as InvocationInput
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

  const start = await broker.start({ spec })
  await broker.input({
    invocationId: start.invocationId,
    input,
    policy: { whenBusy: 'reject' },
  })
  await turnDone
  await broker.stop({
    invocationId: start.invocationId,
    reason: 'run-once complete',
    graceMs: spec.process.limits?.stopGraceMs ?? 500,
  })
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

void main()
