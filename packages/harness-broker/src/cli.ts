import { createBroker } from './broker'
import { createProtocolServer } from './protocol-server'
import type { InvocationEventEnvelope, JsonRpcNotification } from 'spaces-harness-broker-protocol'

function main(): void {
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
  } else {
    process.stderr.write(`Unknown command: ${command ?? '(none)'}\nUsage: harness-broker run --transport stdio\n`)
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

  const broker = createBroker({
    drivers: [],
    onEvent: emitEvent,
  })

  server.register('broker.hello', async ({ params }) => {
    return broker.hello(params as Parameters<typeof broker.hello>[0])
  })

  server.register('broker.health', async ({ params }) => {
    return broker.health((params ?? {}) as Parameters<typeof broker.health>[0])
  })

  server.register('invocation.start', async ({ params }) => {
    return broker.start(params as Parameters<typeof broker.start>[0])
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

main()
