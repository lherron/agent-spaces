# Agent Spaces Pre-HRC Broker Contract Harness Rewrite Plan

**Status:** implementation plan  
**Scope:** rewrite the existing Agent Spaces harness/script that exercises Harness Broker into a contract-valid pre-HRC migration harness.  
**Primary target:** replace the direct `buildHarnessBrokerInvocation(...) -> BrokerClient.startInvocation(spec, initialInput)` smoke flow with a local HRC simulator that consumes `CompiledRuntimePlan`, selects `BrokerExecutionProfile`, verifies compiler closure, and passes the ASP-emitted `InvocationStartRequest` unchanged to Harness Broker.

---

## 0. Executive position

The current script is valuable, but it proves the wrong boundary for the new architecture.

Current flow:

```text
ScopeRef
  -> RuntimePlacement
  -> createAgentSpacesClient(...).buildHarnessBrokerInvocation(...)
  -> validate InvocationStartRequest
  -> BrokerClient.start(...)
  -> broker.hello
  -> BrokerClient.startInvocation(spec, initialInput)
  -> consume normalized broker events
  -> scenario assertions
```

Target flow:

```text
ScopeRef / placement / prompt / policy
  -> RuntimeIdentityAllocation
  -> RuntimeCompileRequest
  -> ASP compileRuntimePlan(...)
  -> CompiledRuntimePlan
  -> PreHrcRouteDecision selects one BrokerExecutionProfile
  -> contract verifier checks plan/profile/spec/startRequest hashes
  -> BrokerClient.start(...)
  -> broker.hello
  -> capability intersection check
  -> BrokerClient.startInvocationFromRequest(selectedProfile.harnessInvocation.startRequest)
  -> append-only event ledger by (invocationId, seq)
  -> scenario assertions over normalized broker events
  -> redacted artifact bundle for HRC migration debugging
```

The harness should be treated as a **pre-HRC runtime-control-plane simulator**. It must not become production HRC, but it should enforce the same contract rules HRC will later enforce:

1. ASP compiles complete immutable runtime plans.
2. The selected broker profile contains the complete `InvocationStartRequest`.
3. The caller selects, verifies, persists/redacts, and passes the request unchanged.
4. The caller consumes only normalized broker protocol events.
5. No runtime execution mechanics are reconstructed after compilation.

This is the fastest safe bridge between the Agent Spaces compiler migration and the later HRC cutover.

Identifier posture for this harness should match the shared runtime contracts:

```ts
export type Id<Name extends string> = string & { readonly __id: Name }
```

The CLI may accept raw strings, but the reusable harness API should deal in branded ID aliases such as `RuntimeId`, `RuntimeOperationId`, `RunId`, `InvocationId`, `InputId`, `CompileId`, `ProfileId`, and `PermissionRequestId`. Raw strings become branded IDs only in validation/constructor helpers at trust boundaries.

---

## 1. Current state in the repo snapshot

### 1.1 Script

The relevant script is:

```text
scripts/smoke-asp-broker-real-codex.ts
```

It currently performs a full real-Codex broker smoke test. The important characteristics are:

- builds a `RuntimePlacement` from a scope ref;
- calls `createAgentSpacesClient({ aspHome }).buildHarnessBrokerInvocation(...)`;
- receives `{ startRequest, spec, initialInput, resolvedBundle, warnings }`;
- validates `InvocationStartRequest` with `validateInvocationStartRequest(...)`;
- starts the broker process with `bun packages/harness-broker/bin/harness-broker.js run --transport stdio`;
- sends `broker.hello`;
- registers a permission handler;
- starts the invocation by splitting the request into `spec` and `initialInput`;
- consumes broker event notifications;
- asserts a real `pwd` tool call and expected assistant marker.

This makes it a useful end-to-end execution test, but not yet a contract-plane test.

### 1.2 Agent Spaces broker builder

Current broker preparation is centered around:

```text
packages/agent-spaces/src/client.ts
  validateBrokerInvocationRequest(...)
  brokerCorrelationFromPlacement(...)
  buildBrokerInitialText(...)
  buildInitialInput(...)
  toHarnessBrokerStartRequest(...)
```

`toHarnessBrokerStartRequest(...)` currently constructs:

```text
HarnessInvocationSpec
InvocationInput
InvocationStartRequest
```

It sets Codex app-server driver fields, process command/args/cwd/env, transport descriptor, interaction policy, continuation, correlation, permission policy, and limits.

That construction is useful substrate, but in the final architecture it must be wrapped by `compileRuntimePlan(...)` and exposed as a `BrokerExecutionProfile`, not as a direct standalone public smoke-test response.

### 1.3 Existing tests

The most relevant tests are:

```text
packages/agent-spaces/src/__tests__/client-broker-invocation.test.ts
packages/agent-spaces/src/__tests__/client-broker-priming-composition.test.ts
```

These tests currently assert the direct broker invocation builder behavior. They should be migrated to assert the compiler product instead, while retaining only a small compatibility-delegation test for `buildHarnessBrokerInvocation(...)` during the migration window.

### 1.4 Broker-side testing helpers

Useful existing broker test substrate:

