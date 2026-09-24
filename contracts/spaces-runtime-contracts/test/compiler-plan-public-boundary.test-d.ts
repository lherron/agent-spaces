import type {
  CompiledExecution,
  CompiledRuntimePlan,
  CompiledRuntimePlanRecord,
  HarnessId,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
  SchemaVersion,
} from 'spaces-runtime-contracts'

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <
  Value,
>() => Value extends Right ? 1 : 2
  ? true
  : false
type Expect<Value extends true> = Value

type _CanonicalRequestIsV2 = Expect<
  Equal<RuntimeCompileRequest['schemaVersion'], 'agent-runtime-compile-request/v2'>
>
type _CanonicalResponseIsV2 = Expect<
  Equal<RuntimeCompileResponse['schemaVersion'], 'agent-runtime-compile-response/v2'>
>
type _CanonicalPlanIsV2 = Expect<
  Equal<CompiledRuntimePlan['schemaVersion'], 'agent-runtime-plan/v2'>
>
type _CanonicalExecutionCarriesTheSingleDispatch = Expect<
  Equal<
    CompiledExecution['dispatchRequest']['startRequest'],
    import('spaces-harness-broker-protocol').InvocationStartRequest
  >
>
type _PersistedPlanIsV2 = Expect<
  Equal<CompiledRuntimePlanRecord['schemaVersion'], 'agent-runtime-plan/v2'>
>
type _NoV1CompileSchemas = Expect<
  Equal<
    Extract<
      SchemaVersion,
      | 'agent-runtime-compile-request/v1'
      | 'agent-runtime-compile-response/v1'
      | 'agent-runtime-plan/v1'
      | 'agent-runtime-profile/v1'
    >,
    never
  >
>

type _HarnessIdIsClosed = Expect<Equal<HarnessId, 'agent-harness' | 'claude' | 'codex' | 'muse'>>
