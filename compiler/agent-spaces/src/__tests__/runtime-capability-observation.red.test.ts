/** T-08563 rev 5 fresh, bounded, read-only capability observation reds. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import * as AgentSpaces from '../index.js'

type CapabilityResponse = Record<string, any> & { ok: boolean }
type ObserveRuntimeCapability = (request: Record<string, unknown>) => Promise<CapabilityResponse>

const ENV_KEYS = [
  'ASP_CLAUDE_PATH',
  'ASP_MUSE_PATH',
  'ASP_CODEX_PATH',
  'ASP_CODEX_SKIP_COMMON_PATHS',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'HOME',
  'PATH',
] as const
let savedEnv: Record<string, string | undefined> = {}
let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'runtime-capability-red-'))
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  process.env.ANTHROPIC_API_KEY = 'test-only-capability-presence'
})

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
})

describe('T-08563 runtime capability observation', () => {
  test('positive control: executable fixture records a read-only --version probe', async () => {
    const audit = join(root, 'audit.log')
    const shim = await executable(
      'control',
      `await Bun.write(${JSON.stringify(audit)}, process.argv.slice(2).join(' ')); console.log('1.2.3')`
    )
    const child = Bun.spawn([shim, '--version'], { stdout: 'pipe', stderr: 'pipe' })
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toContain('1.2.3')
    expect(await readFile(audit, 'utf8')).toBe('--version')
  })

  test('bypasses Claude process-lifetime cache and never turns a failed fresh probe positive', async () => {
    const shim = await executable('claude', `console.log('claude 9.9.9')`)
    process.env.ASP_CLAUDE_PATH = shim
    const first = await operation()(request('claude'))
    expect(first).toMatchObject({
      ok: true,
      nativeRuntime: { state: 'present', code: 'native_available' },
      preparation: { state: 'present', code: 'preparation_ready' },
    })

    await executableAt(shim, `console.error('fresh failure'); process.exit(7)`)
    const second = await operation()(request('claude'))
    expect(second).toMatchObject({
      ok: true,
      nativeRuntime: { state: 'unknown', code: 'detection_failed' },
      preparation: { state: 'unknown', code: 'preparation_unknown' },
    })
    expect(second.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'probe_exit_nonzero', probe: 'version' }),
      ])
    )
  })

  test('observes the canonical muse harness: version probe present, credentials not required', async () => {
    const shim = await executable('muse', `console.log('Muse Code 1.3.0')`)
    process.env.ASP_MUSE_PATH = shim
    const response = await operation()(request('muse'))
    expect(response).toMatchObject({
      ok: true,
      nativeRuntime: { state: 'present', code: 'native_available' },
      credentials: { state: 'present', code: 'credentials_not_required' },
      preparation: { state: 'present', code: 'preparation_ready' },
    })
  })

  test('bounds canonical CLI probes at 3000ms and 65536 combined bytes', async () => {
    const slow = await executable('claude-slow', `await Bun.sleep(10_000); console.log('late')`)
    process.env.ASP_CLAUDE_PATH = slow
    const started = Date.now()
    const timeout = await operation()(request('claude'))
    expect(Date.now() - started).toBeLessThan(4_500)
    expect(timeout.nativeRuntime).toEqual({ state: 'unknown', code: 'detection_failed' })
    expect(timeout.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'probe_timeout' })])
    )

    const overflow = await executable(
      'claude-overflow',
      `process.stdout.write('x'.repeat(65_537))`
    )
    process.env.ASP_CLAUDE_PATH = overflow
    const over = await operation()(request('claude'))
    expect(over.nativeRuntime).toEqual({ state: 'unknown', code: 'detection_failed' })
    expect(over.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'probe_output_limit' })])
    )
  }, 10_000)

  test('keeps the deadline through inherited pipe drain and kills the probe group', async () => {
    const childPidPath = join(root, 'inherited-pipe-child.pid')
    const shim = await executable(
      'claude-inherited-pipe',
      `const child = Bun.spawn(['sh', '-c', 'trap "" TERM; sleep 30'], { stdout: 'inherit', stderr: 'inherit' }); await Bun.write(${JSON.stringify(childPidPath)}, String(child.pid)); console.log('claude 9.9.9')`
    )
    process.env.ASP_CLAUDE_PATH = shim
    const started = Date.now()
    const response = await operation()(request('claude'))
    expect(Date.now() - started).toBeLessThan(4_500)
    expect(response.nativeRuntime).toEqual({ state: 'unknown', code: 'detection_failed' })
    expect(response.preparation).toEqual({ state: 'unknown', code: 'preparation_unknown' })
    expect(response.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'probe_timeout' })])
    )

    const childPid = Number(await readFile(childPidPath, 'utf8'))
    await Bun.sleep(25)
    expect(() => process.kill(childPid, 0)).toThrow()
  }, 10_000)

  test('limits Codex to eight existing candidates and a failed probe is never capable', async () => {
    const audit = join(root, 'codex-audit.log')
    const dirs: string[] = []
    for (let index = 0; index < 10; index += 1) {
      const dir = join(root, `candidate-${index}`)
      dirs.push(dir)
      await mkdir(dir)
      await executableAt(
        join(dir, 'codex'),
        `const f = Bun.file(${JSON.stringify(audit)}); const prior = await f.exists() ? await f.text() : ''; await Bun.write(${JSON.stringify(audit)}, prior + ${JSON.stringify(`${index}:`)} + process.argv.slice(2).join(' ') + '\\n'); process.exit(9)`
      )
    }
    process.env.ASP_CODEX_SKIP_COMMON_PATHS = '1'
    Reflect.deleteProperty(process.env, 'ASP_CODEX_PATH')
    process.env.PATH = [...dirs, savedEnv.PATH ?? ''].join(delimiter)

    const response = await operation()(request('codex'))
    expect(response.nativeRuntime).toEqual({ state: 'unknown', code: 'detection_failed' })
    expect(response.preparation).toEqual({ state: 'unknown', code: 'preparation_unknown' })
    const probes = (await readFile(audit, 'utf8')).trim().split('\n')
    expect(probes.length).toBeLessThanOrEqual(8)
    expect(probes.every((line) => line.endsWith('--version'))).toBe(true)
  })

  test('classifies below-minimum Codex as absent/native_unavailable', async () => {
    const shim = await executable('codex-old', `console.log('codex-cli 0.1.0')`)
    process.env.ASP_CODEX_PATH = shim
    process.env.ASP_CODEX_SKIP_COMMON_PATHS = '1'
    const response = await operation()(request('codex'))
    expect(response).toMatchObject({
      ok: true,
      nativeRuntime: { state: 'absent', code: 'native_unavailable' },
      preparation: { state: 'absent', code: 'native_unavailable' },
    })
    expect(response.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'version_below_minimum' })])
    )
  })

  test('classifies a spawn failure as unknown and never positive', async () => {
    const shim = join(root, 'cannot-spawn')
    await writeFile(shim, '#!/definitely/not/a/real/interpreter\n')
    await chmod(shim, 0o755)
    process.env.ASP_CLAUDE_PATH = shim
    const response = await operation()(request('claude'))
    expect(response.nativeRuntime).toEqual({ state: 'unknown', code: 'detection_failed' })
    expect(response.preparation).toEqual({ state: 'unknown', code: 'preparation_unknown' })
    expect(response.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'probe_failed', probe: 'version' })])
    )
  })

  test('enforces the 12000ms operation-wide Codex deadline across candidates', async () => {
    const dirs: string[] = []
    for (let index = 0; index < 8; index += 1) {
      const dir = join(root, `slow-candidate-${index}`)
      dirs.push(dir)
      await mkdir(dir)
      await executableAt(join(dir, 'codex'), 'await Bun.sleep(10_000)')
    }
    process.env.ASP_CODEX_SKIP_COMMON_PATHS = '1'
    Reflect.deleteProperty(process.env, 'ASP_CODEX_PATH')
    process.env.PATH = [...dirs, savedEnv.PATH ?? ''].join(delimiter)
    const started = Date.now()
    const response = await operation()(request('codex'))
    expect(Date.now() - started).toBeLessThan(13_500)
    expect(response.nativeRuntime.state).toBe('unknown')
    expect(response.preparation.state).not.toBe('present')
  }, 20_000)

  test('runs only detection probes: no agent invocation, preparation, materialization, or input', async () => {
    const audit = join(root, 'readonly-audit.log')
    const shim = await executable(
      'codex-readonly',
      `const f = Bun.file(${JSON.stringify(audit)}); const prior = await f.exists() ? await f.text() : ''; await Bun.write(${JSON.stringify(audit)}, prior + process.argv.slice(2).join(' ') + '\\n'); if (process.argv.includes('--version')) console.log('codex-cli 99.0.0'); else console.log('app-server help')`
    )
    process.env.ASP_CODEX_PATH = shim
    process.env.ASP_CODEX_SKIP_COMMON_PATHS = '1'
    const response = await operation()(request('codex'))
    expect(response.nativeRuntime).toEqual({ state: 'present', code: 'native_available' })
    expect((await readFile(audit, 'utf8')).trim().split('\n')).toEqual([
      '--version',
      'app-server --help',
    ])
    expect(JSON.stringify(response)).not.toMatch(/invocation|materializ|initialInput/i)
  })

  test('re-reads agent-harness credential presence from its native-worker auth source', async () => {
    process.env.HOME = root
    Reflect.deleteProperty(process.env, 'ANTHROPIC_API_KEY')
    Reflect.deleteProperty(process.env, 'OPENAI_API_KEY')

    const absent = await operation()(request('agent-harness'))
    expect(absent.credentials).toEqual({ state: 'absent', code: 'credentials_missing' })
    expect(absent.preparation).toEqual({ state: 'absent', code: 'credentials_missing' })

    await mkdir(join(root, '.pi', 'agent'), { recursive: true })
    await writeFile(join(root, '.pi', 'agent', 'auth.json'), '{}')
    const present = await operation()(request('agent-harness'))
    expect(present.credentials).toEqual({ state: 'present', code: 'credentials_present' })
    expect(present.preparation).toEqual({ state: 'present', code: 'preparation_ready' })
  })

  test('refuses retired aliases instead of treating them as selectable harnesses', async () => {
    for (const retired of ['pi', 'pi-sdk', 'muse-cli']) {
      await expect(operation()(request(retired))).resolves.toMatchObject({
        ok: false,
        failure: { kind: 'incompatible', code: 'unsupported_harness' },
      })
    }
  })
})

function operation(): ObserveRuntimeCapability {
  const value = (AgentSpaces as Record<string, unknown>)['observeRuntimeCapability']
  expect(
    value,
    'agent-spaces must expose a fresh read-only observeRuntimeCapability operation'
  ).toBeFunction()
  return value as ObserveRuntimeCapability
}

function request(harness: string): Record<string, unknown> {
  return {
    schemaVersion: 'aspc-observe-runtime-capability-request/v1',
    harness,
    context: {
      agentId: 'smokey',
      agentRoot: root,
      project: { mode: 'none' },
      cwd: root,
      runMode: 'task',
    },
  }
}

async function executable(name: string, body: string): Promise<string> {
  const path = join(root, name)
  await executableAt(path, body)
  return path
}

async function executableAt(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/usr/bin/env bun\n${body}\n`)
  await chmod(path, 0o755)
}
