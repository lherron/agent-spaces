import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ASP_CLI = join(import.meta.dirname, '..', '..', 'bin', 'asp.js')
const CLI_TEST_TIMEOUT_MS = 60_000

function runAsp(
  args: string[],
  options: { env?: Record<string, string>; expectError?: boolean } = {}
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('bun', ['run', ASP_CLI, ...args], {
      encoding: 'utf8',
      timeout: CLI_TEST_TIMEOUT_MS,
      env: { ...process.env, ...options.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { stdout, stderr: '', exitCode: 0 }
  } catch (err) {
    const error = err as { stdout?: Buffer; stderr?: Buffer; status?: number }
    if (!options.expectError) {
      throw err
    }
    return {
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
      exitCode: error.status ?? 1,
    }
  }
}

describe('T-04150 asp doctor model audit', () => {
  test('doctor JSON reports source, canonical, launch, source mode, and identity mode for profile alias pins', async () => {
    const aspHome = await mkdtemp(join(tmpdir(), 'asp-doctor-model-home-'))
    const projectDir = await mkdtemp(join(tmpdir(), 'asp-doctor-model-project-'))
    try {
      await writeFile(
        join(projectDir, 'asp-targets.toml'),
        [
          'schema = 1',
          'agents-root = "./agents"',
          '',
          '[targets.bench-opus]',
          'compose = []',
          '',
        ].join('\n')
      )
      await mkdir(join(projectDir, 'agents', 'bench-opus'), { recursive: true })
      await writeFile(
        join(projectDir, 'agents', 'bench-opus', 'agent-profile.toml'),
        [
          'schemaVersion = 2',
          '',
          '[identity]',
          'display = "Bench Opus"',
          'harness = "claude-code"',
          '',
          '[harnessDefaults]',
          'model = "opus"',
          '',
        ].join('\n')
      )
      await writeFile(join(projectDir, 'agents', 'bench-opus', 'SOUL.md'), 'benchmark persona\n')

      const result = runAsp(['doctor', '--project', projectDir, '--asp-home', aspHome, '--json'], {
        expectError: true,
      })
      const parsed = JSON.parse(result.stdout) as {
        checks: Array<{
          name: string
          status: string
          data?: {
            modelAudit?: Array<{
              agentId: string
              profilePath: string
              harnessId: string
              frontend: string
              sourceModel?: string
              resolvedModel: string
              launchModel?: string
              sourceMode: string
              identityMode: string
              status: string
            }>
          }
        }>
      }

      const auditCheck = parsed.checks.find((check) => check.name === 'model_audit')
      expect(auditCheck).toEqual(expect.objectContaining({ status: 'warning' }))
      expect(auditCheck?.data?.modelAudit).toContainEqual(
        expect.objectContaining({
          agentId: 'bench-opus',
          profilePath: join(projectDir, 'agents', 'bench-opus', 'agent-profile.toml'),
          harnessId: 'claude',
          frontend: 'claude-code',
          sourceModel: 'opus',
          resolvedModel: 'claude-opus-4-6',
          launchModel: 'opus',
          sourceMode: 'explicit_profile',
          identityMode: 'alias',
          status: 'warning',
        })
      )
    } finally {
      await rm(aspHome, { recursive: true, force: true })
      await rm(projectDir, { recursive: true, force: true })
    }
  })
})
