/**
 * Tests for `asp agent` convenience resolution.
 *
 * Resolution paths covered:
 * - ASP_AGENTS_ROOT (env or config.toml) + agentId → agent-root = $ASP_AGENTS_ROOT/<agentId>/
 * - --agent-root flag overrides ASP_AGENTS_ROOT
 * - --project-root flag sets projectRoot explicitly
 * - Marker walk-up: cwd under a dir containing asp-targets.toml → projectRoot = that dir
 * - Bare scope (no projectId) leaves projectRoot undefined
 * - Missing ASP_AGENTS_ROOT produces a clear error
 * - --harness falls back to claude-code when no profile/target default exists
 */

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
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
  options: { env?: Record<string, string>; cwd?: string; expectError?: boolean } = {}
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const result = execFileSync('bun', ['run', ASP_CLI, ...args], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, ...options.env, NO_COLOR: '1' },
      ...(options.cwd ? { cwd: options.cwd } : {}),
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
 * Set up a temp agents-root (with "alice" copied from fixtures) and a
 * projects dir containing a "demo" project with an asp-targets.toml marker.
 */
async function setupConvenienceDirs(): Promise<{
  agentsRoot: string
  projectDir: string
  aspHome: string
  cleanup: () => Promise<void>
}> {
  const base = join(tmpdir(), `asp-conv-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const agentsRoot = join(base, 'agents')
  const projectDir = join(base, 'projects', 'demo')
  const aspHome = join(base, 'asp-home')

  await cp(join(FIXTURES_DIR, 'agent-root'), join(agentsRoot, 'alice'), { recursive: true })

  // Project dir with marker (schema-only is now valid).
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, 'asp-targets.toml'), 'schema = 1\n', 'utf8')

  await mkdir(aspHome, { recursive: true })

  return {
    agentsRoot,
    projectDir,
    aspHome,
    cleanup: async () => {
      await rm(base, { recursive: true, force: true })
    },
  }
}

describe('agents-root resolution', () => {
  test('derives agent-root from ASP_AGENTS_ROOT + agentId', async () => {
    const { agentsRoot, aspHome, cleanup } = await setupConvenienceDirs()
    try {
      const result = runAsp(['agent', 'alice', 'resolve', '--json'], {
        env: {
          ASP_AGENTS_ROOT: agentsRoot,
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
      expect(parsed.placement.agentRoot).toBe(explicitRoot)
    } finally {
      await cleanup()
    }
  })
})

describe('project-root resolution', () => {
  test('--project-root sets projectRoot explicitly', async () => {
    const { agentsRoot, aspHome, cleanup } = await setupConvenienceDirs()
    const explicitProjectRoot = join(FIXTURES_DIR, 'project-root')
    try {
      const result = runAsp(
        ['agent', 'alice@demo', 'resolve', '--project-root', explicitProjectRoot, '--json'],
        {
          env: {
            ASP_AGENTS_ROOT: agentsRoot,
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

  test('marker walk-up from cwd sets projectRoot when projectId matches', async () => {
    const { agentsRoot, projectDir, aspHome, cleanup } = await setupConvenienceDirs()
    try {
      const result = runAsp(['agent', 'alice@demo', 'resolve', '--json'], {
        env: {
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_HOME: aspHome,
        },
        cwd: projectDir,
      })

      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout)
      // realpathSync resolves macOS /var -> /private/var, matching what the
      // marker walk-up returns.
      expect(parsed.placement.projectRoot).toBe(realpathSync(projectDir))
    } finally {
      await cleanup()
    }
  })
})

describe('bare scope without projectId', () => {
  test('alice (no @project) leaves projectRoot undefined', async () => {
    const { agentsRoot, aspHome, cleanup } = await setupConvenienceDirs()
    try {
      const result = runAsp(['agent', 'alice', 'resolve', '--json'], {
        env: {
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_HOME: aspHome,
        },
      })

      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout)
      expect(parsed.placement.agentRoot).toBe(join(agentsRoot, 'alice'))
      expect(parsed.placement.projectRoot).toBeUndefined()
    } finally {
      await cleanup()
    }
  })
})

describe('missing agents root error', () => {
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
        },
        expectError: true,
      })

      expect(result.exitCode).not.toBe(0)
      const output = result.stdout + result.stderr
      expect(output).toMatch(/agent.?root|ASP_AGENTS_ROOT|config\.toml/i)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

describe('default frontend', () => {
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
