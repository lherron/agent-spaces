import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessInvocationSpec, InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { brokerProcessEnv } from './helpers'
import { invocationIdFrom } from './ids'

const packageRoot = new URL('..', import.meta.url).pathname
const repoRoot = new URL('../../..', import.meta.url).pathname
const fixtureDir = join(packageRoot, 'test/fixtures/fake-codex')

const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const runOnceSpec = (scenario: string): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId: invocationIdFrom(`inv_run_once_${scenario.replaceAll('-', '_')}`),
  harness: {
    frontend: 'codex',
    provider: 'openai',
    driver: 'codex-app-server',
  },
  process: {
    command: process.execPath,
    args: [join(fixtureDir, `${scenario}.ts`)],
    cwd: repoRoot,
    harnessTransport: { kind: 'jsonrpc-stdio' },
    limits: {
      startupTimeoutMs: 5000,
      turnTimeoutMs: 5000,
      stopGraceMs: 250,
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
    permissionPolicy: { mode: 'deny' },
  },
})

const userInput = {
  inputId: 'input_run_once_1',
  kind: 'user' as const,
  content: [{ type: 'text' as const, text: 'Please complete the lifecycle.' }],
}

const writeArgv = async (
  form: 'spec-and-input' | 'start-request',
  tmpDir: string
): Promise<string[]> => {
  const spec = runOnceSpec('run-once-lifecycle')
  if (form === 'spec-and-input') {
    const specPath = join(tmpDir, 'spec.json')
    const inputPath = join(tmpDir, 'input.json')
    await Bun.write(specPath, JSON.stringify(spec))
    await Bun.write(inputPath, JSON.stringify(userInput))
    return ['--spec', specPath, '--input', inputPath]
  }
  // An InvocationStartRequest file carries the spec and its initialInput together.
  const startRequestPath = join(tmpDir, 'start-request.json')
  await Bun.write(startRequestPath, JSON.stringify({ spec, initialInput: userInput }))
  return ['--start-request', startRequestPath]
}

describe('harness-broker run-once', () => {
  test.each(['spec-and-input', 'start-request'] as const)(
    'run-once (%s argv) waits for turn completion before stopping the invocation',
    async (form) => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'harness-broker-run-once-'))
      tmpDirs.push(tmpDir)
      const argv = await writeArgv(form, tmpDir)

      const proc = Bun.spawn({
        cmd: ['bun', 'harness/harness-broker/bin/harness-broker.js', 'run-once', ...argv],
        cwd: repoRoot,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: brokerProcessEnv(),
      })

      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited

      expect(exitCode).toBe(0)
      // stdout is NDJSON event frames only; diagnostics route to stderr.
      expect(stderr).toBe('')

      const events = stdout
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as InvocationEventEnvelope)
      const eventTypes = events.map((event) => event.type)
      const turnStartedIndex = eventTypes.indexOf('turn.started')
      const turnCompletedIndex = eventTypes.indexOf('turn.completed')
      const stoppingIndex = eventTypes.indexOf('invocation.stopping')
      const exitedIndex = eventTypes.indexOf('invocation.exited')

      expect(turnStartedIndex).toBeGreaterThanOrEqual(0)
      expect(turnCompletedIndex).toBeGreaterThan(turnStartedIndex)
      expect(stoppingIndex).toBeGreaterThan(turnCompletedIndex)
      expect(exitedIndex).toBeGreaterThan(stoppingIndex)

      for (let index = 1; index < events.length; index += 1) {
        expect(events[index]!.seq).toBeGreaterThan(events[index - 1]!.seq)
      }
    }
  )
})