```text
packages/harness-broker/src/testing/stdio-harness.ts
packages/harness-broker/src/testing/test-driver.ts
packages/harness-broker/src/testing/fake-codex-app-server.ts
packages/harness-broker-client/test/helpers.ts
```

The pre-HRC harness should reuse or extend this substrate for deterministic CI. Real Codex should remain available as an opt-in integration mode because it depends on installed Codex/auth/environment behavior.

---

## 2. What the rewrite must prove

The rewritten harness should prove the contract shape that HRC will later rely on, not just that Broker can run Codex.

### 2.1 Compiler-plane proof

The harness must prove that Agent Spaces emits:

```text
RuntimeCompileResponse.ok === true
CompiledRuntimePlan.schemaVersion === 'agent-runtime-plan/v1'
CompiledRuntimePlan.executionProfiles includes BrokerExecutionProfile
BrokerExecutionProfile.harnessInvocation.startRequest is complete and valid
```

It must verify:

- `compileId`, `planHash`, `redactedPlanHash` exist;
- selected profile has `profileId`, `profileHash`, `compatibilityHash`;
- selected profile kind is `harness-broker`;
- selected profile broker protocol is `harness-broker/0.1`;
- selected profile broker driver is `codex-app-server` for this vertical slice;
- `specHash`, `redactedSpecHash`, `startRequestHash`, and `redactedStartRequestHash` exist and verify;
- redacted artifacts do not contain raw secret values;
- initial input uses the HRC/pre-HRC allocated `initialInputId`, not a random ID generated inside the compiler;
- continuation is encoded by the compiler, not by the harness script.

### 2.2 HRC-control-plane simulation proof

The harness must behave like a constrained HRC controller without importing HRC:

- allocate operation/runtime/invocation/input/run identities before compilation;
- build `RuntimeCompileRequest` with identity, placement, materialization, policy, continuation, and correlation;
- call `compileRuntimePlan(...)`;
- select a compiled `BrokerExecutionProfile` by profile ID/hash/kind;
- produce a `PreHrcRouteDecision` record that mirrors the fields HRC will later persist;
- verify capability compatibility against broker hello and invocation response;
- persist a redacted artifact bundle;
- pass the selected profile’s `InvocationStartRequest` unchanged;
- maintain an append-only in-memory event ledger keyed by `(invocationId, seq)`;
- fail on mutation, missing capabilities, native event leakage, or untyped permission events.

### 2.3 Broker execution-plane proof

The harness must prove that Broker:

- accepts the ASP-compiled start request;
- preserves the provided `invocationId`;
- emits normalized broker event notifications;
- emits events with monotonic `seq` per invocation;
- returns invocation status/capabilities consistent with selected profile requirements;
- uses typed permission request/resolution behavior;
- does not require the harness script to inspect Codex-native events;
- reaches terminal turn state or reports a typed terminal failure.

---

## 3. Target files and package layout

### 3.1 New test harness module

Create a reusable test harness module rather than putting all logic in a script:

```text
packages/agent-spaces/src/testing/pre-hrc-broker-contract-harness.ts
packages/agent-spaces/src/testing/pre-hrc-broker-contract-types.ts
packages/agent-spaces/src/testing/pre-hrc-broker-contract-assertions.ts
packages/agent-spaces/src/testing/pre-hrc-broker-contract-artifacts.ts
```

This module is not production runtime code. It exists to validate that the Agent Spaces compiler output can be consumed by an HRC-like caller without boundary violations.

Allowed dependencies for this testing module:

```text
agent-spaces compiler/public client API
spaces-runtime-contracts
spaces-harness-broker-client
spaces-harness-broker-protocol
spaces-config / agent-scope helpers for placement construction
node/bun filesystem/process utilities
```

Disallowed dependencies:

```text
hrc-server
hrc-core
spaces-harness-codex direct driver/session internals
harness-broker/src/drivers/*
legacy exec wrappers
Codex native event types
```

The real broker process may of course import/use broker driver packages internally. The test harness must not.

### 3.2 Rewrite the script as a thin CLI wrapper

Replace or supersede the current script with:

```text
scripts/smoke-runtime-contract-broker-real-codex.ts
```

Recommended migration posture:

```text
scripts/smoke-asp-broker-real-codex.ts             # keep temporarily, mark legacy-direct-builder
scripts/smoke-runtime-contract-broker-real-codex.ts # new contract harness entry point
```

After `compileRuntimePlan(...)` is stable, either delete the old script or make it delegate to the new harness with compatibility flags.

### 3.3 Optional deterministic CI wrapper

Add a deterministic fake-mode script or test:

```text
scripts/smoke-runtime-contract-broker-fake-codex.ts
packages/agent-spaces/src/__tests__/pre-hrc-broker-contract-harness.test.ts
```

The fake mode should run in CI and avoid real Codex/auth/network assumptions. Real Codex mode should remain manual/integration-gated.

### 3.4 Package scripts

Add package scripts:

```jsonc
{
  "scripts": {
    "smoke:broker-contract:fake": "bun scripts/smoke-runtime-contract-broker-fake-codex.ts",
    "smoke:broker-contract:real-codex": "bun scripts/smoke-runtime-contract-broker-real-codex.ts",
    "test:broker-contract": "bun test packages/agent-spaces/src/__tests__/pre-hrc-broker-contract-harness.test.ts"
  }
}
```

