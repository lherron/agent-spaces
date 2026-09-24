import type {
  AgentHarnessSpec,
  ChildHarnessProcessSpec,
  HarnessInvocationSpec,
  HarnessProcessSpec,
  HarnessSdkSpec,
  NativeWorkerProcessSpec,
} from '../src/index.js'

type ExpectFalse<Value extends false> = Value
type Assignable<Source, Target> = Source extends Target ? true : false

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

type _ChildCannotUseNativeTransport = ExpectFalse<
  Assignable<
    {
      command: 'codex'
      args: string[]
      cwd: '/workspace/project'
      harnessTransport: { kind: 'native-worker' }
    },
    HarnessProcessSpec
  >
>

type _WorkerCannotDeclareCommand = ExpectFalse<
  Assignable<
    {
      execution: 'native-worker'
      cwd: string
      harnessTransport: { kind: 'native-worker' }
      command: string
    },
    NativeWorkerProcessSpec
  >
>

type _WorkerCannotDeclareArgs = ExpectFalse<
  Assignable<
    {
      execution: 'native-worker'
      cwd: string
      harnessTransport: { kind: 'native-worker' }
      args: string[]
    },
    NativeWorkerProcessSpec
  >
>

type _ChildCannotDeclareExecution = ExpectFalse<
  Assignable<
    {
      command: string
      args: string[]
      cwd: string
      harnessTransport: { kind: 'jsonrpc-stdio' }
      execution: 'native-worker'
    },
    ChildHarnessProcessSpec
  >
>
