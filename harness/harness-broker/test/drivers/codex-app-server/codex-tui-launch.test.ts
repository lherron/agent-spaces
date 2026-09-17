/**
 * T-08556 — the interactive codex-app-server TUI launch. A standalone ASP
 * release is a bun-compiled payload with no codex-tui wrapper entry file on disk
 * (`/$bunfs/root/codex-tui-wrapper`), so it runs the wrapper and the codex hook
 * receiver through its own executable; checkout and package brokers keep
 * `<execPath> <wrapper entry>` and PATH `harness-broker codex-hook`.
 */
import { describe, expect, test } from 'bun:test'

import {
  buildCodexTuiHookReceiverArgv,
  buildCodexTuiWrapperArgvPrefix,
  resolveCodexTuiWrapperEntryPath,
} from '../../../src/drivers/codex-app-server/codex-tui-wrapper'

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
})