Do not put real Codex smoke in `test:fast` unless the environment is explicitly provisioned.

---

## 4. Public harness interface

The reusable test harness should expose a single high-level function:

```ts
export async function runPreHrcBrokerContractHarness(
  input: PreHrcBrokerContractHarnessInput
): Promise<PreHrcBrokerContractHarnessResult>
```

Suggested shape:

```ts
export type PreHrcBrokerContractHarnessInput = {
  aspHome: string
  placement: RuntimePlacement

  identity?: Partial<RuntimeIdentityAllocation> | undefined
  requested?: {
    modelProvider?: 'openai' | undefined
    model?: string | undefined
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | undefined
    harnessFamily?: 'codex' | undefined
    preferredHarnessRuntime?: 'codex-cli' | undefined
    interactionMode?: 'headless' | undefined
  } | undefined

  materialization: {
    initialPrompt?: string | undefined
    attachments?: AttachmentRef[] | undefined
    taskContext?: HrcTaskContext | undefined
    resolvedBundleHint?: ResolvedRuntimeBundle | undefined
  }

  policy?: {
    permissionPolicy?: BrokerPermissionPolicy | undefined
    inputPolicy?: BrokerInputPolicy | undefined
    exposurePolicy?: AgentchatExposurePolicy | undefined
    resourceLimits?: RuntimeResourceLimits | undefined
    observability?: RuntimeObservabilityInput | undefined
    capabilityPolicy?: HrcCapabilityPolicy | undefined
  } | undefined

  continuation?: RuntimeContinuationRef | undefined

  brokerProcess?: {
    command?: string | undefined
    args?: string[] | undefined
    cwd?: string | undefined
    env?: Record<string, string> | undefined
  } | undefined

  profileSelector?: {
    kind?: 'harness-broker' | undefined
    brokerDriver?: 'codex-app-server' | undefined
    profileId?: ProfileId | undefined
    profileHash?: ProfileHash | undefined
  } | undefined

  scenario?: {
    name: string
    requireToolPwd?: boolean | undefined
    requireContinuationUpdate?: boolean | undefined
    expectedAssistantMarkers?: string[] | undefined
    timeoutMs?: number | undefined
  } | undefined

  artifacts?: {
    dir?: string | undefined
    writeRawStartRequest?: false | undefined
    writeRedactedPlan?: boolean | undefined
    writeRedactedSpec?: boolean | undefined
    writeRedactedStartRequest?: boolean | undefined
    writeTranscript?: boolean | undefined
    writeAssertionReport?: boolean | undefined
  } | undefined
}
```

Result shape:

```ts
export type PreHrcBrokerContractHarnessResult = {
  ok: boolean
  failures: ContractHarnessFailure[]

  identity: RuntimeIdentityAllocation
  compile: {
    compileId: CompileId
    planHash: PlanHash
    redactedPlanHash: RedactedPlanHash
  }
  selectedProfile: {
    profileId: ProfileId
    profileHash: ProfileHash
    compatibilityHash: CompatibilityHash
    specHash: SpecHash
    redactedSpecHash: RedactedSpecHash
    startRequestHash: StartRequestHash
    redactedStartRequestHash: RedactedStartRequestHash
  }
  routeDecision: PreHrcRouteDecision
  broker: {
    protocolVersion: 'harness-broker/0.1'
    invocationId: InvocationId
    capabilities: InvocationCapabilities
    finalStatus?: InvocationStatusResponse | undefined
  }
  ledger: {
    eventCount: number
    lastSeq?: number | undefined
    eventTypes: InvocationEventType[]
    terminalTurnEvent?: InvocationEventEnvelope | undefined
  }
  artifacts: {
    dir?: string | undefined
    transcriptPath?: string | undefined
    redactedPlanPath?: string | undefined
    redactedSpecPath?: string | undefined
    redactedStartRequestPath?: string | undefined
    routeDecisionPath?: string | undefined
    assertionReportPath?: string | undefined
  }
}
```

`PreHrcRouteDecision` should not import HRC. It should be a testing-local mirror of the route decision fields needed to prove HRC viability:

```ts
export type PreHrcRouteDecision = {
  schemaVersion: 'pre-hrc-route-decision/v1'
  routeId: string
  operationId: RuntimeOperationId
  compileId: CompileId
  planHash: PlanHash
  selectedProfileId: ProfileId
  selectedProfileHash: ProfileHash
  selectedProfileKind: 'harness-broker'
  controller: 'harness-broker'
  startupMethod: 'create-broker-invocation'
  turnDelivery: 'broker-input'
  admission: { decision: 'admit' } | { decision: 'reject'; reason: string }
  reuse: {
    policy: 'always-new'
    compatibilityHash: CompatibilityHash
    staleGeneration: 'rotate' | 'allow'
  }
  productPolicy: {
    permissionPolicy?: BrokerPermissionPolicy | undefined
    inputPolicy?: BrokerInputPolicy | undefined
    exposurePolicy?: AgentchatExposurePolicy | undefined
    resourceLimits?: RuntimeResourceLimits | undefined
  }
  capabilities: CapabilityResolution
  legacyTransportAlias: 'headless'
}
```

