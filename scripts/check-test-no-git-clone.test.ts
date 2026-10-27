import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { scanTestCloneCommands } from './lib/test-no-git-clone.ts'

const repositoryRoot = join(import.meta.dir, '..')

describe('test repository-clone boundary', () => {
  test('the scan reports clone commands in test files, test dirs, test runners and package test scripts, and nowhere else', async () => {
    // Built from pieces so this file does not itself match the scan.
    const shellCommand = ['git', 'clone', 'remote', 'work'].join(' ')
    const helperCommand = ['g', 'it(root, ', "'clone'", ', remote, work)'].join('')
    const subprocessCommand = ['Bun.spawn([', "'git'", ', ', "'clone'", ', remote])'].join('')
    const root = mkdtempSync(join(tmpdir(), 'asp-no-git-clone-'))
    try {
      const files: Record<string, string> = {
        'scripts/probe.test.ts': [shellCommand, helperCommand, subprocessCommand].join('\n'),
        'integration-tests/tests/repo.ts': shellCommand,
        'scripts/test-fast.ts': shellCommand,
        'core/config/src/git/repo.ts': shellCommand,
        'package.json': JSON.stringify(
          { scripts: { build: shellCommand, test: shellCommand } },
          null,
          2
        ),
      }
      for (const [path, source] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), source)
      }

      const findings = (await scanTestCloneCommands(root)).sort(
        (left, right) => left.path.localeCompare(right.path) || left.line - right.line
      )

      expect(findings).toEqual([
        { path: 'integration-tests/tests/repo.ts', line: 1 },
        // Only the test script is a test execution path; build is not.
        { path: 'package.json', line: 4 },
        { path: 'scripts/probe.test.ts', line: 1 },
        { path: 'scripts/probe.test.ts', line: 2 },
        { path: 'scripts/probe.test.ts', line: 3 },
        { path: 'scripts/test-fast.ts', line: 1 },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the runtime guard rejects clone after Git global options', () => {
    const command = ['cl', 'one'].join('')
    const result = spawnSync(
      join(repositoryRoot, 'scripts', 'test-bin', 'git'),
      ['-c', 'color.ui=false', command, 'unused.invalid'],
      {
        encoding: 'utf8',
        env: { ...process.env, ASP_TEST_REAL_GIT: Bun.which('git') ?? '' },
      }
    )

    expect(result.status).toBe(86)
    expect(result.stderr).toContain('repository cloning is forbidden')
  })
})
