import type {
  CompiledRuntimePlan,
  HarnessId,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
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

type _HarnessIdIsClosed = Expect<Equal<HarnessId, 'agent-harness' | 'claude' | 'codex' | 'muse'>>

// @ts-expect-error v2 is the canonical public vocabulary; suffixed aliases are not retained.
type _NoSuffixedV2Request = import('spaces-runtime-contracts').RuntimeCompileRequestV2
// @ts-expect-error Retired route-selection entries are not part of the public contract surface.
type _NoRouteCatalogEntry = import('spaces-runtime-contracts').RuntimeRouteCatalogEntry
// @ts-expect-error Retired family selection is private legacy vocabulary.
type _NoHarnessFamily = import('spaces-runtime-contracts').HarnessFamily
// @ts-expect-error The pre-v2 compiler policy is private legacy vocabulary.
type _NoCompiledAgentPolicy = import('spaces-runtime-contracts').CompiledAgentPolicy
// @ts-expect-error Route-decision selection is not a root public contract.
type _NoRuntimeRouteDecision = import('spaces-runtime-contracts').RuntimeRouteDecision
// @ts-expect-error The compile/run callback bridge was retired with v1 selection.
type _NoCompileRuntimeFn = import('spaces-runtime-contracts').CompileRuntimeFn
void (0 as unknown as _NoSuffixedV2Request)
void (0 as unknown as _NoRouteCatalogEntry)
void (0 as unknown as _NoHarnessFamily)
void (0 as unknown as _NoCompiledAgentPolicy)
void (0 as unknown as _NoRuntimeRouteDecision)
void (0 as unknown as _NoCompileRuntimeFn)
