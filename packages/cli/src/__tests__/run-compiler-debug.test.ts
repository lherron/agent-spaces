import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ASP_CLI = join(import.meta.dirname, '..', '..', 'bin', 'asp.js')
const CODEX_SHIM_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'integration-tests',
  'fixtures',
  'codex-shim'
)
const SECRET_VALUE = 'super-secret-compiler-debug-token'

function runAsp(
  args: string[],
  options: { env?: Record<string, string>; cwd?: string } = {}
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const result = execFileSync('bun', ['run', ASP_CLI, ...args], {
      cwd: options.cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, ...options.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { stdout: result, stderr: '', exitCode: 0 }
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      exitCode: err.status ?? 1,
    }
  }
}

async function setupProject(): Promise<{
  root: string
  aspHome: string
  projectDir: string
  agentsRoot: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'asp-run-compiler-debug-'))
  const aspHome = join(root, 'asp-home')
  const projectDir = join(root, 'project')
  const agentsRoot = join(root, 'agents')
  const agentRoot = join(agentsRoot, 'alice')

  await mkdir(aspHome, { recursive: true })
  await mkdir(projectDir, { recursive: true })
  await mkdir(agentRoot, { recursive: true })
  await writeFile(join(projectDir, 'asp-targets.toml'), 'schema = 1\n')
  await writeFile(join(agentRoot, 'SOUL.md'), 'You are Alice.\n')
  await writeFile(
    join(agentRoot, 'agent-profile.toml'),
    `schemaVersion = 2
priming_prompt = "Profile prompt for {{agentId}}"

[identity]
harness = "codex"

[spaces]
base = []

[brain]
enabled = false

[harnessDefaults]
model = "gpt-5.5"

[harnessDefaults.codex]
model_reasoning_effort = "high"
approval_policy = "never"
sandbox_mode = "workspace-write"
`
  )

  return { root, aspHome, projectDir, agentsRoot }
}

describe('asp run --dry-run --debug compiler dump', () => {
  test('prints redacted compiler request and response for headless Codex', async () => {
    const fixture = await setupProject()
    try {
      const result = runAsp(
        [
          'run',
          'alice@debug-project',
          'hi',
          '--dry-run',
          '--debug',
          '--no-interactive',
          '--no-refresh',
          '--project',
          fixture.projectDir,
          '--asp-home',
          fixture.aspHome,
        ],
        {
          cwd: fixture.projectDir,
          env: {
            ASP_AGENTS_ROOT: fixture.agentsRoot,
            PATH: `${CODEX_SHIM_DIR}:${process.env.PATH ?? ''}`,
            ASP_FAKE_SECRET_TOKEN: SECRET_VALUE,
          },
        }
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('RuntimeCompileRequest (redacted)')
      expect(result.stdout).toContain('RuntimeCompileResponse (redacted)')
      expect(result.stdout).toContain('"ok": true')
      expect(result.stdout).toContain('"kind": "harness-broker"')
      expect(result.stdout).toContain('"redactedStartRequest"')
      expect(result.stdout).not.toContain(SECRET_VALUE)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})
