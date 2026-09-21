/**
 * aspd pilot client (T-08539): contracts-only closure, and every release
 * refusal happens before the worker is started — from persisted bytes, or at
 * the worker handshake before `invocation.start`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { forbiddenClientInputs } from './build-client.ts'

const repoRoot = new URL('../..', import.meta.url).pathname
const RELEASE_ID = 'asp-0123456789ab-20260916T120000Z-abcdef'
const SOURCE_COMMIT = '0123456789abcdef0123456789abcdef01234567'

const bases: string[] = []
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true })
})

function base(): string {
  const dir = mkdtempSync(join('/tmp', 'apc-'))
  bases.push(dir)
  return dir
}

describe('pilot client closure', () => {
  test('bundles only wire contracts, framing and transport', async () => {
    const out = mkdtempSync(join(tmpdir(), 'aspd-client-closure-'))
    bases.push(out)
    const build = await Bun.build({
      entrypoints: [join(repoRoot, 'scripts/aspd-pilot/client.ts')],
      target: 'bun',
      outdir: out,
      sourcemap: 'external',
    })
    expect(build.success).toBe(true)
    const sourceMap = build.outputs.find((output) => output.kind === 'sourcemap')
    expect(sourceMap).toBeDefined()
    const inputs = (
      JSON.parse(readFileSync(sourceMap?.path ?? '', 'utf8')) as { sources: string[] }
    ).sources.map((input) => relative(repoRoot, resolve(join(sourceMap?.path ?? '', '..'), input)))
    expect(inputs.length).toBeGreaterThan(0)
    expect(forbiddenClientInputs(inputs)).toEqual([])
  })

  test('flags configuration, compiler and execution modules', () => {
    expect(
      forbiddenClientInputs([
        'contracts/aspc-protocol/src/types.ts',
        'compiler/agent-spaces/src/client.ts',
        'core/config/src/index.ts',
        'harness/harness-broker/src/broker.ts',
        'drivers/execution/src/index.ts',
      ])
    ).toEqual([
      'compiler/agent-spaces/src/client.ts',
      'core/config/src/index.ts',
      'harness/harness-broker/src/broker.ts',
      'drivers/execution/src/index.ts',
    ])
  })
})

function release(root: string, launcher: string): string {
  const dir = join(root, RELEASE_ID)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'release.json'),
    JSON.stringify({ releaseId: RELEASE_ID, sourceCommit: SOURCE_COMMIT })
  )
  writeFileSync(join(dir, 'harness-broker'), launcher, { mode: 0o755 })
  return dir
}

function preparation(
  state: string,
  attempt: string,
  executionRelease: Record<string, unknown>
): void {
  const dir = join(state, 'w', attempt)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'preparation.json'),
    JSON.stringify({
      attempt,
      response: {
        ok: true,
        plan: {
          identity: { generation: 1 },
          execution: {
            driver: 'codex-app-server',
            protocol: 'harness-broker/0.2',
            profile: { profileHash: 'p', startRequestHash: 's' },
            dispatchRequest: {
              startRequest: {
                spec: {
                  invocationId: 'inv_t',
                  correlation: { runtimeId: 'rt', hostSessionId: 'hs' },
                },
              },
            },
          },
        },
        executionRelease,
      },
    })
  )
}

async function launch(
  state: string,
  attempt: string
): Promise<{ ok: boolean; error?: { code: string } }> {
  const proc = Bun.spawn({
    cmd: ['bun', 'scripts/aspd-pilot/client.ts', '--state', state],
    cwd: repoRoot,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  proc.stdin.write(`${JSON.stringify({ id: '1', cmd: 'launch', attempt })}\n`)
  proc.stdin.write(`${JSON.stringify({ id: '2', cmd: 'exit' })}\n`)
  proc.stdin.end()
  const lines = (await new Response(proc.stdout).text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  await proc.exited
  return lines.find((line) => line.id === '1')
}

describe('refusals before start', () => {
  test('release binding problems are refused from persisted bytes before launch', async () => {
    const root = base()
    const state = join(root, 'client')
    const dir = release(join(root, 'releases'), '#!/bin/sh\nexit 99\n')
    const good = {
      releaseId: RELEASE_ID,
      sourceCommit: SOURCE_COMMIT,
      builtAt: 'x',
      releaseRoot: dir,
      worker: {
        protocol: 'harness-broker/0.2',
        executable: join(dir, 'harness-broker'),
        argvPrefix: ['run'],
      },
    }
    writeFileSync(join(root, 'outside'), '#!/bin/sh\n', { mode: 0o755 })
    const cases: Array<[string, Record<string, unknown>, string]> = [
      [
        'a1',
        { ...good, releaseRoot: join(root, 'releases', 'asp-withheld') },
        'release_unavailable',
      ],
      ['a2', { ...good, sourceCommit: 'f'.repeat(40) }, 'release_identity_mismatch'],
      [
        'a3',
        { ...good, worker: { ...good.worker, executable: join(root, 'outside') } },
        'worker_executable_outside_release',
      ],
      [
        'a4',
        { ...good, worker: { ...good.worker, protocol: 'harness-broker/9.9' } },
        'unsupported_worker_protocol',
      ],
    ]
    for (const [attempt, executionRelease, code] of cases) {
      preparation(state, attempt, executionRelease)
      const result = await launch(state, attempt)
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe(code)
      expect(existsSync(join(state, 'w', attempt, 'bindings.json'))).toBe(false)
    }
  })

  test('a worker whose handshake reports no release is refused before invocation.start', async () => {
    const root = base()
    const state = join(root, 'c')
    const dir = release(
      join(root, 'r'),
      `#!/bin/sh\nexec bun ${join(repoRoot, 'harness/harness-broker/bin/harness-broker.js')} "$@"\n`
    )
    preparation(state, 'u1', {
      releaseId: RELEASE_ID,
      sourceCommit: SOURCE_COMMIT,
      builtAt: 'x',
      releaseRoot: dir,
      worker: {
        protocol: 'harness-broker/0.2',
        executable: join(dir, 'harness-broker'),
        argvPrefix: ['run', '--transport', 'unix'],
      },
    })
    const result = await launch(state, 'u1')
    expect(result.error?.code).toBe('worker_release_unidentified')
    expect(existsSync(join(state, 'w', 'u1', 'worker-hello.json'))).toBe(true)
    expect(existsSync(join(state, 'w', 'u1', 'start-submitted.json'))).toBe(false)
    expect(existsSync(join(state, 'w', 'u1', 'start-outcome.json'))).toBe(false)
  })
})
