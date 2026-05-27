import { join } from 'node:path'
import type {
  BrokerHelloRequest,
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationEventType,
  InvocationInput,
} from 'spaces-harness-broker-protocol'

export const repoRoot = new URL('../../..', import.meta.url).pathname
export const brokerCommand = 'bun'
export const brokerArgs = [
  'packages/harness-broker/bin/harness-broker.js',
  'run',
  '--transport',
  'stdio',
]

const fakeCodexFixtureDir = join(repoRoot, 'packages/harness-broker/test/fixtures/fake-codex')

export const helloRequest = (
  capabilities: BrokerHelloRequest['capabilities'] = {}
): BrokerHelloRequest => ({
  clientInfo: { name: 'harness-broker-client-test', version: '0.1.0' },
  protocolVersions: ['harness-broker/0.1'],
  capabilities,
})

export function codexSpec(
  scenario: string,
  overrides: Partial<HarnessInvocationSpec> = {}
): HarnessInvocationSpec {
  const invocationId = overrides.invocationId ?? `inv_client_${scenario.replaceAll('-', '_')}`
  return {
    specVersion: 'harness-broker.invocation/v1',
    invocationId,
    labels: { package: 'harness-broker-client', scenario },
    harness: {
      frontend: 'codex',
      provider: 'openai',
      driver: 'codex-app-server',
    },
    process: {
      command: process.execPath,
      args: [join(fakeCodexFixtureDir, `${scenario}.ts`)],
      cwd: repoRoot,
      harnessTransport: { kind: 'jsonrpc-stdio' },
      limits: {
        startupTimeoutMs: 1000,
        turnTimeoutMs: 1000,
        stopGraceMs: 50,
      },
    },
    interaction: {
      mode: 'headless',
      turnConcurrency: 'single',
      inputQueue: 'none',
    },
    driver: {
      kind: 'codex-app-server',
      resumeFallback: 'start-fresh',
    },
    ...overrides,
  }
}

export const userInput = (text = 'Run one client-library integration turn.'): InvocationInput => ({
  inputId: `input_${Math.random().toString(36).slice(2, 8)}`,
  kind: 'user',
  content: [{ type: 'text', text }],
})

export async function nextEvent(
  iterator: AsyncIterator<InvocationEventEnvelope>,
  timeoutMs = 1000
): Promise<InvocationEventEnvelope> {
  const result = await withTimeout(iterator.next(), timeoutMs, 'timed out waiting for broker event')
  if (result.done) {
    throw new Error('event iterator ended before the expected event arrived')
  }
  return result.value
}

export async function collectUntil(
  events: AsyncIterable<InvocationEventEnvelope>,
  type: InvocationEventType,
  timeoutMs = 1000
): Promise<InvocationEventEnvelope[]> {
  const iterator = events[Symbol.asyncIterator]()
  const collected: InvocationEventEnvelope[] = []
  while (true) {
    const event = await nextEvent(iterator, timeoutMs)
    collected.push(event)
    if (event.type === type) {
      return collected
    }
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

export function findBrokerChildPid(): number {
  const proc = Bun.spawnSync({
    cmd: ['ps', '-axo', 'pid=,ppid=,command='],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = proc.stdout.toString()
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) continue
    const [, pidRaw, ppidRaw, command] = match
    if (
      Number(ppidRaw) === process.pid &&
      command.includes('packages/harness-broker/bin/harness-broker.js run --transport stdio')
    ) {
      return Number(pidRaw)
    }
  }
  throw new Error(`could not find broker child process under test process ${process.pid}`)
}
