# Producer-owned harness selection

- **Status:** approved architecture; implementation pending
- **Tracking:** T-08699 and campaign P-00540
- **Architecture authority:** `agent-spaces.producer-owned-harness-selection`
- **Approval:** Daedalus EN-15959, with Lance's binding four-harness and clean-cutover rulings

## 1. Decision

ASP owns execution selection. A caller selects an agent implementation
(`harness`), an inference service (`modelProvider`), a model within that
service, reasoning effort, and whether the selected harness's operator UI is
requested (`presentation`). The compiler resolves those independent inputs to
one execution recipe. The selected driver, process transport, terminal need,
presentation mechanism, and hosting requirements are producer output.

The public harness vocabulary is exactly:

```ts
type HarnessId = 'agent-harness' | 'claude' | 'codex' | 'muse'
```

`claude-agent-sdk`, `pi`, and `pi-sdk` are not selectable. Old aliases and
frontend names such as `claude-code`, `codex-cli`, `muse-cli`, `agent-sdk`, and
`pi-cli` are not accepted as harness IDs. Their implementation packages may
remain until T-08698, but retained code is not retained selection support.

There is no public family, runtime, frontend, CLI-versus-SDK, interaction,
controller, profile, or driver selector. Provider never selects a fallback
harness. Model never silently selects a provider.

This is an ASP-only clean cutover. HRC migration is not part of P-00540. ASP
publishes the breaking contract; an HRC version that still sends v1 or imports
old selectors is expected to fail until separately migrated.

## 2. Why the selection authority must move

Current production code has overlapping and divergent authorities:

1. `core/config/src/core/types/harness.ts` accepts seven IDs plus aliases and
   maps them to provider, transport, and frontend.
2. `contracts/spaces-runtime-contracts/src/route-catalog.ts` maps
   family/runtime/interaction combinations to drivers and carries Pi
   provider-prefixed model aliases.
3. `compiler/agent-spaces/src/compile-runtime-plan.ts` contains
   `FOREGROUND_ROUTES`, `INTERACTIVE_BROKER_BUILDERS`, provider inference, and
   the actual branch tree.
4. `compiler/agent-spaces/src/broker-invocation.ts` repeats
   driver/provider/frontend/mode/transport combinations.
5. `compiler/agent-spaces/src/client-support.ts` adds `FRONTEND_DEFS`, model
   defaults, and provider-prefixed model parsing.

The public route catalog is already wrong about a material case: it describes
interactive Codex as `codex-cli-tmux`, while the compiler selects
`codex-app-server` with the Codex TUI presentation. A descriptive catalog
outside the compiler therefore cannot remain a selection authority.

Every ordinary production compiler branch currently emits one execution
profile. The plural `executionProfiles` collection and ASPC profile selector
select among choices the producer never actually returns. V2 makes that fact
explicit.

## 3. Package boundaries

| Package | Responsibility after cutover |
| --- | --- |
| `spaces-runtime-contracts` | Public wire vocabulary and resolved-result DTOs only |
| `spaces-config` | Parse and merge profile, project, and directive scalars; no driver or recipe selection |
| `agent-spaces` compiler | Sole harness catalog, resolver, builder registry, materialization, and consistency validation |
| `spaces-aspc` | Validate the RPC envelope, invoke the compiler, return its result; no routing knowledge |
| `aspc-facade` | Bind the compiler-frozen driver to an inspected immutable release worker |
| harness broker | Look up and execute the frozen driver named by the canonical start request |

The closed `HarnessId` union belongs in the public contract package. An ID
union is vocabulary, not a route catalog. Driver selection policy belongs only
in `compiler/agent-spaces`.

ASP production source does not import HRC internals. `bun run
check:boundaries` remains the mechanical boundary gate; the cutover must not
introduce an `hrc-*`, `acp-*`, gateway, coordination-substrate, wrkq-lib, or
wlearn dependency.

## 4. Capability matrix

