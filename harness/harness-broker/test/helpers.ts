import type {
  HarnessInvocationSpec,
  InvocationCapabilities,
  JsonRpcMessage,
  JsonRpcResponse,
} from 'spaces-harness-broker-protocol'
import { CONSERVATIVE_LIFECYCLE_CAPABILITIES } from 'spaces-harness-broker-protocol'
import type { Driver } from '../src/drivers/driver'
import { BROKER_ONLY_AUTHORITY } from '../src/drivers/evidence-authority'

import { invocationIdFrom } from './ids'

const INHERITED_BROKER_ENV_PREFIXES = ['HARNESS_BROKER_']

export function brokerProcessEnv(
  overrides: Record<string, string | undefined> = {}
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (INHERITED_BROKER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    env[key] = value
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key]
    } else {
      env[key] = value
    }
  }
  return env
}

/**
 * `BrokerClient.start` merges `env` over `process.env` (undefined deletes), so
 * scrubbing inherited session broker wiring needs explicit deletions.
 */
export function brokerClientEnvOverrides(): Record<string, undefined> {
  const overrides: Record<string, undefined> = {}
  for (const key of Object.keys(process.env)) {
    if (INHERITED_BROKER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      overrides[key] = undefined
    }
  }
  return overrides
}

export const noopCapabilities: InvocationCapabilities = {
  admission: { classes: [] },
  bracketMintingMode: 'delivery-acknowledged',
  queue: { cancelHarnessLocal: false },
  preempt: { mode: null },
  steer: { landingEvidence: null },
  interrupt: { landingEvidence: null },
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

/**
 * The static evidence declarations every `Driver` must carry, matching the
 * noop driver: broker-owned evidence, delivery-acknowledged brackets, and no
 * preempt/steer/interrupt landing evidence. Spread into hand-rolled test
 * drivers so they declare the same facts a real driver would.
 */
export const stubDriverDeclarations: Pick<
  Driver,
  | 'bracketMintingMode'
  | 'evidenceAuthority'
  | 'nativeSourceKind'
  | 'preemptMode'
  | 'steerLandingEvidence'
  | 'interruptLandingEvidence'
> = {
  bracketMintingMode: 'delivery-acknowledged',
  evidenceAuthority: BROKER_ONLY_AUTHORITY,
  nativeSourceKind: 'provider-jsonl',
  preemptMode: null,
  steerLandingEvidence: null,
  interruptLandingEvidence: null,
}

export const noopSpec = (
  overrides: Omit<Partial<HarnessInvocationSpec>, 'invocationId'> & { invocationId?: string } = {}
): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
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
  invocationId: invocationIdFrom(overrides.invocationId ?? 'inv_noop_1'),
})

/** An interactive invocation of the in-process test driver (src/testing/test-driver). */
export const testDriverSpec = (invocationId: string): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId: invocationIdFrom(invocationId),
  harness: { frontend: 'test', provider: 'test', driver: 'test-driver' },
  process: {
    command: 'test-driver',
    args: [],
    cwd: process.cwd(),
    harnessTransport: { kind: 'pipes' },
  },
  interaction: { mode: 'interactive', turnConcurrency: 'single', inputQueue: 'fifo' },
  driver: { kind: 'test-driver' },
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
  frame: JsonRpcMessage | undefined,
  id: string | number
): JsonRpcResponse<TResult> & { result: TResult } => {
  if (frame === undefined || !('id' in frame) || frame.id !== id || !('result' in frame)) {
    throw new Error(`expected result response ${String(id)}, got ${JSON.stringify(frame)}`)
  }
  return frame as JsonRpcResponse<TResult> & { result: TResult }
}

export const expectError = (
  frame: JsonRpcMessage | undefined,
  id: string | number | null,
  code: number
): JsonRpcResponse & { error: { code: number; message: string; data?: unknown } } => {
  if (
    frame === undefined ||
    !('id' in frame) ||
    frame.id !== id ||
    !('error' in frame) ||
    frame.error.code !== code
  ) {
    throw new Error(
      `expected error response ${String(id)} code ${code}, got ${JSON.stringify(frame)}`
    )
  }
  return frame as JsonRpcResponse & { error: { code: number; message: string; data?: unknown } }
}
