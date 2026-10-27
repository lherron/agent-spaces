import { expect, test } from 'bun:test'
import {
  IN_PROCESS_TRANSPORT_DRIVER_KINDS,
  NATIVE_WORKER_DRIVER_KINDS,
  SDK_BLOCK_DRIVER_KINDS,
  TMUX_SURFACE_DRIVER_KINDS,
  validateCommand,
} from '../src/index.js'
import { dispatchCommand, specSection62Example, withValueAt } from './schema-test-helpers'

/**
 * The published driver-kind contract sets (TMUX_SURFACE, SDK_BLOCK,
 * NATIVE_WORKER, IN_PROCESS_TRANSPORT) are observable only as `invocation.start`
 * validation outcomes. Each row drives one driver kind through `validateCommand`
 * and reads which kind-specific rules fired.
 */
const TMUX_SURFACE = [
  'claude-code-tmux',
  'codex-cli-tmux',
  'pi-tui-tmux',
  'muse-cli-tmux',
  'agent-harness-tmux',
]
const SDK_BLOCK = ['pi-sdk', 'agent-harness', 'agent-harness-tmux', 'foundry-resident']
const NATIVE_WORKER = ['agent-harness', 'agent-harness-tmux', 'foundry-resident']
const IN_PROCESS_TRANSPORT = ['pi-sdk', 'arris-resident']
// Kinds outside every set are the control rows.
const OUTSIDE_EVERY_SET = ['codex-app-server', 'muse-serve', 'noop-driver']

test('driver kind contract sets retain their published memberships', () => {
  expect([...NATIVE_WORKER_DRIVER_KINDS]).toEqual(NATIVE_WORKER)
  expect([...SDK_BLOCK_DRIVER_KINDS]).toEqual(SDK_BLOCK)
  expect([...IN_PROCESS_TRANSPORT_DRIVER_KINDS]).toEqual(IN_PROCESS_TRANSPORT)
  expect([...TMUX_SURFACE_DRIVER_KINDS]).toEqual(TMUX_SURFACE)
})

const DRIVER_KINDS = [
  ...new Set([
    ...TMUX_SURFACE,
    ...SDK_BLOCK,
    ...NATIVE_WORKER,
    ...IN_PROCESS_TRANSPORT,
    ...OUTSIDE_EVERY_SET,
  ]),
]

/** `path:code` of every issue `invocation.start` raises for this spec, or [] when accepted. */
const startIssues = (spec: unknown): string[] => {
  try {
    validateCommand(dispatchCommand({ startRequest: { spec } }))
    return []
  } catch (error) {
    const issues = (error as { issues?: { path: string; code: string }[] }).issues ?? []
    return issues.map(({ path, code }) => `${path}:${code}`)
  }
}

const specFor = (driverKind: string, field?: readonly string[], value?: unknown): unknown => {
  const spec = withValueAt(
    withValueAt(specSection62Example, ['harness', 'driver'], driverKind),
    ['driver'],
    { kind: driverKind }
  )
  return field === undefined ? spec : withValueAt(spec, field, value)
}

test.each(DRIVER_KINDS)(
  'driver kind %s gets the terminal-surface, sdk, native-worker and in-process rules its contract sets publish',
  (driverKind) => {
    const plain = startIssues(specFor(driverKind))
    const inProcess = startIssues(
      specFor(driverKind, ['process', 'harnessTransport', 'kind'], 'in-process')
    )
    const nativeWorker = startIssues(specFor(driverKind, ['process', 'execution'], 'native-worker'))

    expect({
      requiresTerminalSurface: plain.includes('params.runtime.terminalSurface:required'),
      requiresSdkBlock: plain.includes('params.startRequest.spec.sdk:required'),
      allowsNativeWorkerExecution: !nativeWorker.includes(
        'params.startRequest.spec.process.execution:forbidden'
      ),
      allowsInProcessTransport: !inProcess.some((issue) =>
        issue.startsWith('params.startRequest.spec.process.harnessTransport.kind:')
      ),
    }).toEqual({
      requiresTerminalSurface: TMUX_SURFACE.includes(driverKind),
      requiresSdkBlock: SDK_BLOCK.includes(driverKind),
      allowsNativeWorkerExecution: NATIVE_WORKER.includes(driverKind),
      allowsInProcessTransport: IN_PROCESS_TRANSPORT.includes(driverKind),
    })
  }
)
