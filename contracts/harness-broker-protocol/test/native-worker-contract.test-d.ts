import type {
  AgentHarnessSpec,
  ChildHarnessProcessSpec,
  HarnessInvocationSpec,
  HarnessSdkSpec,
  NativeWorkerProcessSpec,
} from '../src/index.js'

const sdk = {
  runtime: 'pi-sdk',
  provider: 'openai',
  modelId: 'openai/gpt-5.6-terra',
  authMode: 'oauth',
} satisfies HarnessSdkSpec

const agent = {
  agentId: 'sparky',
  projectId: 'agent-spaces',
  runMode: 'task',
} satisfies AgentHarnessSpec

const worker = {
  execution: 'native-worker',
  cwd: '/workspace/project',
  harnessTransport: { kind: 'native-worker' },
} satisfies NativeWorkerProcessSpec

const nativeInvocation = {
  specVersion: 'harness-broker.invocation/v1',
  harness: { frontend: 'agent-harness-tui', provider: 'openai', driver: 'agent-harness' },
  process: worker,
  interaction: { mode: 'headless' },
  driver: { kind: 'agent-harness', permissionPolicy: { mode: 'deny' } },
  sdk,
  agent,
} satisfies HarnessInvocationSpec
void nativeInvocation

const childCannotUseNativeTransport: HarnessInvocationSpec = {
  specVersion: 'harness-broker.invocation/v1',
  harness: { frontend: 'codex', driver: 'codex-app-server' },
  // @ts-expect-error native-worker belongs only to the no-child process alternative.
  process: {
    command: 'codex',
    args: [],
    cwd: '/workspace/project',
    harnessTransport: { kind: 'native-worker' },
  },
  driver: { kind: 'codex-app-server' },
}
void childCannotUseNativeTransport

const workerCannotDeclareCommand: NativeWorkerProcessSpec = {
  execution: 'native-worker',
  cwd: '/workspace/project',
  harnessTransport: { kind: 'native-worker' },
  // @ts-expect-error native workers have no child command.
  command: 'agent-harness',
}
void workerCannotDeclareCommand

const workerCannotDeclareArgs: NativeWorkerProcessSpec = {
  execution: 'native-worker',
  cwd: '/workspace/project',
  harnessTransport: { kind: 'native-worker' },
  // @ts-expect-error native workers have no child args.
  args: [],
}
void workerCannotDeclareArgs

const childCannotDeclareExecution: ChildHarnessProcessSpec = {
  command: 'codex',
  args: [],
  cwd: '/workspace/project',
  harnessTransport: { kind: 'jsonrpc-stdio' },
  // @ts-expect-error child processes cannot claim release-owned execution.
  execution: 'native-worker',
}
void childCannotDeclareExecution
