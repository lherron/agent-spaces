import type {
  CompiledRuntimePlan,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import type {
  LegacyCompiledRuntimePlan,
  LegacyRuntimeCompileRequest,
  LegacyRuntimeCompileResponse,
} from 'spaces-runtime-contracts/internal/compiler-plan-v1'

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

type _InternalRequestIsV1 = Expect<
  Equal<LegacyRuntimeCompileRequest['schemaVersion'], 'agent-runtime-compile-request/v1'>
>
type _InternalResponseIsV1 = Expect<
  Equal<LegacyRuntimeCompileResponse['schemaVersion'], 'agent-runtime-compile-response/v1'>
>
type _InternalPlanIsV1 = Expect<
  Equal<LegacyCompiledRuntimePlan['schemaVersion'], 'agent-runtime-plan/v1'>
>

// @ts-expect-error Legacy compiler-plan types are not exposed from the root contract package.
type _NoRootLegacyRequest = import('spaces-runtime-contracts').LegacyRuntimeCompileRequest
void (0 as unknown as _NoRootLegacyRequest)
