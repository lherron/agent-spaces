import { runAspcFacadeStdio } from './facade.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]

  if (command === 'run') {
    const transportIndex = args.indexOf('--transport')
    const transport = transportIndex === -1 ? undefined : args[transportIndex + 1]
    if (transport !== 'stdio') {
      process.stderr.write(`Unknown or missing transport: ${transport ?? '(none)'}\n`)
      process.exit(1)
    }
    runAspcFacadeStdio()
    return
  }

  process.stderr.write(
    `Unknown command: ${command ?? '(none)'}\nUsage: aspc-facade run --transport stdio\n`
  )
  process.exit(1)
}

void main()