This is intentionally HRC-shaped without becoming an HRC dependency.
It is also intentionally artifact-shaped, not endpoint-shaped: the harness should
write schema-versioned DTOs (`agent-runtime-compile-request/v1`,
`agent-runtime-plan/v1`, `pre-hrc-route-decision/v1`,
`runtime-public-view/v1` where needed), but it should not imply that HRC must
introduce new public `/v2` lifecycle endpoints. Existing `/v1` endpoint shapes
can remain if they add controller/profile/capability fields compatibly; a new
endpoint version is justified only if backward-compatible request/response views
cannot be preserved.

---

## 5. Detailed execution flow

### 5.1 Build placement

Keep the current script’s useful placement construction:

```text
resolveScopeInput(...)
resolveAgentPlacementPaths(...)
buildRuntimeBundleRef(...)
```

But move it behind a helper:

```ts
export function buildPlacementFromScopeRef(input: ScopePlacementInput): RuntimePlacement
```

The helper should remain in script/testing code, not in broker/protocol packages.

### 5.2 Allocate identities before compilation

Add a local allocator:

```ts
export function allocatePreHrcRuntimeIdentity(seed: IdentitySeed): RuntimeIdentityAllocation
```

Required IDs:

```text
requestId
operationId
hostSessionId
generation
runtimeId
invocationId
initialInputId   when initial input exists
runId            when start includes a turn
traceId?
idempotencyKey?
```

Defaults may be timestamp/UUID based for manual smoke, but tests must be able to provide deterministic IDs.

The allocator should return the shared `RuntimeIdentityAllocation` shape with branded ID fields. It should not return a local pile of untyped strings that later code casts opportunistically.

Important: once Agent Spaces compiler is updated, `buildInitialInput(...)` must stop generating `input_${randomUUID()}` for HRC/pre-HRC paths. The compiler must use the supplied `initialInputId` when initial input exists. The compatibility wrapper may generate a fallback input ID only for legacy direct-builder callers.

### 5.3 Build `RuntimeCompileRequest`

The harness builds:

```ts
const compileRequest: RuntimeCompileRequest = {
  schemaVersion: 'agent-runtime-compile-request/v1',
  identity,
  placement,
  requested: {
    modelProvider: 'openai',
    harnessFamily: 'codex',
    preferredHarnessRuntime: 'codex-cli',
    interactionMode: 'headless',
    model,
    reasoningEffort,
  },
  materialization: {
    initialPrompt: prompt,
    attachments,
    taskContext,
    resolvedBundleHint,
  },
  hrcPolicy: {
    permissionPolicy,
    inputPolicy,
    exposurePolicy: { mode: 'none' },
    resourceLimits,
    observability,
    capabilityPolicy,
  },
  continuation,
  correlation: {
    requestId: identity.requestId,
    operationId: identity.operationId,
    hostSessionId: identity.hostSessionId,
    generation: identity.generation,
    runtimeId: identity.runtimeId,
    runId: identity.runId,
    invocationId: identity.invocationId,
    traceId: identity.traceId,
  },
}
```

The harness must not call `buildHarnessBrokerInvocation(...)` as its main path.

### 5.4 Compile plan

The harness calls the compiler API:

```ts
const response = await spacesClient.compileRuntimePlan(compileRequest)
```

Migration bridge while the compiler API is landing:

- PR 1 may introduce `compileRuntimePlan(...)` as a wrapper around the existing `toHarnessBrokerStartRequest(...)` path.
- The harness should target `compileRuntimePlan(...)` from the beginning.
- The old script can keep using `buildHarnessBrokerInvocation(...)` until the new script is ready.

### 5.5 Select compiled broker profile

Selection rule:

```ts
const profile = selectBrokerProfile(plan, selector)
```

Hard requirements:

- `profile.kind === 'harness-broker'`;
- `profile.interactionMode === 'headless'`;
- `profile.brokerProtocol === 'harness-broker/0.1'`;
- `profile.brokerDriver === 'codex-app-server'`;
- `profile.harnessInvocation.startRequest.spec.invocationId === identity.invocationId`;
- if initial input exists, `profile.harnessInvocation.startRequest.initialInput.inputId === identity.initialInputId`;
- selected profile hash matches `profile.profileHash` when recomputed;
- selected start request hash matches `profile.harnessInvocation.startRequestHash` when recomputed.

The selection function may select the first compatible profile by default, but tests should also support selection by `profileId` and `profileHash`.

### 5.6 Verify compiler closure before broker start

Before launching Broker, compute and store:

```ts
const startRequestBefore = deepFreezeClone(profile.harnessInvocation.startRequest)
const startRequestHashBefore = hashInvocationStartRequest(startRequestBefore)
```

Then immediately before `invocation.start`, verify:

```ts
assertHash(startRequestBefore, profile.harnessInvocation.startRequestHash)
assertDeepEqual(profile.harnessInvocation.startRequest, startRequestBefore)
```

The harness must fail if any local code mutates:

```text
spec.driver
spec.process.command
spec.process.args
spec.process.cwd
spec.process.env
spec.process.harnessTransport
spec.continuation
initialInput
```

Add a negative unit test that intentionally mutates a selected profile copy and verifies the harness reports a contract failure before broker start.

### 5.7 Start broker process