The matrix below separates the user request from internal terminal mechanics.
`presentation: false` means that no operator UI was requested; it never means
that a terminal required by the chosen implementation is forbidden.

| Harness | `presentation: false` | `presentation: true` | Fulfillment | Later presentation request |
| --- | --- | --- | --- | --- |
| `claude` | `claude-code-tmux`; broker process; PTY; tmux terminal required | Same recipe and same terminal requirement | `intrinsic` | May expose/attach the existing terminal; no worker replacement |
| `codex` | `codex-app-server`; broker process; JSON-RPC stdio; no terminal | Same app-server driver with `codex-tui`, websocket-over-Unix, and tmux presentation surface | `attachable` | May attach to the live app-server; no replacement |
| `muse` | `muse-serve`; broker process; MSP over JSON-RPC stdio; no terminal | `muse-cli-tmux`; broker process; PTY; tmux terminal required | `birth-variant` | A live serve worker is not silently replaced; explicit lifecycle replacement is required |
| `agent-harness` | `agent-harness`; native worker; native-worker transport; no terminal | `agent-harness-tmux`; native worker outer process; same release executable as TUI child in an HRC pane; standard broker Unix socket | `birth-variant` | A live headless worker is not silently replaced; explicit lifecycle replacement is required |

### Capability evidence

Observed on 2026-09-21:

- Installed binaries: Claude Code 2.1.278, Codex CLI 0.155.1, Muse Code 1.3.0.
- `claude --help` states that Claude Code starts interactively by default and
  uses `--print` for noninteractive output. The retained broker route is the
  Claude Code TUI route; Claude Agent SDK is not a viable replacement.
- `codex app-server --help` exposes stdio, Unix, and websocket listeners;
  `codex --help` exposes `--remote` TUI attachment. T-08554 proved a real
  app-server worker through attach, detach, reattach, and further turns without
  changing worker identity.
- `muse --help` identifies the no-subcommand process as the interactive TUI,
  while `muse serve --help` identifies a client-owned MSP stdio host. They are
  separate launch modes. T-08595 records a real `muse-serve` matrix row and
  Ghostty turn; T-08601 records real native TUI and leased-pane turns. No
  evidence supports attaching the native Muse TUI to a live `muse-serve`
  session, so the catalog must encode a birth variant rather than assume
  attachment.
- `agent-harness drivers --json` reports both `agent-harness` and
  `agent-harness-tmux` available. T-08680 records the installed immutable
  release proof: headless native worker plus a real leased-tmux run where the
  outer worker launched the same release executable as a TUI child, completed
  broker and operator turns over a standard broker socket, survived `/quit`,
  and retained exact release identity.
- Current compiler and validator sources independently confirm the transports
  and terminal shapes: `compile-runtime-plan.ts`, `broker-invocation.ts`, and
  `validate-execution-profile.ts`.

Reproducible read-only probes:

```sh
env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION claude --version
env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION claude --help
codex --version
codex app-server --help
muse --version
muse --help
muse serve --help
agent-harness drivers --json
wrkq cat T-08554 --json --one
wrkq cat T-08595 --json --one
wrkq cat T-08680 --json --one
```

## 5. Central execution catalog

Create one compiler-owned module:

```text
compiler/agent-spaces/src/harness-selection/
  catalog.ts
  resolve.ts
  types.ts
  catalog-projections.ts
```

`catalog.ts` is the only production file allowed to map a harness or
presentation request to a driver. It is exhaustive over the four public IDs.

```ts
type HarnessDefinition = {
  id: HarnessId
  defaultModelProvider: string
  supportedModelProviders: readonly ProviderDefinition[]
  presentationDefault: boolean
  executionVariants: {
    withoutPresentation: ExecutionRecipe
    withPresentation: ExecutionRecipe | ExplicitRefusal
  }
}

type ExecutionRecipe = {
  recipeId: string
  builder: BuilderId
  driver: string
  protocol: 'harness-broker/0.2'
  hosting: {
    harnessTransport: 'jsonrpc-stdio' | 'pty' | 'native-worker'
    terminalRequired: boolean
    terminalHost?: 'tmux'
    processExecution: 'native-worker' | 'broker-process'
  }
  presentationFulfillment:
    | 'intrinsic'
    | 'attachable'
    | 'birth-variant'
    | 'unsupported'
}
```

