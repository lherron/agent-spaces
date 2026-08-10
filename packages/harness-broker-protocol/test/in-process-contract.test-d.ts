import type { HarnessInvocationSpec, HarnessSdkSpec, HarnessTransportSpec } from '../src/index.js'

const inProcessTransport = {
  kind: 'in-process',
} satisfies HarnessTransportSpec

const piSdk = {
  runtime: 'pi-sdk',
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-5',
  thinkingLevel: 'medium',
} satisfies HarnessSdkSpec

const piSdkInvocation = {
  specVersion: 'harness-broker.invocation/v1',
  harness: {
    frontend: 'pi',
    provider: 'anthropic',
    driver: 'pi-sdk',
  },
  process: {
    command: 'in-process',
    args: [],
    cwd: '/workspace/project',
    harnessTransport: inProcessTransport,
  },
  driver: { kind: 'pi-sdk' },
  sdk: piSdk,
} satisfies HarnessInvocationSpec

void piSdkInvocation

// @ts-expect-error EXCEPTION(T-07178): process remains required for in-process invocations.
const missingProcess: HarnessInvocationSpec = {
  specVersion: 'harness-broker.invocation/v1',
  harness: { frontend: 'pi', driver: 'pi-sdk' },
  driver: { kind: 'pi-sdk' },
  sdk: piSdk,
}
void missingProcess

const invalidSdkRuntime: HarnessSdkSpec = {
  // @ts-expect-error EXCEPTION(T-07178): pi-sdk is the only admitted SDK runtime.
  runtime: 'other-sdk',
  provider: 'anthropic',
  modelId: 'model',
}
void invalidSdkRuntime