Broker process ownership in the test harness mirrors HRC v1:

```text
one broker process per runtime test
one active invocation
stdio JSON-RPC transport
notification-stream events
no attach/replay assumption
```

Default command:

```text
bun packages/harness-broker/bin/harness-broker.js run --transport stdio
```

This is broker process mechanics, not harness process mechanics. It is acceptable for the pre-HRC harness/HRC simulator to own this. It must not mutate the harness process mechanics inside `InvocationStartRequest`.

### 5.8 Send hello and resolve capabilities

The harness sends:

```ts
await brokerClient.hello({
  clientInfo: { name: 'pre-hrc-broker-contract-harness', version },
  protocolVersions: ['harness-broker/0.1'],
  capabilities: { permissionRequests: true },
})
```

Then it computes capability compatibility:

```text
profile.expectedCapabilities
  ∩ pre-HRC policy
  ∩ broker hello capabilities
```

After `invocation.start`, it also includes invocation capabilities:

```text
profile.expectedCapabilities
  ∩ pre-HRC policy
  ∩ broker hello capabilities
  ∩ invocation capabilities
```

If a required capability is missing, fail before/after start as appropriate. Do not silently degrade.

### 5.9 Register permission handler

The harness should support three modes:

```text
deny        default for CI
allow       only with explicit provenance/test flag
ask-client  validates broker-to-client request path
```

Default mode is deny. The handler should produce audit records:

```ts
BrokerPermissionDecisionRecord
```

Typed permission expectations:

- accept broker-to-client `invocation.permission.request` JSON-RPC request if implemented;
- also expect normalized `permission.requested` / `permission.resolved` events once the broker protocol is fixed;
- fail if the broker emits legacy untyped `invocation.permission.request` as an event after the protocol migration.

During transition, the harness may have a compatibility flag:

```text
--allow-legacy-permission-event
```

but the final contract mode must fail on the legacy event name.

### 5.10 Start invocation by passing the compiled request unchanged

Update broker client with a request-level method:

```ts
BrokerClient.startInvocationFromRequest(
  startRequest: InvocationStartRequest
): Promise<{ invocationId: InvocationId; events: AsyncIterable<InvocationEventEnvelope>; response: InvocationStartResponse }>
```

Then the harness calls:

```ts
await brokerClient.startInvocationFromRequest(profile.harnessInvocation.startRequest)
```

This replaces the current split call:

```ts
brokerClient.startInvocation(spec, initialInput)
```

Keep the split call as a compatibility wrapper if needed:

```ts
startInvocation(spec, initialInput) {
  return this.startInvocationFromRequest(initialInput ? { spec, initialInput } : { spec })
}
```

The new harness must use the request-level method so the test exactly mirrors HRC pass-through semantics.

### 5.11 Consume broker events through an event ledger

Create a small event ledger:

```ts
export class PreHrcBrokerEventLedger {
  append(event: InvocationEventEnvelope): AppendResult
  requireMonotonicSeq(): void
  requireNoDuplicates(): void
  requireOnlyNormalizedEventTypes(): void
  terminalTurnEvent(): InvocationEventEnvelope | undefined
  eventTypes(): InvocationEventType[]
}
```

Rules:

- key by branded `InvocationId` plus `seq`;
- duplicate event with same JSON is idempotent;
- duplicate event with same seq but different JSON is a failure;
- out-of-order events are allowed only if the stream contract allows them; otherwise fail strictly for v1;
- native Codex event names such as `turn/started`, `item/started`, `item/completed`, `thread/start`, `thread/resume` must never appear as broker event `type`;
- raw driver-native event names may appear only in `event.driver.rawType`, not as the normalized event `type`.

### 5.12 Scenario assertions

Keep the current real-Codex scenario but move it into assertion modules.

Baseline assertions for all modes:

```text
invocation.started
invocation.ready
input.accepted when initial input exists
turn.started when initial input exists
one terminal turn event: turn.completed | turn.failed | turn.interrupted
status after terminal event is ready/exited/failed according to policy
```

Real Codex command scenario assertions:

```text
tool.call.started for command
tool.call.completed for same toolCallId
command is pwd-only
command cwd equals compiled spec.process.cwd or redacted equivalent
command exitCode is 0
assistant output includes expected marker(s)
```

Continuation scenario assertions:

```text
continuation.updated appears when scenario requires it
reported continuation provider/kind match broker continuation expectations
continuation source event seq is recorded in assertion report
```

Permission scenario assertions:

```text
permission.requested observed for permission-requiring command if using ask-client mode
permission.resolved observed with explicit decision
policy deny produces denied permission and audited failure/diagnostic path
```

Busy-input scenario assertions, once broker input policy is stable:

```text
ready invocation accepts user input and starts turn
busy invocation with reject policy returns rejected/busy
queue policy without queue capability fails with queue-not-supported
```

---

## 6. Artifact bundle

The pre-HRC harness should write an artifact bundle that is intentionally similar to what HRC will later persist, but without HRC dependencies.

Default directory:

```text
<asp-home>/broker-contract-runs/<timestamp-or-run-id>/
```

Recommended files:

