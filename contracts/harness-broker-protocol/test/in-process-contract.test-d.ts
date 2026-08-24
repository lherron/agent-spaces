import type {
  AgentHarnessSpec,
  HarnessInvocationSpec,
  HarnessSdkSpec,
  HarnessTransportSpec,
} from '../src/index.js'

const inProcessTransport = {
  kind: 'in-process',
} satisfies HarnessTransportSpec

const piSdk = {
  runtime: 'pi-sdk',
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-5',
  authMode: 'api-key',
  thinkingLevel: 'medium',
} satisfies HarnessSdkSpec

const semanticAgent = {
  agentId: 'cody',
  projectId: 'agent-spaces',
  runMode: 'task',
  scopeRef: 'agent:cody:project:agent-spaces:task:T-07532',
} satisfies AgentHarnessSpec

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
  agent: semanticAgent,
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
  authMode: 'api-key',
}
void invalidSdkRuntime
