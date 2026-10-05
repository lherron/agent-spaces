/** HRC tmux-pane viewer leases and a logging fake `tmux` for the app-server viewer tests. */
import { expect } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  InvocationEventEnvelope,
  InvocationRuntimeContext,
} from 'spaces-harness-broker-protocol'
import type { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { createCodexAppServerDriver } from '../../../src/drivers/codex-app-server/driver'
import { now, scenarioSpec } from './fake-codex-scenario'

type TerminalSurfaceLease = NonNullable<InvocationRuntimeContext['terminalSurface']>
type ViewerRuntime = InvocationRuntimeContext & {
  terminalSurfaceRequired?: true | undefined
}

export const paneLease = (overrides: Partial<TerminalSurfaceLease> = {}): TerminalSurfaceLease => ({
  kind: 'tmux-pane',
  ownership: 'hrc',
  socketPath: '/tmp/harness-broker/codex-app-server-viewer.sock',
  sessionId: '$9',
  windowId: '@4',
  paneId: '%42',
  sessionName: 'hrc-owned-codex-app-server',
  windowName: 'tui',
  allowedOps: { inspect: true, sendInput: true, sendInterrupt: true },
  ...overrides,
})

export const viewerRuntime = (
  terminalSurface?: unknown,
  options: { required?: boolean } = {}
): ViewerRuntime =>
  ({
    ...(terminalSurface !== undefined ? { terminalSurface } : {}),
    ...(options.required === true ? { terminalSurfaceRequired: true } : {}),
  }) as ViewerRuntime

/** Put a fake `tmux` first on PATH that logs argv and reports `inspected` pane ids. */
export async function withFakeTmux<T>(
  inspected: { sessionId: string; windowId: string; paneId: string },
  fn: (logPath: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-app-server-tmux-'))
  const tmuxPath = join(dir, 'tmux')
  const logPath = join(dir, 'tmux.log')
  await writeFile(
    tmuxPath,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$1" == "-S" ]]; then
  shift 2
fi
if [[ "$1" == "display-message" ]]; then
  printf '%s\\t%s\\t%s\\n' '${inspected.sessionId}' '${inspected.windowId}' '${inspected.paneId}'
  exit 0
fi
if [[ "$1" == "load-buffer" ]]; then
  input_path="\${@: -1}"
  printf 'loaded-buffer %s\\n' "$(cat "$input_path")" >> ${JSON.stringify(logPath)}
  exit 0
fi
if [[ "$1" == "delete-buffer" || "$1" == "paste-buffer" || "$1" == "send-keys" ]]; then
  exit 0
fi
printf 'unexpected fake tmux argv: %s\\n' "$*" >&2
exit 64
`
  )
  await chmod(tmuxPath, 0o755)

  const previousPath = process.env['PATH']
  process.env['PATH'] =
    previousPath === undefined || previousPath.length === 0 ? dir : `${dir}:${previousPath}`
  try {
    return await fn(logPath)
  } finally {
    if (previousPath === undefined) {
      process.env['PATH'] = undefined
    } else {
      process.env['PATH'] = previousPath
    }
    await rm(dir, { recursive: true, force: true })
  }
}

export const tmuxLines = async (logPath: string): Promise<string[]> =>
  (await readFile(logPath, 'utf8').catch(() => ''))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

export function rendererLaunchLines(lines: string[]): string[] {
  return lines.filter(
    (line) =>
      line.includes('loaded-buffer') &&
      line.includes('codex-app-server') &&
      line.includes('renderer')
  )
}

export function expectRendererControlSocket(lines: string[]): string {
  const launch = rendererLaunchLines(lines)[0]
  expect(launch, `tmux log:\n${lines.join('\n')}`).toBeDefined()
  const match = launch?.match(/--control-socket\s+(?:"([^"]+)"|'([^']+)'|(\S+))/)
  expect(
    match?.[1] ?? match?.[2] ?? match?.[3],
    `renderer launch must include a fenced inbound --control-socket; tmux log:\n${lines.join('\n')}`
  ).toBeDefined()
  return (match?.[1] ?? match?.[2] ?? match?.[3]) as string
}

const createDriverCtx = (events: InvocationEventEnvelope[], runtime: ViewerRuntime) =>
  ({
    invocationId: 'inv_direct_viewer_required',
    clientCapabilities: {},
    runtime,
    emit(type: InvocationEventEnvelope['type'], payload: unknown, extra?: Record<string, unknown>) {
      const event = {
        invocationId: 'inv_direct_viewer_required',
        seq: events.length + 1,
        time: now().toISOString(),
        type,
        payload,
        ...extra,
      } as InvocationEventEnvelope
      events.push(event)
      return event
    },
  }) as Parameters<ReturnType<typeof createCodexAppServerDriver>['start']>[1]

/** Start the driver directly (no broker) and expect `runtime` to be rejected. */
export async function expectDirectStartRejects(
  runtime: ViewerRuntime,
  expected: { code: BrokerErrorCode }
): Promise<InvocationEventEnvelope[]> {
  const events: InvocationEventEnvelope[] = []
  const driver = createCodexAppServerDriver()
  try {
    await expect(
      driver.start(scenarioSpec('start-fresh-turn'), createDriverCtx(events, runtime))
    ).rejects.toMatchObject(expected)
  } finally {
    await driver.dispose()
  }
  return events
}
