/**
 * RED acceptance bar for T-04150: `asp doctor` model provenance audit.
 *
 * PASS CONDITIONS:
 * 1. `asp doctor --json` emits a structured model-audit check with rows for
 *    resolved project agent profiles.
 * 2. Each row carries sourceModel, resolvedModel, launchModel, sourceMode,
 *    and identityMode so benchmark provenance can distinguish aliases from
 *    full model identities.
 * 3. Alias use is observable but not fatal by itself.
 */

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ASP_CLI = join(import.meta.dirname, '..', '..', 'bin', 'asp.js')
const CLAUDE_SHIM_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'integration-tests',
  'fixtures',
  'claude-shim'
)

function runAsp(
  args: string[],
  options: { env?: Record<string, string> } = {}
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('bun', ['run', ASP_CLI, ...args], {
      encoding: 'utf8',
      timeout: 30000,
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

describe('asp doctor model audit (T-04150)', () => {
  test('reports alias source model separately from canonical launch identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asp-doctor-model-audit-'))
    const aspHome = join(root, 'asp-home')
    const projectDir = join(root, 'project')
    const agentDir = join(projectDir, 'agents', 'bench-opus')

    try {
      await mkdir(agentDir, { recursive: true })
      await writeFile(
        join(projectDir, 'asp-targets.toml'),
        `
schema = 1
agents-root = "./agents"

[targets.bench-opus]
compose = []
`
      )
      await writeFile(
        join(agentDir, 'agent-profile.toml'),
        `
schema_version = 2

[identity]
harness = "claude-code"

[harnessDefaults]
model = "opus"
`
      )
      await writeFile(join(agentDir, 'SOUL.md'), 'bench-opus fixture\n')

      const result = runAsp(['doctor', '--project', projectDir, '--asp-home', aspHome, '--json'], {
        env: {
          ASP_HOME: aspHome,
          PATH: `${CLAUDE_SHIM_DIR}:${process.env.PATH ?? ''}`,
        },
      })

      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout) as {
        checks: Array<{
          name: string
          status: string
          data?: {
            modelAudit?: Array<Record<string, unknown>>
          }
        }>
      }
      const modelAuditCheck = parsed.checks.find((check) => check.name === 'model_audit')

      expect(modelAuditCheck).toEqual(
        expect.objectContaining({
          status: 'ok',
          data: expect.objectContaining({
            modelAudit: expect.arrayContaining([
              expect.objectContaining({
                agentId: 'bench-opus',
                harnessId: 'claude',
                frontend: 'claude-code',
                sourceModel: 'opus',
                resolvedModel: 'claude-opus-4-6',
                launchModel: 'claude-opus-4-6',
                sourceMode: 'explicit_profile',
                identityMode: 'alias',
                status: 'ok',
              }),
            ]),
          }),
        })
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
