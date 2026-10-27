/**
 * Tests for git exec module.
 *
 * WHY: These tests verify that git commands are executed safely
 * and return proper results with error handling.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitError } from '../core/errors.js'
import { gitExec, gitExecLines, gitExecStdout } from './exec.js'
import { initRepo } from './repo.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('gitExec', () => {
  it('should handle non-zero exit codes with ignoreExitCode', async () => {
    const result = await gitExec(['status', '--invalid-flag'], {
      ignoreExitCode: true,
    })
    expect(result.exitCode).not.toBe(0)
  })

  it('a failed git command rejects with a GitError carrying its exit code and stderr', async () => {
    let caught: unknown
    try {
      await gitExec(['status', '--invalid-flag'])
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(GitError)
    const gitError = caught as GitError
    expect(gitError.exitCode).not.toBe(0)
    expect(gitError.command).toContain('status --invalid-flag')
    expect(gitError.stderr).toContain('invalid-flag')
  })
})

describe('gitExecStdout', () => {
  it('should return trimmed stdout', async () => {
    const stdout = await gitExecStdout(['--version'])
    expect(stdout).toContain('git version')
    expect(stdout).not.toEndWith('\n')
  })
})

describe('gitExecLines', () => {
  it('drops blank lines inside multi-line git output', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'asp-git-exec-lines-'))
    roots.push(repo)
    await initRepo(repo, { initialBranch: 'main' })
    for (const subject of ['first', 'second']) {
      await gitExec(
        [
          '-c',
          'user.email=exec@example.test',
          '-c',
          'user.name=Exec Test',
          'commit',
          '--allow-empty',
          '-m',
          subject,
        ],
        { cwd: repo }
      )
    }

    // %n after each subject puts a blank line between entries.
    const lines = await gitExecLines(['log', '-2', '--format=%s%n'], { cwd: repo })
    expect(lines).toEqual(['second', 'first'])
  })
})
