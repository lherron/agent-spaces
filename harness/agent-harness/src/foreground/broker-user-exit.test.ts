import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { type Server, type Socket, createServer } from 'node:net'
import { join } from 'node:path'
import type { AgentSessionRuntime } from '@earendil-works/pi-coding-agent'
import type { CreateAgentHarnessRuntimeOptions, ResolvedAgent } from 'agent-harness-runtime'
import type { AgentHarnessSessionConfig, LoadAgentOptions } from 'spaces-harness-broker-protocol'
import { encodeAgentHarnessControlFrame } from 'spaces-harness-broker-protocol'

import { type ForegroundTuiDependencies, runAgentHarnessTui } from './tui'

/**
 * T-07677. On `/quit` this TUI must TELL the broker it left.
 *
 * Everything downstream hangs off one event: `continuation.cleared { reason:
 * 'prompt_input_exit' }` is what makes the broker push an authoritative
 * `invocation.summary`, which is what HRC records before reaping the tmux lease,
 * which is what `hrc run` reads to print its post-detach session summary. Before
 * this fix the TUI returned from the interactive loop and simply hung up, so a
 * clean `/quit` was indistinguishable from a crash and none of that ran.
 *
 * The negative case matters just as much. A crash must NOT claim a user exit:
 * HRC drops the continuation on a user exit and keeps it otherwise, so a
 * mislabelled crash would cost the operator their resumable session (T-01761).
 */

type BrokerTuiRunner = (
  options: LoadAgentOptions & { brokerControlSocket: string },
  dependencies?: ForegroundTuiDependencies
) => Promise<void>

const runBrokerTui = runAgentHarnessTui as unknown as BrokerTuiRunner

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function sessionConfig(): AgentHarnessSessionConfig {
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
    agent: { agentId: 'sparky', projectId: 'hrc-runtime' },
  } as AgentHarnessSessionConfig
}

interface ControlEnd {
  socketPath: string
  frames: Array<Record<string, unknown>>
  /** Resolves with the first frame matching `predicate`, or undefined on timeout. */
  waitFor(
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs?: number
  ): Promise<Record<string, unknown> | undefined>
  /** Snapshot taken by `onFrame` at the instant each frame arrived. */
  arrivals: Array<{ frame: Record<string, unknown>; note: unknown }>
}

/** The broker end: answers `hello` with one session.config and records the rest. */
async function startControl(note: () => unknown = () => undefined): Promise<ControlEnd> {
  const directory = await mkdtemp('/tmp/ah-user-exit-')
  const socketPath = join(directory, 'control.sock')
  const sockets = new Set<Socket>()
  const frames: Array<Record<string, unknown>> = []
  const arrivals: Array<{ frame: Record<string, unknown>; note: unknown }> = []
  const watchers = new Set<() => void>()

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
        frames.push(frame)
        arrivals.push({ frame, note: note() })
        for (const watcher of [...watchers]) watcher()
        if (frame['verb'] === 'hello') {
          socket.write(
            encodeAgentHarnessControlFrame({
              verb: 'session.config',
              requestId: 'req-user-exit-1',
              payload: sessionConfig(),
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

  return {
    socketPath,
    frames,
    arrivals,
    waitFor(predicate, timeoutMs = 500) {
      return new Promise((resolve) => {
        const check = (): boolean => {
          const hit = frames.find(predicate)
          if (hit === undefined) return false
          watchers.delete(check as unknown as () => void)
          clearTimeout(timer)
          resolve(hit)
          return true
        }
        const timer = setTimeout(() => {
          watchers.delete(check as unknown as () => void)
          resolve(undefined)
        }, timeoutMs)
        watchers.add(check as unknown as () => void)
        if (check()) return
      })
    },
  }
}

interface TuiHarness {
  dependencies: ForegroundTuiDependencies
  disposed: () => boolean
}

/**
 * `disposeMs` makes dispose observably slow so the ORDER of the goodbye against
 * it is testable rather than incidental: the announcement must not go out while
 * the session is still being written.
 */
function harness(options: {
  interactive: () => Promise<void>
  disposeMs?: number
}): TuiHarness {
  let disposed = false
  const runtime = {
    session: {
      sessionFile: '/tmp/agent-harness-session-07677.jsonl',
      subscribe: () => () => undefined,
    },
    async dispose() {
      if (options.disposeMs !== undefined) await Bun.sleep(options.disposeMs)
      disposed = true
    },
  } as unknown as AgentSessionRuntime

  return {
    disposed: () => disposed,
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
      async createRuntime(_options: CreateAgentHarnessRuntimeOptions) {
        return runtime
      },
      async runInteractiveMode(_runtime: AgentSessionRuntime, _initial?: string) {
        await options.interactive()
      },
    } satisfies ForegroundTuiDependencies,
  }
}

const isUserExit = (frame: Record<string, unknown>): boolean => {
  if (frame['verb'] !== 'event') return false
  const payload = frame['payload'] as { type?: string } | undefined
  return payload?.type === 'continuation.cleared'
}

describe('agent-harness broker TUI user exit', () => {
  test('announces the user exit when the interactive loop returns cleanly', async () => {
    const control = await startControl()
    const fake = harness({ interactive: async () => undefined })

    await runBrokerTui(
      { agentId: 'sparky', brokerControlSocket: control.socketPath },
      fake.dependencies
    )

    const goodbye = await control.waitFor(isUserExit)
    expect(goodbye).toBeDefined()
    // `prompt_input_exit` is the exact reason the broker's SESSION_LEAVE_REASONS
    // and HRC's BROKER_TMUX_PROMPT_EXIT_REASONS both match on. Any other string
    // is silently inert on both sides.
    expect(goodbye?.['payload']).toMatchObject({
      type: 'continuation.cleared',
      payload: { reason: 'prompt_input_exit' },
    })
  })

  test('stays silent when the interactive loop throws', async () => {
    const control = await startControl()
    const fake = harness({
      interactive: async () => {
        throw new Error('TUI crashed')
      },
    })

    await expect(
      runBrokerTui(
        { agentId: 'sparky', brokerControlSocket: control.socketPath },
        fake.dependencies
      )
    ).rejects.toThrow('TUI crashed')

    // A crash must not claim a user exit — HRC drops the continuation on one,
    // and this session is meant to stay resumable on reattach.
    expect(await control.waitFor(isUserExit, 150)).toBeUndefined()
  })

  test('announces only after the session has been disposed', async () => {
    // HRC reaps the tmux lease as soon as it records the summary this event
    // triggers. Announcing before dispose would race the pane kill against the
    // TUI's own session write.
    const fake = harness({ interactive: async () => undefined, disposeMs: 40 })
    const control = await startControl(() => fake.disposed())

    await runBrokerTui(
      { agentId: 'sparky', brokerControlSocket: control.socketPath },
      fake.dependencies
    )
    await control.waitFor(isUserExit)

    const arrival = control.arrivals.find((entry) => isUserExit(entry.frame))
    expect(arrival).toBeDefined()
    expect(arrival?.note).toBe(true)
  })
})
