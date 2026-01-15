/**
 * Tests for git exec module.
 *
 * WHY: These tests verify that git commands are executed safely
 * and return proper results with error handling.
 */

import { describe, expect, it } from 'bun:test'
import { gitExec, gitExecLines, gitExecStdout } from './exec.js'

describe('gitExec', () => {
  it('should execute git version and return result', async () => {
    const result = await gitExec(['--version'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('git version')
  })

  it('should handle non-zero exit codes with ignoreExitCode', async () => {
    const result = await gitExec(['status', '--invalid-flag'], {
      ignoreExitCode: true,
    })
    expect(result.exitCode).not.toBe(0)
  })

  it('should throw GitError on failed commands', async () => {
    await expect(gitExec(['status', '--invalid-flag'])).rejects.toThrow()
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
  it('should return array of lines', async () => {
    // List git config as it reliably returns multiple lines
    const lines = await gitExecLines(['config', '--list'])
    expect(Array.isArray(lines)).toBe(true)
    expect(lines.length).toBeGreaterThan(0)
  })

  it('should filter empty lines', async () => {
    const lines = await gitExecLines(['--version'])
    expect(lines.every((line) => line.length > 0)).toBe(true)
  })
})