The fulfillment value is internal producer output. The user-facing field is
strictly boolean. An `unsupported` true outcome is a typed compile refusal and
never appears as a successful downgraded execution.

Initial provider/model defaults are migrated from the current authorities and
split into independent fields:

| Harness | Default model provider | Default model |
| --- | --- | --- |
| `claude` | `anthropic` | `opus[1m]` |
| `codex` | `openai-codex` | `gpt-5.6-terra` |
| `muse` | `meta` | `muse-spark-1.3-contributor` |
| `agent-harness` | `openai-codex` | `gpt-5.5` |

`agent-harness` additionally carries the supported Pi provider/model pairs
from the current Pi SDK catalog, but as separate provider and model fields.
For example, `openai-codex/gpt-5.5` becomes
`modelProvider: "openai-codex"` plus `model: "gpt-5.5"`. The public provider
field is a string identity validated against the selected harness definition;
it is not the old three-value route-family enum.

`catalog-projections.ts` is the only source for inspection, declaration,
capability, CLI, schema, and documentation projections. A projection cannot
become a second selection table.

## 6. One resolver

Only the pure compiler resolver interprets selection inputs:

```ts
resolveHarnessExecution({
  agent,
  provisioningLayers,
  requested,
  runtimeCapabilities,
}): ResolvedHarnessExecution | CompileRefusal
```

Resolution order is deterministic:

1. catalog defaults;
2. agent profile;
3. project target;
4. per-summon directives;
5. explicit compile-request overrides;
6. final combination validation;
7. one execution-recipe resolution.

Rules:

- default harness is `claude`;
- default presentation is `false`;
- TOML uses `model_provider`; the wire uses `modelProvider`;
- TOML and directives use boolean `presentation`; `viewer` is removed and
  rejected;
- only the four canonical harness IDs are accepted;
- omitted provider receives the resolved harness's catalog default;
- omitted model receives the default for the resolved harness/provider pair;
- an explicit model never establishes a provider;
- an explicit provider never establishes a harness;
- changing only harness preserves explicit provider/model values and refuses
  an incompatible final combination;
- explicit `presentation: false` is preserved by property presence, never by
  truthiness;
- requested true resolves to a fulfilling recipe or a typed refusal.

Each resolved scalar records its winning provenance layer. Config and
directive code parse and merge property-preserving values, but do not validate
driver combinations or select recipes.

## 7. Public v2 contract

The public request is a clean replacement, not a v1 union member:

```ts
type RuntimeCompileRequestV2 = {
  schemaVersion: 'agent-runtime-compile-request/v2'
  agent: { id: string }
  identity: RuntimeIdentityAllocation
  placement: RuntimePlacement
  requested: {
    harness?: HarnessId
    modelProvider?: string
    model?: string
    reasoningEffort?: ReasoningEffort
    presentation?: boolean
  }
  materialization: RuntimeMaterializationRequest
  hrcPolicy: HrcPolicyRequest
  continuation?: RuntimeContinuationRef
  correlation: RuntimeCorrelation
}
```

The top-level `agent` is the compilation subject, not a runtime preference.
ASP validates the token and compares it with every explicit semantic identity
already carried by the request: parsed `correlation.scopeRef`, explicit
placement/bundle agent identity, and the canonical agent root identity used by
preparation. Any disagreement returns `configured_context_mismatch` before
materialization. Absence of one of those optional corroborating identities is
not disagreement. ASP does not choose or mutate placement.

The request removes `harnessFamily`, `preferredHarnessRuntime`,
`interactionMode`, `controllerIntent`, `profileSelector`, and caller
`brokerDriver`.