```text
compile-request.redacted.json
compiled-plan.redacted.json
selected-profile.redacted.json
broker-spec.redacted.json
invocation-start-request.redacted.json
route-decision.pre-hrc.json
broker-hello.json
invocation-start-response.json
invocation-status-final.json
broker-events.jsonl
permission-decisions.jsonl
assertion-report.json
summary.txt
```

Do not persist raw secrets. Do not write raw executable `startRequest` by default.

Optional debugging-only flag:

```text
--write-raw-start-request
```

This should be disabled by default, emit a loud warning, and preferably refuse to run outside a temp directory.

Artifact rules:

- redacted plan hash must match `redactedPlanHash`;
- selected profile redacted hash must match the compiled profile’s redacted form/hash if available;
- redacted broker spec/start request hashes must match `redactedSpecHash` and `redactedStartRequestHash`;
- event transcript must contain only normalized broker event envelopes;
- assertion report must include failure codes, not only text logs;
- include path to current repo commit if available, but do not require git.

---

## 7. CLI design

New script usage:

```bash
bun scripts/smoke-runtime-contract-broker-real-codex.ts \
  --scope-ref cody@agent-spaces \
  --asp-home /tmp/asp-broker-contract-smoke \
  --prompt 'Execute `pwd`, then reply ASP_BROKER_OK <scope>.' \
  --timeout 120
```

Recommended flags:

```text
--scope-ref <handle>
--agent-root <path>
--project-root <path>
--cwd <path>
--asp-home <path>
--artifact-dir <path>
--prompt <text>
--model <model-id>
--reasoning-effort <low|medium|high|xhigh>
--permission-mode <deny|allow|ask-client>
--permission-default <deny|allow>
--input-policy <reject|queue>
--operation-id <id>
--runtime-id <id>
--run-id <id>
--invocation-id <id>
--initial-input-id <id>
--trace-id <id>
--profile-id <id>
--profile-hash <hash>
--timeout <seconds>
--json
--dry-run-compile
--write-raw-start-request
--allow-legacy-permission-event   # temporary only
```

Exit codes:

```text
0 success
1 contract/assertion failure
2 compiler failure
3 broker startup/protocol failure
4 scenario timeout
5 unsafe artifact/policy configuration
```

CLI output should be concise and HRC-shaped:

```text
[contract] identity: runtime=... operation=... invocation=... input=...
[contract] compile: compileId=... planHash=...
[contract] selected profile: profileId=... profileHash=... startRequestHash=...
[contract] broker: hello protocol=harness-broker/0.1 driver=codex-app-server
[contract] start: invocationId=... state=...
[contract] events: count=... terminal=turn.completed lastSeq=...
[contract] artifacts: .../assertion-report.json
[contract] SUCCESS
```

---

## 8. Rewrite existing unit tests

### 8.1 Replace direct builder contract tests

Rename:

```text
client-broker-invocation.test.ts
```

to:

```text
compiler-broker-profile.test.ts
```

New assertions:

- `compileRuntimePlan(...)` returns a plan for `openai + codex + headless`;
- plan contains a broker execution profile;
- selected profile contains a valid `InvocationStartRequest`;
- start request spec maps Codex process fields correctly;
- driver config maps Codex app-server fields correctly;
- continuation maps OpenAI/HRC continuation to broker Codex thread continuation;
- correlation is compiled into flat broker-safe correlation;
- no HRC/ACP launch metadata is present;
- hashes verify;
- redacted artifacts contain no raw secrets;
- changing process/driver mechanics changes the relevant hash;
- unsupported provider/frontend/mode is rejected by compiler diagnostics before materialization.

Keep one small compatibility suite:

```text
buildHarnessBrokerInvocation delegates to compileRuntimePlan broker profile
```

This suite should assert only that the legacy method returns the same start request as the compiled broker profile for the same inputs, or is explicitly deprecated/removed.

### 8.2 Rewrite priming composition tests

Rename:

```text
client-broker-priming-composition.test.ts
```

to:

```text
compiler-broker-initial-input.test.ts
```

New assertions:

- compiled broker profile initial input includes expanded priming prompt;
- caller prompt expansion still works;
- prompt `''` suppresses text input;
- image-only input remains image-only;
- `initialInput.inputId` equals allocated `identity.initialInputId`;
- `initialInputHash` changes when prompt/attachment content changes;
- prompt paths/content are compiler-owned and never patched by the test harness.

### 8.3 Add pre-HRC harness tests

Create:

```text
packages/agent-spaces/src/__tests__/pre-hrc-broker-contract-harness.test.ts
```

Test cases:

1. dry-run compile selects broker profile and writes redacted artifacts;
2. fake broker/test driver path starts invocation using profile start request unchanged;
3. mutation of selected `startRequest.spec.process.env` fails before broker start;
4. mutation of selected `startRequest.initialInput.content` fails before broker start;
5. duplicate broker event is idempotent if identical;
6. duplicate broker event with conflicting payload fails;
7. native Codex event type in event stream fails normalized-event check;
8. missing required capability fails before scenario success;
9. default permission mode is deny and audited;
10. compatibility wrapper, if still present, delegates to compiler output.

---

## 9. Broker client/API changes needed by the harness

### 9.1 Add request-level start method

Current client API splits the request:

```ts
startInvocation(spec, initialInput)
```

Add:

```ts
startInvocationFromRequest(startRequest: InvocationStartRequest)
```

