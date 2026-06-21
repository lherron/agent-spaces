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
const AMBIENT_OR_CREDENTIAL_KEYS = [
  'ASP_FAKE_SECRET_TOKEN',
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'SSH_AUTH_SOCK',
  'GITHUB_TOKEN',
  'AGENT_SCOPE_REF',
  'AGENT_LANE_REF',
  'AGENT_HOST_SESSION_ID',
]

function jsonAfterHeading(stdout: string, heading: string): any {
  const headingIndex = stdout.indexOf(heading)
  if (headingIndex === -1) {
    throw new Error(`Missing debug heading: ${heading}`)
  }
  const jsonStart = stdout.indexOf('{', headingIndex)
  if (jsonStart === -1) {
    throw new Error(`Missing JSON after heading: ${heading}`)
  }

  let depth = 0
  let inString = false
  let escaped = false
  for (let index = jsonStart; index < stdout.length; index += 1) {
    const char = stdout[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return JSON.parse(stdout.slice(jsonStart, index + 1))
      }
    }
  }

  throw new Error(`Unterminated JSON after heading: ${heading}`)
}

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
  test('prints compiler request and response for headless Codex without ambient env in the spec', async () => {
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
      expect(result.stdout).toContain('RuntimeCompileRequest')
      expect(result.stdout).toContain('RuntimeCompileResponse')
      expect(result.stdout).toContain('"ok": true')
      expect(result.stdout).toContain('"kind": "harness-broker"')

      const response = jsonAfterHeading(result.stdout, 'RuntimeCompileResponse')
      const profile = response.plan.executionProfiles.find(
        (candidate: { kind?: string }) => candidate.kind === 'harness-broker'
      )
      const lockedEnv = profile.harnessInvocation.startRequest.spec.process.lockedEnv

      expect(response.plan.lockedEnv.lockedEnvKeys.length).toBeGreaterThan(0)
      expect(lockedEnv).toEqual(expect.objectContaining({ ASP_HOME: fixture.aspHome }))
      for (const key of AMBIENT_OR_CREDENTIAL_KEYS) {
        expect(lockedEnv).not.toHaveProperty(key)
      }
      expect(Object.values(lockedEnv)).not.toContain(SECRET_VALUE)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('maps pi-sdk --no-interactive to nonInteractive while codex stays headless', async () => {
    const fixture = await setupProject()
    try {
      const piSdkResult = runAsp(
        [
          'run',
          'alice@debug-project',
          'hi',
          '--dry-run',
          '--debug',
          '--no-interactive',
          '--no-refresh',
          '--harness',
          'pi-sdk',
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
          },
        }
      )
      const codexResult = runAsp(
        [
          'run',
          'alice@debug-project',
          'hi',
          '--dry-run',
          '--debug',
          '--no-interactive',
          '--no-refresh',
          '--harness',
          'codex',
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
          },
        }
      )

      expect(piSdkResult.exitCode).toBe(0)
      expect(codexResult.exitCode).toBe(0)

      const piSdkRequest = jsonAfterHeading(piSdkResult.stdout, 'RuntimeCompileRequest')
      const codexRequest = jsonAfterHeading(codexResult.stdout, 'RuntimeCompileRequest')

      expect(piSdkRequest.requested).toEqual(
        expect.objectContaining({
          modelProvider: 'openai',
          harnessFamily: 'pi',
          preferredHarnessRuntime: 'pi-sdk',
          interactionMode: 'nonInteractive',
        })
      )
      expect(codexRequest.requested).toEqual(
        expect.objectContaining({
          modelProvider: 'openai',
          harnessFamily: 'codex',
          preferredHarnessRuntime: 'codex-cli',
          interactionMode: 'headless',
        })
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})
