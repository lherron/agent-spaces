/**
 * CLI integration tests for `asp self inspect` and `asp self paths`.
 *
 * These exercise the binary with a faked-up runtime env (HRC_LAUNCH_FILE,
 * ASP_PLUGIN_ROOT, AGENTCHAT_ID, ASP_AGENTS_ROOT, ASP_HOME) and assert on
 * stdout so a future agent can reproduce the red/green behavior without
 * mocking internals.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ASP_CLI = join(import.meta.dirname, '..', '..', '..', '..', 'bin', 'asp.js')
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((p) => rm(p, { recursive: true, force: true })))
  tempDirs.length = 0
})

async function setupFixture(): Promise<{
  dir: string
  agentsRoot: string
  bundleRoot: string
  launchFile: string
  env: Record<string, string>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'asp-self-cli-'))
  tempDirs.push(dir)

  const agentsRoot = join(dir, 'agents')
  const agentRoot = join(agentsRoot, 'clod')
  await mkdir(join(agentRoot, 'skills'), { recursive: true })
  await writeFile(join(agentRoot, 'SOUL.md'), '# Clod\nAgent identity.')
  await writeFile(
    join(agentRoot, 'agent-profile.toml'),
    'schemaVersion = 2\n[identity]\ndisplay = "Clod"\n'
  )

  const bundleRoot = join(dir, 'bundle', 'claude')
  await mkdir(join(bundleRoot, 'plugins'), { recursive: true })
  await writeFile(join(bundleRoot, 'settings.json'), '{}')

  const launchFile = join(dir, 'launch.json')
  await writeFile(
    launchFile,
    JSON.stringify({
      launchId: 'launch-TEST',
      hostSessionId: 'hsid-TEST',
      generation: 1,
      runtimeId: 'rt-TEST',
      runId: 'run-TEST',
      harness: 'claude-code',
      provider: 'anthropic',
      argv: ['claude', '--append-system-prompt', 'test-sys-prompt', '--', 'test-priming'],
      env: { AGENTCHAT_ID: 'clod' },
      cwd: dir,
      callbackSocketPath: '/tmp/sock',
      spoolDir: join(dir, 'spool'),
      correlationEnv: {},
    })
  )

  const env: Record<string, string> = {
    AGENTCHAT_ID: 'clod',
    ASP_PROJECT: 'test-proj',
    ASP_HOME: dir,
    ASP_AGENTS_ROOT: agentsRoot,
    ASP_PLUGIN_ROOT: bundleRoot,
    HRC_LAUNCH_FILE: launchFile,
    ASP_PRIMING_PROMPT: 'priming-from-env',
    HRC_SESSION_REF: 'agent:clod:project:test-proj',
    HRC_RUNTIME_ID: 'rt-TEST',
    HRC_RUN_ID: 'run-TEST',
    HRC_LAUNCH_ID: 'launch-TEST',
    HRC_GENERATION: '1',
    HRC_HOST_SESSION_ID: 'hsid-TEST',
  }

  return { dir, agentsRoot, bundleRoot, launchFile, env }
}

function runAsp(
  args: string[],
  env: Record<string, string>
): { stdout: string; stderr: string; exitCode: number } {
  try {
    // Strip the parent process's HRC/ASP env so it can't leak into the fixture
    const baseEnv = { ...process.env }
    for (const key of Object.keys(baseEnv)) {
      if (key.startsWith('HRC_') || key.startsWith('ASP_') || key === 'AGENTCHAT_ID') {
        delete baseEnv[key]
      }
    }
    const stdout = execFileSync('bun', ['run', ASP_CLI, ...args], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...baseEnv, ...env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { stdout, stderr: '', exitCode: 0 }
  } catch (error: any) {
    return {
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
      exitCode: error.status ?? 1,
    }
  }
}

describe('asp self inspect', () => {
  test('renders human-readable overview from fixture env', async () => {
    const fixture = await setupFixture()
    const result = runAsp(['self', 'inspect'], fixture.env)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('asp self inspect — clod')
    expect(result.stdout).toContain('agent:       clod')
    expect(result.stdout).toContain('project:     test-proj')
    expect(result.stdout).toContain('harness:     claude-code')
    expect(result.stdout).toContain('mode=append')
    // "test-sys-prompt" is 15 chars
    expect(result.stdout).toContain('chars=15')
  })

  test('--json emits SelfContext with derived counts', async () => {
    const fixture = await setupFixture()
    const result = runAsp(['self', 'inspect', '--json'], fixture.env)
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout) as {
      agentName: string
      harness: string
      systemPrompt: { content: string; mode: string }
      derived: { systemPromptChars: number; primingPromptChars: number }
    }
    expect(parsed.agentName).toBe('clod')
    expect(parsed.harness).toBe('claude-code')
    expect(parsed.systemPrompt.mode).toBe('append')
    expect(parsed.derived.systemPromptChars).toBe('test-sys-prompt'.length)
    expect(parsed.derived.primingPromptChars).toBe('test-priming'.length)
  })

  test('--target overrides inferred agent name', async () => {
    const fixture = await setupFixture()
    const result = runAsp(['self', 'inspect', '--target', 'overridden'], fixture.env)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('asp self inspect — overridden')
  })
})

describe('asp self paths', () => {
  test('classifies agent-local, shared, derived, ephemeral paths', async () => {
    const fixture = await setupFixture()
    const result = runAsp(['self', 'paths'], fixture.env)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('EDIT  soul')
    expect(result.stdout).toContain('EDIT  profile')
    expect(result.stdout).toContain('SHRD  shared-motd')
    expect(result.stdout).toContain('DRVD  bundle-root')
    expect(result.stdout).toContain('EPHM  launch-file')
  })

  test('--kind filters to one classification', async () => {
    const fixture = await setupFixture()
    const result = runAsp(['self', 'paths', '--kind', 'editable', '--json'], fixture.env)
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout) as {
      entries: Array<{ kind: string }>
    }
    expect(parsed.entries.length).toBeGreaterThan(0)
    expect(parsed.entries.every((e) => e.kind === 'editable')).toBe(true)
  })

  test('--existing skips non-existent paths', async () => {
    const fixture = await setupFixture()
    const result = runAsp(['self', 'paths', '--existing', '--json'], fixture.env)
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout) as {
      entries: Array<{ name: string; exists: boolean }>
    }
    expect(parsed.entries.every((e) => e.exists)).toBe(true)
    // HEARTBEAT.md wasn't created in the fixture, so it should be filtered out
    expect(parsed.entries.some((e) => e.name === 'heartbeat')).toBe(false)
    expect(parsed.entries.some((e) => e.name === 'soul')).toBe(true)
  })

  test('--json emits classified entries', async () => {
    const fixture = await setupFixture()
    const result = runAsp(['self', 'paths', '--json'], fixture.env)
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout) as {
      agent: string
      entries: Array<{ name: string; kind: string; exists: boolean; path: string }>
    }
    expect(parsed.agent).toBe('clod')
    const soul = parsed.entries.find((e) => e.name === 'soul')
    expect(soul?.kind).toBe('editable')
    expect(soul?.exists).toBe(true)
  })

  test('invalid --kind exits 2 with error message', async () => {
    const fixture = await setupFixture()
    const result = runAsp(['self', 'paths', '--kind', 'bogus'], fixture.env)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("invalid --kind 'bogus'")
  })
})