Implementation:

```ts
async startInvocationFromRequest(
  startRequest: InvocationStartRequest
): Promise<{
  invocationId: InvocationId
  response: InvocationStartResponse
  events: AsyncIterable<InvocationEventEnvelope>
}> {
  const expectedInvocationId = startRequest.spec.invocationId
  const expectedEvents = expectedInvocationId ? this.#eventStream(expectedInvocationId) : undefined
  const response = await this.#transport.request<InvocationStartResponse>(
    'invocation.start',
    startRequest,
  )
  return {
    invocationId: response.invocationId,
    response,
    events: expectedEvents ?? this.#eventStream(response.invocationId),
  }
}
```

Then keep old split method as compatibility:

```ts
startInvocation(spec, initialInput) {
  return this.startInvocationFromRequest(initialInput === undefined ? { spec } : { spec, initialInput })
}
```

The contract harness must use `startInvocationFromRequest(...)`.

### 9.2 Permission event transition

The current client has compatibility handling for `invocation.permission.request` as an event-like shape. Final broker protocol should prefer broker-to-client request plus typed normalized `permission.requested` / `permission.resolved` events.

Harness posture:

- final mode fails on event type `invocation.permission.request`;
- transition mode logs it as legacy and fails only if `--strict-permissions` is set;
- once broker protocol is fixed, delete transition mode.

---

## 10. Compiler API changes needed before the rewrite can fully land

The harness depends on these Agent Spaces compiler changes:

1. Add `spaces-runtime-contracts` dependency to Agent Spaces.
2. Implement `compileRuntimePlan(...)` on the public client/API.
3. Move current broker request construction into the compiler pipeline.
4. Emit `CompiledRuntimePlan` with at least one `BrokerExecutionProfile` for `openai + codex + headless`.
5. Require or accept `RuntimeIdentityAllocation` before compilation.
6. Use branded ID aliases from `spaces-runtime-contracts` for DTO fields while keeping JSON wire values as strings.
7. Use supplied `invocationId` and `initialInputId` in the profile start request.
8. Accept the full `RuntimeCompileRequest` materialization/policy shape, including `taskContext`, `resolvedBundleHint`, and `hrcPolicy.capabilityPolicy`.
9. Emit stable `planHash`, `redactedPlanHash`, `profileHash`, `compatibilityHash`, `specHash`, `redactedSpecHash`, `startRequestHash`, `redactedStartRequestHash`.
10. Emit redacted plan/profile/spec/start-request artifacts.
11. Emit `expectedCapabilities` from the compiled broker profile.
12. Keep `buildHarnessBrokerInvocation(...)` only as a deprecated delegate, not as a second construction path.

Until these exist, the new harness can be scaffolded behind compile API stubs, but it should not be merged as passing if it still calls the direct builder as the primary path.

---

## 11. Boundary checks to add

Extend `scripts/check-boundaries.ts` or add a focused check:

```text
scripts/check-runtime-contract-harness-boundaries.ts
```

Checks:

```bash
# Contract harness must not import HRC.
rg "from ['\"]hrc-|from ['\"].*hrc-runtime|packages/hrc" \
  scripts packages/agent-spaces/src/testing packages/agent-spaces/src/__tests__

# Contract harness must not import Codex driver/session internals.
rg "spaces-harness-codex|codex-session|runCodexAppServerOneShot|CodexAppServer" \
  scripts packages/agent-spaces/src/testing packages/agent-spaces/src/__tests__ \
  -g '!**/compiler-broker-profile.test.ts'

# Contract harness must use compiled plans, not direct builder path.
rg "buildHarnessBrokerInvocation" \
  scripts/smoke-runtime-contract-broker-* packages/agent-spaces/src/testing

# Contract harness must not use the split start call.
rg "startInvocation\(" \
  scripts/smoke-runtime-contract-broker-* packages/agent-spaces/src/testing

# Contract harness must use the exact request-level start call.
rg "startInvocationFromRequest" \
  scripts/smoke-runtime-contract-broker-* packages/agent-spaces/src/testing
```

The direct builder and split start call may remain in compatibility tests only.
The violation checks should be zero-hit for the new harness; the positive
`startInvocationFromRequest` check should find the exact pass-through call.

---

## 12. PR-by-PR implementation sequence

### PR 1 — Introduce the pre-HRC harness skeleton

Add files:

```text
packages/agent-spaces/src/testing/pre-hrc-broker-contract-types.ts
packages/agent-spaces/src/testing/pre-hrc-broker-contract-artifacts.ts
packages/agent-spaces/src/testing/pre-hrc-broker-contract-assertions.ts
packages/agent-spaces/src/testing/pre-hrc-broker-contract-harness.ts
scripts/smoke-runtime-contract-broker-real-codex.ts
```

Initially the harness can support `--dry-run-compile` only if the compiler API exists, or be checked in behind skipped tests if the compiler API lands in the same branch.

Acceptance:

- no HRC imports;
- no Codex driver/session imports;
- CLI usage works;
- artifact writer redacts by default;
- current legacy smoke script is left untouched.

### PR 2 — Add `BrokerClient.startInvocationFromRequest(...)`

Add request-level client method and tests.

Acceptance:

- old `startInvocation(spec, initialInput)` delegates to the new request-level method;
- new harness uses only request-level method;
- tests prove expected event stream is associated with supplied `spec.invocationId`.

### PR 3 — Switch harness to `compileRuntimePlan(...)`

Once Agent Spaces compiler API exists, wire the harness to it.

Acceptance:

- harness no longer calls `buildHarnessBrokerInvocation(...)`;
- `CompiledRuntimePlan` and selected `BrokerExecutionProfile` are present;
- hashes verify;
- identity allocation is embedded into `startRequest`;
- dry-run mode writes redacted artifacts.

### PR 4 — Add contract verifier and mutation tests

Add hash/deep-freeze verifier and negative tests.

Acceptance:

- mutation of driver/process/initial input fails before broker start;
- redacted plan does not contain env secret values;
- raw start request is not written unless explicitly requested.

### PR 5 — Add fake deterministic broker scenario

Use test driver/fake Codex app-server where possible to make CI deterministic.

Acceptance:

- CI can run a full compile -> broker -> event ledger path without real Codex;
- event ledger validates seq/idempotency/event vocabulary;
- scenario reaches terminal turn event.

### PR 6 — Port real Codex smoke onto new harness

Replace current script behavior with the new harness in real-Codex mode.

Acceptance:

- real Codex smoke still validates `pwd` tool call;
- assistant marker assertion remains;
- transcript is written as broker events JSONL;
- compile/profile/hash fields are printed and written.

### PR 7 — Migrate existing direct-builder tests

Convert direct builder tests to compiler profile tests.

Acceptance:

- `compiler-broker-profile.test.ts` covers spec/process/driver/continuation/correlation/hash/redaction;
- `compiler-broker-initial-input.test.ts` covers priming/prompt/images/input ID/hash;
- `buildHarnessBrokerInvocation(...)` has only delegate/deprecation tests.

### PR 8 — Add boundary checks and make strict mode default

Add checks to CI and make the contract harness strict by default.

Acceptance:

- contract harness cannot call direct builder;
- contract harness cannot split start request;
- legacy permission event is rejected unless temporary compatibility flag is explicitly set;
- native Codex event names in broker event stream fail the run.

### PR 9 — Delete/retire old smoke path

After HRC begins consuming compiled plans, remove or alias the old script.

Acceptance:

- `scripts/smoke-asp-broker-real-codex.ts` either deleted or delegates to `smoke-runtime-contract-broker-real-codex.ts`;
- docs/runbooks point to the contract harness;
- no maintained smoke path bypasses `CompiledRuntimePlan`.

---

## 13. Definition of done

The rewrite is done when all of the following are true:

1. The primary pre-HRC smoke path calls `compileRuntimePlan(...)`, not `buildHarnessBrokerInvocation(...)`.
2. The selected execution profile is a `BrokerExecutionProfile` from `CompiledRuntimePlan.executionProfiles`.
3. The broker start request comes from `selectedProfile.harnessInvocation.startRequest`.
4. The harness sends that start request through `BrokerClient.startInvocationFromRequest(...)` unchanged.
5. The harness verifies plan/profile/spec/start-request hashes before broker start.
6. The harness fails on mutation of process command/args/cwd/env, driver config, continuation, transport, or initial input after compilation.
7. The harness allocates and verifies `requestId`, `operationId`, `hostSessionId`, `generation`, `runtimeId`, `runId`, `invocationId`, and `initialInputId` before compilation when each applies.
8. The harness records a pre-HRC route-decision artifact that mirrors HRC’s future selected-profile decision.
9. The harness validates capability intersection against broker hello and invocation capabilities.
10. The harness consumes only normalized broker events and stores them in an append-only ledger keyed by `(invocationId, seq)`.
11. The harness supports a deterministic fake mode for CI and a real-Codex mode for integration/manual testing.
12. The artifact bundle is redacted by default and includes enough state to debug future HRC migration failures.
13. Existing direct-builder tests have been converted to compiler-profile tests.
14. Boundary checks prevent the new harness from importing HRC, Codex driver internals, or legacy execution wrappers.
15. The old direct smoke script is retired or made a compatibility wrapper.

---

## 14. Non-goals

This rewrite should not:

- implement HRC persistence;
- import HRC server packages;
- implement runtime reuse;
- implement broker attach/replay;
- supervise shared broker processes;
- parse Codex native app-server events;
- patch broker start requests after compilation;
- become a production runtime controller.

It should be deliberately small: a contract-valid proof that ASP can compile and Broker can execute exactly the object HRC will later select and pass through.

---

## 15. Final recommended cut

Make the new harness the first consumer of the final Agent Spaces compiler API.

The old script should be treated as a useful historical smoke test, but the new migration-critical test should be:

```text
RuntimeCompileRequest
  -> CompiledRuntimePlan
  -> selected BrokerExecutionProfile
  -> hash/redaction/capability verification
  -> unchanged InvocationStartRequest
  -> Harness Broker
  -> normalized event ledger
```

This gives HRC a concrete executable contract target before any HRC code is migrated. If this harness cannot pass without direct invocation-builder calls, request splitting, post-compile mutation, native event parsing, or untyped permission behavior, then HRC should not start its broker-controller migration yet.