Ordinary compilation returns one execution:

```ts
type CompiledRuntimePlanV2 = {
  schemaVersion: 'agent-runtime-plan/v2'
  compiler: { name: 'agent-spaces'; version: string }
  compileId: CompileId
  planHash: PlanHash
  createdAt: IsoTimestamp
  agent: { id: string }
  identity: RuntimeIdentityAllocation
  placement: RuntimePlacement
  agentPolicy?: CompiledAgentPolicy
  resolvedBundle: ResolvedRuntimeBundle
  omitPriming: boolean
  selection: {
    harness: HarnessId
    modelProvider: string
    model: string
    reasoningEffort?: ReasoningEffort
    presentation: boolean
    provenance: SelectionProvenance
  }
  execution: {
    recipeId: string
    driver: string
    protocol: 'harness-broker/0.2'
    hosting: HostingRequirements
    presentationFulfillment: 'intrinsic' | 'attachable' | 'birth-variant'
    profile: RuntimeExecutionProfile
    dispatchRequest: InvocationDispatchRequest
  }
  artifacts: RuntimePlanArtifacts
  lockedEnv: { lockedEnvKeys: string[] }
  diagnostics: CompileDiagnostic[]
}
```

`execution.dispatchRequest.startRequest` is the single canonical start
request. The profile carries its hashes and a reference/hash to that request;
it does not embed another copy. There is no top-level `startRequest`,
`selectedProfile`, or `executionProfiles[]`, and no profile-level
`brokerDriver` acting as another selection identity. A generic consistency
validator proves that `execution.driver`, the frozen start request driver,
recipe, hashes, hosting evidence, and release binding agree.

## 8. Compiler and ASPC structure

`compileRuntimePlan` becomes orchestration:

```ts
const merged = resolveCompileProvisioning(request)
const resolved = resolveHarnessExecution(merged)
const builder = BUILDER_REGISTRY[resolved.recipe.builder]
const execution = await builder.build(request, resolved)
assertExecutionMatchesResolution(execution, resolved)
return finalizePlan(request, resolved, execution)
```

Builders receive a resolved recipe. They may materialize files and construct a
driver-specific payload, but cannot inspect raw harness, provider,
presentation, viewer, frontend, family, or runtime selection fields. The
builder registry maps an already-selected `BuilderId` to code; it does not
choose the builder.

Broker invocation validation becomes generic protocol/schema validation plus
`assertExecutionMatchesResolution`; driver-specific payload validation lives
with the selected builder.

`aspc.compileHarnessInvocation` is the sole public ordinary compile RPC.
`compileRuntimePlan` may remain an internal compiler/SDK method for manifests
and ASP tooling, but is not a second public RPC. `spaces-aspc` owns no profile
or driver selector. Foreground `asp run` stays on its existing
process-preparation path. Exact-profile, Desktop/external-participant, and
observer operations remain separately named operations and cannot widen the
ordinary selection request.

## 9. Release hosting and cutover

Every successful v2 release-backed execution carries positive hosting evidence
for the compiler-selected driver. The serving immutable release must bind that
driver to an identity-bound executable, prove containment and digest/inventory
agreement, and emit the binding in `executionRelease.worker.hostedDrivers`.
This applies to Codex as well as every other retained recipe; there is no Codex
exemption. Missing or mismatched evidence returns a typed compile refusal
before a successful response or hosting effect.

The successful compile response is persisted completely before execution.
Retries use the frozen recipe and dispatch request; they never re-resolve
changed defaults. Worker-private children and sockets remain worker-owned.
HRC retains placement, authorization, resource allocation, concrete terminal
leases, lifecycle, messaging, continuation, credentials, actuator policy, and
reattachment authority.

