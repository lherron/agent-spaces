/**
 * T-08556 — the interactive codex-app-server TUI launch. A standalone ASP
 * release is a bun-compiled payload with no codex-tui wrapper entry file on disk
 * (`/$bunfs/root/codex-tui-wrapper`), so it runs the wrapper and the codex hook
 * receiver through its own executable; checkout and package brokers keep
 * `<execPath> <wrapper entry>` and PATH `harness-broker codex-hook`.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildCodexTuiHookReceiverArgv,
  buildCodexTuiWrapperArgvPrefix,
  resolveCodexTuiWrapperEntryPath,
} from '../../../src/drivers/codex-app-server/codex-tui-wrapper'
import { writeTmuxLaunchExecFiles } from '../../../src/runtime/tmux-launch-exec'

const repoRoot = new URL('../../../../..', import.meta.url).pathname

describe('codex-app-server codex-tui launch (T-08556)', () => {
  test('without a launcher the wrapper entry file runs under the current executable', () => {
    expect(buildCodexTuiWrapperArgvPrefix(undefined, '/usr/bin/bun')).toEqual([
      '/usr/bin/bun',
      resolveCodexTuiWrapperEntryPath(),
    ])
    expect(buildCodexTuiHookReceiverArgv(undefined, '/run/h.sock')).toEqual([
      'harness-broker',
      'codex-hook',
      '--socket',
      '/run/h.sock',
    ])
  })

  test('a launcher runs the wrapper and hook receiver through that executable', () => {
    const launcher = { command: '/rel/B/libexec/harness-broker' }
    expect(buildCodexTuiWrapperArgvPrefix(launcher, '/usr/bin/bun')).toEqual([
      '/rel/B/libexec/harness-broker',
      'codex-tui-wrapper',
    ])
    expect(buildCodexTuiHookReceiverArgv(launcher, '/run/h.sock')).toEqual([
      '/rel/B/libexec/harness-broker',
      'codex-hook',
      '--socket',
      '/run/h.sock',
    ])
  })

  test('the broker CLI codex-tui-wrapper subcommand runs the wrapper entry', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'harness/harness-broker/bin/harness-broker.js', 'codex-tui-wrapper'],
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain(
      'codex-tui wrapper failed: codex-tui wrapper requires --command, --socket, --attach-token, --control-socket, and --invocation-id'
    )
  })

  test('a runner runs the tmux launch runner through that executable; without one, bun <module>', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-tui-launch-'))
    try {
      const input = { argv: ['/bin/true'], cwd: dir }
      const released = await writeTmuxLaunchExecFiles(join(dir, 'r'), input, {
        runner: { command: '/rel/B/libexec/harness-broker', args: ['tmux-launch'] },
      })
      expect(released.commandLine).toBe(
        `exec /rel/B/libexec/harness-broker tmux-launch --launch-file ${join(dir, 'r')}.launch.json`
      )
      const checkout = await writeTmuxLaunchExecFiles(join(dir, 'c'), input)
      expect(checkout.commandLine.startsWith('exec bun ')).toBe(true)
      expect(checkout.commandLine).toContain('tmux-launch-runner')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('the broker CLI tmux-launch subcommand runs the launch runner', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'harness/harness-broker/bin/harness-broker.js', 'tmux-launch'],
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('harness-broker tmux launch: missing --launch-file')
  })
})
