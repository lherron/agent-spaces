/**
 * The top-level asp CLI keeps its existing commands working alongside
 * `asp agent` (T-00867): help, diff against a fixture registry, doctor.
 */

import { describe, expect } from 'bun:test'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SAMPLE_FIXTURES_DIR, cliTest, runAsp } from './asp-cli'

/** Run `fn` with fresh temp dirs, removing them afterwards. */
async function withTempDirs<const P extends readonly string[]>(
  prefixes: P,
  fn: (...dirs: { [K in keyof P]: string }) => Promise<void>
) {
  const dirs = await Promise.all(prefixes.map((prefix) => mkdtemp(join(tmpdir(), prefix))))
  try {
    await fn(...(dirs as { [K in keyof P]: string }))
  } finally {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  }
}

/** `asp diff --json` of the dev target against the sample registry. */
function diffDevTarget(projectDir: string, aspHome: string) {
  return runAsp(
    [
      'diff',
      '--project',
      projectDir,
      '--registry',
      join(SAMPLE_FIXTURES_DIR, 'sample-registry'),
      '--target',
      'dev',
      '--json',
    ],
    { ASP_HOME: aspHome }
  )
}

describe('existing CLI compatibility (T-00867)', () => {
  cliTest('asp --help still lists existing commands', () => {
    const result = runAsp(['--help'])
    const output = result.stdout + result.stderr

    expect(output).toMatch(/run/)
    expect(output).toMatch(/install/)
    expect(output).toMatch(/build/)
    expect(output).toMatch(/explain/)
  })

  cliTest('asp run --help still works', () => {
    const result = runAsp(['run', '--help'])

    expect(result.stdout + result.stderr).toMatch(/run|target|space/i)
  })

  cliTest('asp install --help still works', () => {
    const result = runAsp(['install', '--help'])

    expect(result.stdout + result.stderr).toMatch(/install/i)
  })

  cliTest('asp --help includes new agent subcommand', () => {
    const result = runAsp(['--help'])

    expect(result.stdout + result.stderr).toMatch(/agent/i)
  })

  cliTest('asp diff --json reads asp-lock.json instead of the project directory', () =>
    withTempDirs(['asp-diff-home-'], async (aspHome) => {
      const result = diffDevTarget(join(SAMPLE_FIXTURES_DIR, 'sample-project'), aspHome)

      expect(result.stdout + result.stderr).not.toContain(
        "Dist-tag 'stable' not found for space 'frontend'"
      )
      expect(result.exitCode).toBe(0)
      expect(result.stderr).not.toContain('EISDIR')
      expect(JSON.parse(result.stdout)).toMatchObject({
        diffs: [
          {
            target: 'dev',
            changes: expect.arrayContaining([
              expect.objectContaining({ spaceId: 'base', type: 'added' }),
            ]),
          },
        ],
      })
    })
  )

  cliTest('asp diff --json resolves copied project fixtures from explicit registry', () =>
    withTempDirs(['asp-diff-copy-home-', 'asp-diff-copy-project-'], async (aspHome, projectDir) => {
      // T-05831 regression guard: drain worktrees place the project outside the
      // repo fixture tree, so --registry must remain the shared-space source.
      await cp(join(SAMPLE_FIXTURES_DIR, 'sample-project'), projectDir, {
        recursive: true,
      })

      const result = diffDevTarget(projectDir, aspHome)

      expect(result.stdout + result.stderr).not.toContain(
        "Dist-tag 'stable' not found for space 'frontend'"
      )
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        diffs: [
          {
            target: 'dev',
            changes: expect.arrayContaining([
              expect.objectContaining({ spaceId: 'base', type: 'added' }),
              expect.objectContaining({ spaceId: 'frontend', type: 'added' }),
            ]),
          },
        ],
      })
    })
  )

  cliTest('asp doctor rejects spaces as an agent directory name', () =>
    withTempDirs(
      ['asp-doctor-spaces-home-', 'asp-doctor-spaces-project-'],
      async (aspHome, projectDir) => {
        await writeFile(
          join(projectDir, 'asp-targets.toml'),
          'schema = 2\nagents-root = "./agents"\n'
        )
        await mkdir(join(projectDir, 'agents', 'spaces'), { recursive: true })
        await writeFile(
          join(projectDir, 'agents', 'spaces', 'agent-profile.toml'),
          'name = "spaces"\n'
        )

        const result = runAsp(['doctor', '--project', projectDir, '--asp-home', aspHome, '--json'])
        const parsed = JSON.parse(result.stdout) as {
          checks: Array<{ name: string; status: string; message: string }>
        }

        expect(result.exitCode).toBe(1)
        expect(result.stdout + result.stderr).toContain('agent_reserved_name')
        expect(parsed.checks).toContainEqual(
          expect.objectContaining({ name: 'agent_reserved_name', status: 'error' })
        )
      }
    )
  )
})
