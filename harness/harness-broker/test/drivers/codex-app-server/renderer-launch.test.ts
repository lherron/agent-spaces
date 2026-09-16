/**
 * T-08554 — the codex-app-server viewer renderer launch. A standalone ASP
 * release is a bun-compiled payload with no renderer entry file on disk, so it
 * launches the renderer through its own executable (`<payload> renderer …`);
 * checkout and package brokers keep `bun <entry>`.
 */
import { describe, expect, test } from 'bun:test'

import { buildRendererLaunchCommand } from '../../../src/drivers/codex-app-server/renderer'

const repoRoot = new URL('../../../../..', import.meta.url).pathname

const flags = {
  invocationId: 'inv-1',
  observerSocketPath: '/run/o.sock',
  controlSocketPath: '/run/c.sock',
  runtimeId: 'rt-1',
}

describe('codex-app-server renderer launch (T-08554)', () => {
  test('without a launcher the renderer entry file runs under bun', () => {
    const command = buildRendererLaunchCommand({ ...flags, rendererEntryPath: '/src/entry.ts' })
    expect(command.startsWith('exec bun /src/entry.ts --driver codex-app-server')).toBe(true)
  })

  test('a launcher runs the renderer through that executable, with the same flags', () => {
    const command = buildRendererLaunchCommand({
      ...flags,
      launcher: { command: '/rel/A/libexec/harness-broker', args: ['renderer'] },
    })
    expect(command).toBe(
      'exec /rel/A/libexec/harness-broker renderer --driver codex-app-server --invocation-id inv-1 --observer-socket /run/o.sock --control-socket /run/c.sock --runtime-id rt-1 --bootstrap-method invocation.eventsSince --live-method invocation.event'
    )
    expect(command).not.toContain('bun')
  })

  test('the broker CLI renderer subcommand runs the renderer entry', () => {
    const result = Bun.spawnSync({
      cmd: [
        'bun',
        'harness/harness-broker/bin/harness-broker.js',
        'renderer',
        '--driver',
        'codex-app-server',
      ],
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain(
      'codex-app-server renderer requires --invocation-id, --observer-socket, and --control-socket'
    )
  })
})
