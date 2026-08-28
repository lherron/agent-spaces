import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import {
  findForbiddenTestCloneCommands,
  isTestExecutionPath,
  scanTestCloneCommands,
} from './lib/test-no-git-clone.ts'

const repositoryRoot = join(import.meta.dir, '..')

describe('test repository-clone boundary', () => {
  test('recognizes test files, test directories, and official runners', () => {
    expect(isTestExecutionPath('core/config/src/repo.test.ts')).toBeTrue()
    expect(isTestExecutionPath('integration-tests/tests/repo.ts')).toBeTrue()
    expect(isTestExecutionPath('scripts/test-fast.ts')).toBeTrue()
    expect(isTestExecutionPath('core/config/package.json')).toBeTrue()
    expect(isTestExecutionPath('core/config/src/git/repo.ts')).toBeFalse()
  })

  test('finds shell, helper, and subprocess clone commands only on the test surface', () => {
    const shellCommand = ['git', 'clone', 'remote', 'work'].join(' ')
    const helperCommand = ['g', 'it(root, ', "'clone'", ', remote, work)'].join('')
    const subprocessCommand = ['Bun.spawn([', "'git'", ', ', "'clone'", ', remote])'].join('')

    expect(findForbiddenTestCloneCommands('scripts/probe.test.ts', shellCommand)).toHaveLength(1)
    expect(findForbiddenTestCloneCommands('scripts/probe.test.ts', helperCommand)).toHaveLength(1)
    expect(findForbiddenTestCloneCommands('scripts/probe.test.ts', subprocessCommand)).toHaveLength(
      1
    )
    expect(findForbiddenTestCloneCommands('core/config/src/git/repo.ts', shellCommand)).toEqual([])

    const packageManifest = JSON.stringify({ scripts: { test: shellCommand, build: shellCommand } })
    expect(findForbiddenTestCloneCommands('package.json', packageManifest)).toHaveLength(1)
  })

  test('the repository test surface is clean', async () => {
    expect(await scanTestCloneCommands(repositoryRoot)).toEqual([])
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
