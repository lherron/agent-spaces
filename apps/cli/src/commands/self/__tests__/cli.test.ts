/**
 * CLI integration tests for `asp self inspect` and `asp self paths`.
 *
 * These exercise the binary with a faked-up runtime env and assert on stdout
 * so a future agent can reproduce the red/green behavior without mocking
 * internals.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ASP_CLI = join(import.meta.dirname, '..', '..', '..', '..', 'bin', 'asp.js')
const tempDirs: string[] = []
const SAMPLE_PREFIX = 'EXAMPLE_'

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
    'version = 3\n[identity]\ndisplay = "Clod"\n'
  )

  const bundleRoot = join(dir, 'bundle', 'claude')
  await mkdir(join(bundleRoot, 'plugins'), { recursive: true })
  await writeFile(join(bundleRoot, 'settings.json'), '{}')

  const launchFile = join(dir, 'launch.json')
  const artifactEnv = {
    AGENTCHAT_ID: 'clod',
    AGENT_LAUNCH_FILE: launchFile,
    AGENT_HOST_SESSION_ID: 'hsid-TEST',
    AGENT_LANE_REF: 'main',
    AGENT_SCOPE_REF: 'agent:clod:project:test-proj',
    ASP_AGENTS_ROOT: agentsRoot,
    ASP_HOME: dir,
    ASP_PLUGIN_ROOT: bundleRoot,
    ASP_PRIMING_PROMPT: 'priming-from-env',
    ASP_PROJECT: 'test-proj',
    [`${SAMPLE_PREFIX}GENERATION`]: '1',
    [`${SAMPLE_PREFIX}LAUNCH_ID`]: 'launch-TEST',
    [`${SAMPLE_PREFIX}RUNTIME_ID`]: 'rt-TEST',
    [`${SAMPLE_PREFIX}RUN_ID`]: 'run-TEST',
    PATH: '/bin:/usr/bin',
    SHELL: '/bin/zsh',
  }
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
      env: artifactEnv,
      cwd: dir,
      callbackSocketPath: '/tmp/sock',
      spoolDir: join(dir, 'spool'),
      correlationEnv: {},
    })
  )

  const env: Record<string, string> = {
    AGENTCHAT_ID: 'clod',
    AGENT_LAUNCH_FILE: launchFile,
    ASP_PROJECT: 'test-proj',
    ASP_HOME: dir,
    ASP_AGENTS_ROOT: agentsRoot,
    ASP_PLUGIN_ROOT: bundleRoot,
    ASP_PRIMING_PROMPT: 'priming-from-env',
  }

  return { dir, agentsRoot, bundleRoot, launchFile, env }
}

function runAsp(
  args: string[],
  env: Record<string, string>
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const baseEnv = {
      HOME: process.env['HOME'] ?? '/tmp',
      PATH: process.env['PATH'] ?? '/bin:/usr/bin',
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
    expect(result.stdout).toContain('source:      launch-artifact')
    expect(result.stdout).toContain('agent:       clod')
    expect(result.stdout).toContain('project:     test-proj')
    expect(result.stdout).toContain('wrkq client')
    expect(result.stdout).toContain('WRKQ_PRINCIPAL_REF  agent:clod')
    expect(result.stdout).not.toContain('raw environment')
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
      envSource: string
      runtime: { harness: string }
      collaboration: { principal: { value: string; source: string } }
      prompt: { system: { mode: string; chars: number }; primingChars: number }
      diagnostics: Record<string, unknown>
    }
    expect(parsed.agentName).toBe('clod')
    expect(parsed.envSource).toBe('launch-artifact')
    expect(parsed.runtime.harness).toBe('claude-code')
    expect(parsed.collaboration.principal).toEqual({
      key: 'WRKQ_PRINCIPAL_REF',
      value: 'agent:clod',
      source: 'derived',
      derivedFrom: 'AGENTCHAT_ID',
    })
    expect(parsed.prompt.system.mode).toBe('append')
    expect(parsed.prompt.system.chars).toBe('test-sys-prompt'.length)
    expect(parsed.prompt.primingChars).toBe('test-priming'.length)
    expect(parsed.diagnostics['rawEnvironment']).toBeUndefined()
  })

  test('projects HRC authority inputs as effective wrkq client settings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asp-self-wrkq-'))
    tempDirs.push(dir)
    const result = runAsp(['self', 'inspect'], {
      ASP_AGENT_ID: 'cody',
      ASP_HOME: dir,
      ASP_PROJECT: 'agent-spaces',
      HRC_WRKQ_DB: 'rpc://canonical.example:7171',
      HRC_WRKQD_TOKEN_FILE: '/run/secrets/wrkqd-token',
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      'WRKQ_DB             rpc://canonical.example:7171 (derived from HRC_WRKQ_DB)'
    )
    expect(result.stdout).toContain(
      'WRKQD_TOKEN_FILE    /run/secrets/wrkqd-token (derived from HRC_WRKQD_TOKEN_FILE)'
    )
    expect(result.stdout).toContain('HRC authority source (not direct wrkq settings)')
  })

  test('redacts token values when raw diagnostics are requested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asp-self-redact-'))
    tempDirs.push(dir)
    const result = runAsp(['self', 'inspect', '--json', '--raw-env'], {
      ASP_AGENT_ID: 'cody',
      ASP_HOME: dir,
      HRC_WRKQD_TOKEN_FILE: '/run/secrets/wrkqd-token',
      HRC_TOKEN: 'do-not-print',
    })
    const parsed = JSON.parse(result.stdout) as {
      diagnostics: { rawEnvironment: Record<string, string> }
    }

    expect(parsed.diagnostics.rawEnvironment['HRC_TOKEN']).toBe('<redacted>')
    expect(parsed.diagnostics.rawEnvironment['HRC_WRKQD_TOKEN_FILE']).toBe(
      '/run/secrets/wrkqd-token'
    )
    expect(result.stdout).not.toContain('do-not-print')
  })

  test('--target overrides inferred agent name', async () => {
    const fixture = await setupFixture()
    const result = runAsp(['self', 'inspect', '--target', 'overridden'], fixture.env)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('asp self inspect — overridden')
  })

  test('renders hook-injected live env without launch artifact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asp-self-live-'))
    tempDirs.push(dir)
    const agentsRoot = join(dir, 'agents')
    await mkdir(join(agentsRoot, 'cody'), { recursive: true })

    const result = runAsp(['self', 'inspect'], {
      ASP_AGENT_ID: 'cody',
      ASP_AGENTS_ROOT: agentsRoot,
      ASP_HOME: dir,
      ASP_PROJECT: 'agent-spaces',
      ASP_SCOPE_REF: 'agent:cody:project:agent-spaces:task:codex-test',
      ASP_TASK_ID: 'codex-test',
      HRC_SESSION_REF: 'agent:cody:project:agent-spaces:task:codex-test/lane:main',
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('asp self inspect — cody')
    expect(result.stdout).toContain('source:      live-env')
    expect(result.stdout).toContain('project:     agent-spaces')
    expect(result.stdout).toContain('ASP_SCOPE_REF')
    expect(result.stdout).toContain('HRC_SESSION_REF')
    expect(result.stdout).toContain('agent-root:')
    expect(result.stdout).toContain(join(agentsRoot, 'cody'))
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
