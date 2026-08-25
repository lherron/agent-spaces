import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ASP_CLI = join(import.meta.dirname, '..', '..', 'bin', 'asp.js')

function runAsp(
  args: string[],
  options: { env?: Record<string, string>; cwd?: string } = {}
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('bun', ['run', ASP_CLI, ...args], {
      cwd: options.cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, ...options.env, NO_COLOR: '1' },
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'asp-run-agent-harness-'))
  const project = join(root, 'project')
  const agents = join(root, 'agents')
  const agent = join(agents, 'alice')
  const aspHome = join(root, 'asp-home')
  await mkdir(project)
  await mkdir(agent, { recursive: true })
  await mkdir(aspHome)
  await writeFile(join(project, 'asp-targets.toml'), 'schema = 1\n')
  await writeFile(
    join(agent, 'agent-profile.toml'),
    'version = 3\n[provisioning]\nharness = "agent-harness"\nmodel = "gpt-5.6-sol"\n'
  )
  return { root, project, agents, aspHome }
}

describe('asp run direct agent-harness planning', () => {
  test('prints a direct TUI launch without materializing a compiler bundle', async () => {
    const testFixture = await fixture()
    try {
      const result = runAsp(
        [
          'run',
          'alice',
          '--print-command',
          '--project',
          testFixture.project,
          '--asp-home',
          testFixture.aspHome,
        ],
        { cwd: testFixture.project, env: { ASP_AGENTS_ROOT: testFixture.agents } }
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('agent-harness tui --agent-id alice')
      expect(result.stdout).toContain(`--asp-home ${testFixture.aspHome}`)
      expect(result.stdout).not.toContain('RuntimeCompileRequest')
      expect(await Bun.file(join(testFixture.aspHome, 'projects')).exists()).toBe(false)
    } finally {
      await rm(testFixture.root, { recursive: true, force: true })
    }
  })

  test('maps print mode and both resume selectors, and rejects compiler-only flags', async () => {
    const testFixture = await fixture()
    try {
      const common = [
        '--project',
        testFixture.project,
        '--asp-home',
        testFixture.aspHome,
        '--print-command',
      ]
      const print = runAsp(['run', 'alice', 'hello', '--no-interactive', ...common], {
        cwd: testFixture.project,
        env: { ASP_AGENTS_ROOT: testFixture.agents },
      })
      expect(print.exitCode).toBe(0)
      expect(print.stdout).toContain('agent-harness print --agent-id alice')
      expect(print.stdout).toContain(' hello')

      const recent = runAsp(['run', 'alice', '--resume', ...common], {
        cwd: testFixture.project,
        env: { ASP_AGENTS_ROOT: testFixture.agents },
      })
      expect(recent.exitCode).toBe(0)
      expect(recent.stdout).toContain(' --resume')

      const explicit = runAsp(['run', 'alice', '--resume', 'session.jsonl', ...common], {
        cwd: testFixture.project,
        env: { ASP_AGENTS_ROOT: testFixture.agents },
      })
      expect(explicit.exitCode).toBe(0)
      expect(explicit.stdout).toContain('--resume session.jsonl')

      const rejected = runAsp(['run', 'alice', '--debug', ...common], {
        cwd: testFixture.project,
        env: { ASP_AGENTS_ROOT: testFixture.agents },
      })
      expect(rejected.exitCode).not.toBe(0)
      expect(rejected.stderr).toContain('compiler-only option: --debug')
    } finally {
      await rm(testFixture.root, { recursive: true, force: true })
    }
  })

  test('rejects an explicit direct harness for a global space target', () => {
    const result = runAsp([
      'run',
      'space:base@dev',
      '--harness',
      'agent-harness',
      '--print-command',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('requires a validated agent profile')
  })
})