V1 requests and removed fields are rejected. Existing v1 release artifacts
remain immutable historical artifacts, but they are not v2-compatible
producers or fallback readers. The ASP cutover prerequisite is a v2 release
whose binding table covers every recipe the four-harness catalog can resolve.
Consumer migration must explicitly dispose, drain, or preserve under its old
binary any incompatible prepared/live state before activating v2; ASP does not
reinterpret old persisted bytes. The concrete HRC disposition and migration
are outside P-00540.

## 10. Removal and enforcement

The cutover removes these selection authorities after their consumers move:

- config `HARNESS_CATALOG` mappings, aliases, and provider/frontend routing;
- `RUNTIME_ROUTE_CATALOG` and its public export;
- compiler `FOREGROUND_ROUTES`, `RUNTIME_TO_FAMILY`, and
  `INTERACTIVE_BROKER_BUILDERS`;
- provider-derived harness fallback;
- `FRONTEND_DEFS` as a selection/model-default authority;
- the per-driver route table inside broker invocation validation;
- ASPC `profileSelector.ts` and selector fields;
- family/runtime/frontend/interaction/controller vocabulary on the public
  selection path;
- plural profile selection and redundant start-request echoes.

A verify-gating repository check must enforce:

- harness/presentation-to-driver mappings occur only in the central catalog;
- driver literals outside the catalog are limited to driver implementations,
  generic frozen-output consumers, and protocol fixtures;
- production builders cannot access raw selection fields;
- no production module outside the resolver maps provider to harness;
- catalog keys equal the four public IDs exactly;
- every recipe has a registered builder and coherent hosting requirements;
- both presentation values for every harness resolve or return a typed refusal;
- public, inspection, declaration, capability, generated-schema, CLI, and docs
  projections equal catalog projections.

## 11. Affected-surface inventory

| Leg | Primary surfaces |
| --- | --- |
| Public contracts | `contracts/spaces-runtime-contracts/src/{compiler-plan,primitives,route-catalog,index}.ts`; execution-profile validators and persistence/participant references |
| Profile/directives | `contracts/agent-scope/src/provisioning.ts`; `core/config/src/core/types/harness.ts`; `core/config/src/core/config/agent-profile-toml.ts`; project-target merge, schemas, and first-party profiles |
| Compiler kernel | `compiler/agent-spaces/src/{compile-runtime-plan,broker-invocation,client-support,client}.ts`; new `harness-selection/` |
| Compiler callers | `run-compile.ts`, `agent-inspection.ts`, `runtime-declaration.ts`, `foreground-launch.ts`, `desktop-observer-preparation.ts`, pre-HRC helpers |
| ASPC protocol/service | `contracts/aspc-protocol/src/{types,schemas,unix-client}.ts`; `harness/aspc/src/{registration,service,client,profileSelector,agent-inspection-authority}.ts` |
| Release facade/broker | `harness/aspc-facade/src/aspd.ts`; broker frozen-driver dispatch and local driver validators |
| Generated/public surfaces | public-surface baseline, generated schemas/profiles, CLI help, inspection/declaration/capability DTOs, first-party profile TOML, fixtures, examples, and docs |
| Architecture | this record plus runtime declaration, inspection, release hosting, Codex presentation, and agent-harness runtime-boundary records |

Tests must preserve lifecycle, persistence, continuation, authorization, and
participant semantics while replacing only their selection/profile-plurality
assumptions.

## 12. Acceptance fixed points

Implementation is correct when:

1. searching production ASP for a harness/presentation-to-driver mapping finds
   exactly the compiler catalog;
2. every public and generated projection exposes exactly the four canonical
   harness IDs;
3. explicit false survives TOML, directives, project merge, RPC, resolver, and
   compiled plan;
4. invalid provider/model/harness combinations and unsupported true
   presentation return typed refusals with no fallback;
5. every ordinary compile returns one execution and one canonical start
   request;
6. ASPC contains no routing or profile-selection knowledge;
7. every selected release worker has positive binding evidence;
8. real installed aspd calls cover all eight harness/presentation cells plus
   v1 and removed-field rejection; and
9. real retained-harness smokes prove the matrix without silently replacing a
   live worker.
