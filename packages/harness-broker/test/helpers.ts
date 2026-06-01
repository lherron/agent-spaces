import type {
  HarnessInvocationSpec,
  InvocationCapabilities,
  JsonRpcMessage,
  JsonRpcResponse,
} from 'spaces-harness-broker-protocol'
import { CONSERVATIVE_LIFECYCLE_CAPABILITIES } from 'spaces-harness-broker-protocol'

export const noopCapabilities: InvocationCapabilities = {
  input: {
    user: true,
    steer: false,
    appendContext: false,
    localImages: false,
    fileRefs: false,
    queue: false,
  },
  turns: {
    concurrency: 'single',
    interrupt: 'unsupported',
  },
  continuation: {
    supported: false,
  },
  events: {
    assistantDeltas: false,
    toolCalls: false,
    usage: false,
    diagnostics: true,
  },
  control: {
    stop: true,
    dispose: true,
  },
  lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
}

export const noopSpec = (
  overrides: Partial<HarnessInvocationSpec> = {}
): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId: 'inv_noop_1',
  labels: { test: 'phase-1' },
  harness: {
    frontend: 'noop',
    provider: 'test',
    driver: 'noop-driver',
  },
  process: {
    command: 'noop-driver',
    args: [],
    cwd: process.cwd(),
    harnessTransport: { kind: 'pipes' },
  },
  interaction: {
    mode: 'headless',
    turnConcurrency: 'single',
    inputQueue: 'none',
  },
  driver: {
    kind: 'noop-driver',
  },
  ...overrides,
})

export const request = (id: string | number, method: string, params: unknown = {}) =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`

export const notification = (method: string, params: unknown = {}) =>
  `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`

export const parseFrames = (output: string): JsonRpcMessage[] =>
  output
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonRpcMessage)

export const expectResult = <TResult>(
  frame: JsonRpcMessage,
  id: string | number
): JsonRpcResponse<TResult> & { result: TResult } => {
  if (!('id' in frame) || frame.id !== id || !('result' in frame)) {
    throw new Error(`expected result response ${String(id)}, got ${JSON.stringify(frame)}`)
  }
  return frame as JsonRpcResponse<TResult> & { result: TResult }
}

export const expectError = (
  frame: JsonRpcMessage,
  id: string | number | null,
  code: number
): JsonRpcResponse & { error: { code: number; message: string; data?: unknown } } => {
  if (!('id' in frame) || frame.id !== id || !('error' in frame) || frame.error.code !== code) {
    throw new Error(
      `expected error response ${String(id)} code ${code}, got ${JSON.stringify(frame)}`
    )
  }
  return frame as JsonRpcResponse & { error: { code: number; message: string; data?: unknown } }
}
