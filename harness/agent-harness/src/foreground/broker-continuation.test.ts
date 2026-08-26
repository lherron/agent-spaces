import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { type Server, type Socket, createServer } from 'node:net'
import { join } from 'node:path'
import type { AgentSessionRuntime } from '@earendil-works/pi-coding-agent'
import type {
  CreateAgentHarnessRuntimeOptions,
  LoadAgentOptions,
  ResolvedAgent,
} from 'agent-harness-runtime'
import type { AgentHarnessSessionConfig } from 'spaces-harness-broker-protocol'
import { encodeAgentHarnessControlFrame } from 'spaces-harness-broker-protocol'

import { type ForegroundTuiDependencies, runAgentHarnessTui } from './tui'

/**
 * T-07585. `createAgentSessionManager` treats `continuationKey` as a four-way
 * switch: `undefined` creates a FRESH session, a string calls
 * `SessionManager.open`, which throws when that session does not exist. So the
 * absence of a continuation must survive all the way to `createRuntime` as an
 * absent option — passing a synthesized key instead makes a first launch
 * impossible. Mirrors broker/invocation-session-factory.ts:55-57.
 */

type BrokerTuiRunner = (
  options: LoadAgentOptions & { brokerControlSocket: string },
  dependencies?: ForegroundTuiDependencies
) => Promise<void>

const runBrokerTui = runAgentHarnessTui as BrokerTuiRunner

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function configWithout(continuation: { key: string } | undefined): AgentHarnessSessionConfig {
  return {
    permissionPolicy: { mode: 'allow' },
    auth: {
      authMode: 'oauth',
      authPath: '/broker/credentials/auth.json',
      providerId: 'openai-codex',
      credentialType: 'oauth',
      storeBound: true,
    },
    sdk: { modelId: 'gpt-5.6-terra' },
    agent: { agentId: 'sparky', projectId: 'agent-spaces' },
    ...(continuation !== undefined ? { continuation } : {}),
  } as AgentHarnessSessionConfig
}

/** Minimal broker end: answers `hello` with one session.config and acks nothing else. */
async function startControl(config: AgentHarnessSessionConfig): Promise<string> {
  const directory = await mkdtemp('/tmp/ah-cont-')
  const socketPath = join(directory, 'control.sock')
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line.length === 0) continue
        const frame = JSON.parse(line) as Record<string, unknown>
        if (frame['verb'] === 'hello') {
          socket.write(
            encodeAgentHarnessControlFrame({
              verb: 'session.config',
              requestId: 'req-continuation-1',
              payload: config,
            })
          )
        }
      }
    })
    socket.on('error', () => undefined)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => resolve())
  })
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  })
  return socketPath
}

function harness(): {
  dependencies: ForegroundTuiDependencies
  options: () => CreateAgentHarnessRuntimeOptions | undefined
} {
  let captured: CreateAgentHarnessRuntimeOptions | undefined
  const runtime = {
    session: {
      sessionFile: '/tmp/agent-harness-session-07585.jsonl',
      subscribe: () => () => undefined,
    },
    async dispose() {},
  } as unknown as AgentSessionRuntime
  return {
    options: () => captured,
    dependencies: {
      async loadAgent() {
        return {
          agentId: 'sparky',
          aspHome: '/tmp/asp-home',
          placement: { agentRoot: '/tmp/agents/sparky', cwd: '/tmp/project', runMode: 'task' },
          model: { piProvider: 'openai-codex', piModelId: 'gpt-5.6-terra', authMode: 'oauth' },
          environment: {},
          sources: { effectiveConfig: {} },
          skillPaths: [],
          warnings: [],
        } as unknown as ResolvedAgent
      },
      async createRuntime(options: CreateAgentHarnessRuntimeOptions) {
        captured = options
        return runtime
      },
      async runInteractiveMode(_runtime: AgentSessionRuntime, _initial?: string) {
        // The TUI event loop is not what this file is about; returning
        // immediately lets runBrokerAgentHarnessTui reach its finally.
      },
    } satisfies ForegroundTuiDependencies,
  }
}

void {} as unknown as AgentSessionEvent

describe('agent-harness broker TUI continuation binding', () => {
  test('omits continuationKey entirely when session.config carries no continuation', async () => {
    const socketPath = await startControl(configWithout(undefined))
    const fake = harness()

    await runBrokerTui({ agentId: 'sparky', brokerControlSocket: socketPath }, fake.dependencies)

    const options = fake.options()
    expect(options).toBeDefined()
    // Not merely undefined — ABSENT. `createAgentSessionManager` branches on
    // `continuationKey === undefined` to create a fresh session, so a
    // synthesized key here would call SessionManager.open on a file that does
    // not exist and abort the first launch.
    expect(Object.hasOwn(options as object, 'continuationKey')).toBe(false)
  })

  test('passes the delivered key through unchanged when session.config carries one', async () => {
    const socketPath = await startControl(configWithout({ key: 'session-07585.jsonl' }))
    const fake = harness()

    await runBrokerTui({ agentId: 'sparky', brokerControlSocket: socketPath }, fake.dependencies)

    expect(fake.options()?.continuationKey).toBe('session-07585.jsonl')
  })
})
