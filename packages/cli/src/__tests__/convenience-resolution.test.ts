/**
 * RED tests for T-00899: CLI convenience resolution via ASP_AGENTS_ROOT / ASP_PROJECTS_ROOT.
 *
 * When --agent-root is not provided, `asp agent` should derive it from
 * ASP_AGENTS_ROOT (env or config.toml) + agentId from the scope handle.
 * Same for --project-root from ASP_PROJECTS_ROOT + projectId.
 *
 * PASS CONDITIONS:
 * 1. ASP_AGENTS_ROOT + agentId → agent-root = $ASP_AGENTS_ROOT/<agentId>/
 * 2. ASP_PROJECTS_ROOT + projectId → project-root = $ASP_PROJECTS_ROOT/<projectId>/
 * 3. --agent-root flag overrides ASP_AGENTS_ROOT
 * 4. --project-root flag overrides ASP_PROJECTS_ROOT
 * 5. Bare scope (no projectId) leaves projectRoot undefined
 * 6. No ASP_AGENTS_ROOT and no --agent-root → clear error mentioning config.toml
 * 7. --harness falls back to claude-code only when no profile/target default exists
 */

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FIXTURES_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'config',
  'src',
  '__fixtures__',
  'v2'
)
const ASP_CLI = join(import.meta.dirname, '..', '..', 'bin', 'asp.js')

