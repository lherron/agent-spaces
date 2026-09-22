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
// @ts-expect-error The v1 execution-profile selection union is internal-only.
type _NoRuntimeExecutionProfile = import('spaces-runtime-contracts').RuntimeExecutionProfile
// @ts-expect-error Generic v1 broker profiles are not accepted at the public participant boundary.
type _NoBrokerExecutionProfile = import('spaces-runtime-contracts').BrokerExecutionProfile
// @ts-expect-error Terminal selection is not part of the v2 root contract.
type _NoTerminalExecutionProfile = import('spaces-runtime-contracts').TerminalExecutionProfile
// @ts-expect-error Command-process selection is not part of the v2 root contract.
type _NoCommandExecutionProfile = import('spaces-runtime-contracts').CommandExecutionProfile
// @ts-expect-error Legacy-exec selection is not part of the v2 root contract.
type _NoLegacyExecutionProfile = import('spaces-runtime-contracts').LegacyExecutionProfile
// @ts-expect-error The v1 profile-kind selection alias is internal-only.
type _NoRuntimeExecutionProfileKind = import('spaces-runtime-contracts').RuntimeExecutionProfileKind
void (0 as unknown as _NoSuffixedV2Request)
void (0 as unknown as _NoRouteCatalogEntry)
void (0 as unknown as _NoHarnessFamily)
void (0 as unknown as _NoCompiledAgentPolicy)
void (0 as unknown as _NoRuntimeRouteDecision)
void (0 as unknown as _NoCompileRuntimeFn)
void (0 as unknown as _NoRuntimeExecutionProfile)
void (0 as unknown as _NoBrokerExecutionProfile)
void (0 as unknown as _NoTerminalExecutionProfile)
void (0 as unknown as _NoCommandExecutionProfile)
void (0 as unknown as _NoLegacyExecutionProfile)
void (0 as unknown as _NoRuntimeExecutionProfileKind)