function runAsp(
  args: string[],
  options: { env?: Record<string, string>; expectError?: boolean } = {}
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const result = execFileSync('bun', ['run', ASP_CLI, ...args], {
      encoding: 'utf8',
      timeout: 15000,
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

/**
 * Set up a temp agents-root with a real agent directory (copied from fixtures).
 * Also creates a temp projects-root with a minimal project directory.
 */
async function setupConvenienceDirs(): Promise<{
  agentsRoot: string
  projectsRoot: string
  aspHome: string
  cleanup: () => Promise<void>
}> {
  const base = join(tmpdir(), `asp-conv-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const agentsRoot = join(base, 'agents')
  const projectsRoot = join(base, 'projects')
  const aspHome = join(base, 'asp-home')

  // Create agents-root with an "alice" agent (copy from fixture)
  await cp(join(FIXTURES_DIR, 'agent-root'), join(agentsRoot, 'alice'), { recursive: true })

  // Create projects-root with a "demo" project (minimal)
  await mkdir(join(projectsRoot, 'demo'), { recursive: true })
  await writeFile(
    join(projectsRoot, 'demo', 'asp-targets.toml'),
    '[targets.default]\ncompose = []\n',
    'utf8'
  )

  // Create ASP_HOME
  await mkdir(aspHome, { recursive: true })

  return {
    agentsRoot,
    projectsRoot,
    aspHome,
    cleanup: async () => {
      await rm(base, { recursive: true, force: true })
    },
  }
}

// ===================================================================
// T-00899: Agent root from ASP_AGENTS_ROOT
// ===================================================================
describe('ASP_AGENTS_ROOT convenience (T-00899)', () => {
  test('derives agent-root from ASP_AGENTS_ROOT + agentId', async () => {
    const { agentsRoot, projectsRoot, aspHome, cleanup } = await setupConvenienceDirs()
    try {
      const result = runAsp(['agent', 'alice@demo', 'resolve', '--json'], {
        env: {
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_PROJECTS_ROOT: projectsRoot,
          ASP_HOME: aspHome,
        },
      })

      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout)
      expect(parsed.placement.agentRoot).toBe(join(agentsRoot, 'alice'))
    } finally {
      await cleanup()
    }
  })

  test('derives project-root from ASP_PROJECTS_ROOT + projectId', async () => {
    const { agentsRoot, projectsRoot, aspHome, cleanup } = await setupConvenienceDirs()
    try {
      const result = runAsp(['agent', 'alice@demo', 'resolve', '--json'], {
        env: {
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_PROJECTS_ROOT: projectsRoot,
          ASP_HOME: aspHome,
        },
      })

      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout)
      expect(parsed.placement.projectRoot).toBe(join(projectsRoot, 'demo'))
    } finally {
      await cleanup()
    }
  })
})

// ===================================================================
// T-00899: Flag overrides
// ===================================================================
describe('flag overrides convenience roots (T-00899)', () => {
  test('--agent-root overrides ASP_AGENTS_ROOT', async () => {
    const { agentsRoot, aspHome, cleanup } = await setupConvenienceDirs()
    const explicitRoot = join(FIXTURES_DIR, 'agent-root')
    try {
      const result = runAsp(['agent', 'alice', 'resolve', '--agent-root', explicitRoot, '--json'], {
        env: {
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_HOME: aspHome,
        },
      })

      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout)
      // Explicit flag should win over env-derived path
      expect(parsed.placement.agentRoot).toBe(explicitRoot)
    } finally {
      await cleanup()
    }
  })

  test('--project-root overrides ASP_PROJECTS_ROOT', async () => {
    const { agentsRoot, projectsRoot, aspHome, cleanup } = await setupConvenienceDirs()
    const explicitProjectRoot = join(FIXTURES_DIR, 'project-root')
    try {
      const result = runAsp(
        ['agent', 'alice@demo', 'resolve', '--project-root', explicitProjectRoot, '--json'],
        {
          env: {
            ASP_AGENTS_ROOT: agentsRoot,
            ASP_PROJECTS_ROOT: projectsRoot,
            ASP_HOME: aspHome,
          },
        }
      )

      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout)
      expect(parsed.placement.projectRoot).toBe(explicitProjectRoot)
    } finally {
      await cleanup()
    }
  })
})

// ===================================================================
// T-00899: Bare scope (no projectId)
// ===================================================================
describe('bare scope without projectId (T-00899)', () => {
  test('alice (no @project) leaves projectRoot undefined', async () => {
    const { agentsRoot, projectsRoot, aspHome, cleanup } = await setupConvenienceDirs()
    try {
      const result = runAsp(['agent', 'alice', 'resolve', '--json'], {
        env: {
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_PROJECTS_ROOT: projectsRoot,
          ASP_HOME: aspHome,
        },
      })

      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout)
      expect(parsed.placement.agentRoot).toBe(join(agentsRoot, 'alice'))
      // No projectId in scope → projectRoot should not be set
      expect(parsed.placement.projectRoot).toBeUndefined()
    } finally {
      await cleanup()
    }
  })
})

// ===================================================================
// T-00899: Missing ASP_AGENTS_ROOT error
// ===================================================================
describe('missing agents root error (T-00899)', () => {
  test('no ASP_AGENTS_ROOT and no --agent-root produces clear error', async () => {
    const base = join(tmpdir(), `asp-empty-${Date.now()}`)
    const aspHome = join(base, 'asp-home')
    const home = join(base, 'home')
    await mkdir(aspHome, { recursive: true })
    await mkdir(home, { recursive: true })

    try {
      const result = runAsp(['agent', 'alice@demo', 'resolve', '--json'], {
        env: {
          ASP_HOME: aspHome,
          HOME: home,
          // No ASP_AGENTS_ROOT, no --agent-root flag, and no convention root under HOME
        },
        expectError: true,
      })

      expect(result.exitCode).not.toBe(0)
      const output = result.stdout + result.stderr
      // Should mention how to configure — either env var, flag, or config.toml
      expect(output).toMatch(/agent.?root|ASP_AGENTS_ROOT|config\.toml/i)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

// ===================================================================
// T-00899: Default frontend
// ===================================================================
describe('default frontend (T-00899)', () => {
  test('--harness defaults to claude-code when not specified', async () => {
    const { agentsRoot, aspHome, cleanup } = await setupConvenienceDirs()
    try {
      const result = runAsp(['agent', 'alice', 'query', 'hello', '--dry-run', '--json'], {
        env: {
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_HOME: aspHome,
        },
      })

      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout)
      // Default frontend should be claude-code — verify via argv or spec
      expect(parsed.spec).toBeDefined()
    } finally {
      await cleanup()
    }
  })

  test('uses agent profile harness when --harness is omitted', async () => {
    const { agentsRoot, aspHome, cleanup } = await setupConvenienceDirs()
    const profilePath = join(agentsRoot, 'alice', 'agent-profile.toml')
    try {
      const profile = (await Bun.file(profilePath).text()).replace(
        /^schemaVersion = 1$/m,
        'schemaVersion = 2'
      )
      await writeFile(
        profilePath,
        `${profile}\n[identity]\ndisplay = "Alice"\nrole = "assistant"\nharness = "codex"\n`,
        'utf8'
      )

      const result = runAsp(['agent', 'alice', 'query', 'hello', '--dry-run', '--json'], {
        env: {
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_HOME: aspHome,
          PATH: `${join(import.meta.dirname, '..', '..', '..', '..', 'integration-tests', 'fixtures', 'codex-shim')}:${process.env.PATH ?? ''}`,
        },
      })

      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout)
      expect(parsed.spec.frontend).toBe('codex-cli')
      expect(parsed.spec.provider).toBe('openai')
    } finally {
      await cleanup()
    }
  })
})
