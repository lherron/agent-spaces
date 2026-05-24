# FINAL_CONTRACTS.md

**Status:** final to-be runtime contract surface  
**Scope:** Agent Spaces / ASP compiler plane, HRC runtime control plane, Harness Broker execution plane  
**Primary invariant:** ASP compiles complete immutable runtime plans; HRC selects and controls; Harness Broker executes and normalizes.

This document is the normative contract surface. `FINAL_DATATYPES.md` contains the corresponding TypeScript DTOs and records.

---

## 0. Contract posture

The runtime system is a three-plane system, not a wrapper stack.

```text
ASP compiler plane
  owns reproducible runtime construction
  emits CompiledRuntimePlan

HRC runtime control plane
  owns route admission, runtime lifecycle, reuse, persistence, public API semantics, policy, reconciliation
  emits RuntimeRouteDecision + RuntimeOperation + RuntimeState

Harness Broker execution plane
  owns harness process execution, native driver protocols, input disposition, permission requests, normalized broker events
  emits InvocationEventEnvelope + InvocationStatus
```

The decisive rule is compiler closure:

> After ASP emits a `CompiledRuntimePlan`, HRC MUST NOT reconstruct, mutate, patch, infer, or synthesize broker execution mechanics.

For broker-capable routes this includes `HarnessInvocationSpec`, `InvocationStartRequest`, driver config, process command/args/cwd and declared `lockedEnv`, harness transport descriptors, Codex app-server descriptors, prompt/context materialization paths, continuation encoding, harness-specific OTEL/config mutation, and native launch-mode detection.

If HRC needs a different broker request, process argv/env/cwd, driver config, continuation shape, prompt materialization, model, placement, permission policy, or input policy, HRC MUST ask ASP to recompile.

**Confidentiality posture.** The compiled spec is credential-free and ambient-free by contract: it carries declared non-secret `lockedEnv` (hashed) but never credential or ambient material. It defines **no** generic secret classification, redaction transforms, or digest-substituted values. Credential material reaches the harness only through a broker/driver-owned credential source (broker launch environment, external secret store, or an on-disk file credential materialized outside the compiled DTO; see PLANE_SPEC §7.5.1), and the broker composes the spawn env as a validated disjoint union of ambient allowlist + credentials + `lockedEnv` + `dispatchEnv`. Confidentiality is enforced by keeping credentials out of the compiled spec — **not** by contract-DTO redaction. (The canonical statement of this principle lives in the PLANE_SPEC architecture section; this is a pointer.)

---

## 1. Normative language

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

A **broker-capable route** is any runtime route whose selected compiled execution profile can run through Harness Broker. Codex headless v1 is the first required broker-capable route. Future Claude/Pi broker drivers are broker-capable routes when they emit `BrokerExecutionProfile`.

A **legacy path** is explicitly named, feature-gated migration code. Legacy is not an extension point. New harness behavior MUST NOT accrete in legacy code.

A **compiled execution profile** is one element of `CompiledRuntimePlan.executionProfiles`. HRC route decisions select profiles; they do not derive profiles from raw labels.

---

## 2. Plane ownership matrix

| Concern | ASP compiler plane | HRC control plane | Harness Broker execution plane |
| --- | --- | --- | --- |
| User/API request normalization | Receives normalized compile input | Owns | No |
| Operation/runtime/invocation identity allocation | Receives required IDs; may validate | Owns | Uses provided IDs; may generate only for standalone CLI/testing |
| Placement resolution | Owns | Requests/rejects | No |
| Bundle resolution/materialization | Owns | References/persists projection artifacts | No |
| Prompt/context materialization | Owns | Supplies input/policy; references only | Uses compiled paths/content only through spec |
| Harness family/runtime selection | Emits valid profiles | Selects one profile | Reports observed driver/runtime |
| Model resolution | Owns | Enforces admission/policy | No |
| Process command/args/cwd | Owns | Transmits unchanged | Executes |
| Process `lockedEnv` (declared, non-secret, hashed) | Owns the DECLARED `lockedEnv` only (not operator/ambient env) | Transmits unchanged | Composes spawn env from ambient allowlist + credentials + `lockedEnv` + `dispatchEnv` |
| `dispatchEnv` (per-invocation context/handles/correlation) | No (never in spec, not hashed) | Owns at dispatch time; supplies per-invocation | Validates and merges at spawn |
| Harness transport descriptor | Owns | Transmits unchanged | Interprets |
| Broker driver spec | Owns | Transmits unchanged | Interprets |
| Codex/Claude/Pi native protocol | No | Forbidden | Owns inside driver |
| Permission product policy | Receives HRC overlay; emits compiled policy | Owns final adjudication and audit | Emits requests; enforces decisions |
| Input policy | Emits requested profile policy | Admits against capability intersection | Enforces/disposes/queues |
| Turn lifecycle projection | No | Owns HRC projection | Emits normalized facts |
| Runtime reuse/adoption | No | Owns | Reports status/capabilities |
| Persistence | Emits projection/hashable artifacts | Owns durable state | No durable HRC state |
| Restart/reconcile | No | Owns | Supports status; v2 supports attach/replay |
| Public API compatibility | No | Owns | No |
| Projection/hashing of compiled artifacts | Owns canonical projection/hash forms | Persists/verifies | Emits normalized events/status (no redaction) |

---

## 3. Package contract

### 3.1 Shared runtime contracts package

Create and treat this as the only cross-plane DTO package:

```text
packages/spaces-runtime-contracts/
  src/ids.ts
  src/primitives.ts
  src/compiler-plan.ts
  src/execution-profile.ts
  src/capabilities.ts
  src/route-decision.ts
  src/runtime-state.ts
  src/operations.ts
  src/continuation.ts
  src/permissions.ts
  src/input.ts
  src/observability.ts
  src/hash.ts
  src/public-api.ts
  src/persistence.ts
  src/errors.ts
```

This package MUST contain DTOs, schema identifiers, canonicalization helpers, hash helpers, projection DTOs/helpers, and error-code constants. It MUST NOT import HRC server code, broker driver code, or concrete harness implementation packages.

### 3.2 Allowed dependencies

```text
agent-spaces            -> spaces-runtime-contracts
hrc-server              -> spaces-runtime-contracts
hrc-server              -> agent-spaces compiler API
hrc-server              -> spaces-harness-broker-client
hrc-server              -> spaces-harness-broker-protocol
harness-broker-client   -> spaces-harness-broker-protocol
harness-broker          -> spaces-harness-broker-protocol
harness-broker/drivers  -> concrete harness implementation packages
```

### 3.3 Disallowed dependencies

```text
hrc-server -> spaces-harness-codex
hrc-server -> spaces-harness-claude driver internals
hrc-server -> spaces-harness-pi driver internals
hrc-server -> harness-broker/src/drivers/*
hrc-server broker controller -> runtime-controllers/legacy-exec/*
agent-spaces -> hrc-server
harness-broker -> hrc-server
spaces-runtime-contracts -> concrete harness packages
```

### 3.4 Boundary checks

CI MUST enforce at least these checks, with precise allowlists for tests/type-only references:

```bash
# No broker-capable HRC path may invoke legacy launch execution.
rg "launch/exec|exec\.ts|legacy-launch" packages/hrc-server/src \
  -g '!**/runtime-controllers/legacy-exec/**' \
  -g '!**/__tests__/legacy-exec/**'

# No HRC broker path may import concrete harness driver internals.
rg "spaces-harness-codex|runCodexAppServerOneShot|codexAppServer|harness-broker/src/drivers" packages/hrc-* \
  -g '!**/runtime-controllers/legacy-exec/**' \
  -g '!**/__tests__/**'

# No HRC broker path may synthesize or mutate broker execution mechanics.
rg "new HarnessInvocationSpec|InvocationStartRequest\s*=|spec\.driver|spec\.process|process\.args|process\.lockedEnv|process\.cwd|driver:" packages/hrc-server/src \
  -g '!**/runtime-controllers/legacy-exec/**' \
  -g '!**/__tests__/**'
```

The third check needs allowlists for validation, hash comparison, projection persistence, and type-only usage. It MUST fail on construction or mutation sites.

---

## 4. Identity contract

HRC owns control-plane identity allocation. For HRC-owned broker routes, HRC MUST allocate the following before calling ASP:

```text
requestId        compile-request correlation
operationId      one HRC control-plane operation
runtimeId        reusable runtime identity
invocationId     broker invocation identity
initialInputId   initial input identity, when initial input exists
runId            user-visible run/turn identity, when start includes a turn
traceId          optional distributed trace identity
```

ASP MUST embed these IDs into the compiled plan/profile/start request as applicable. Harness Broker MUST preserve provided `invocationId` and `inputId`. The broker MAY generate IDs only for standalone broker CLI/testing paths where no HRC allocator exists; HRC production paths MUST NOT depend on broker-generated IDs.

This identity rule is required for stable hashes, replayable diagnostics, idempotent event mapping, and operation auditability.

---

## 5. Hashing, projection, and canonicalization contract

### 5.1 Canonical JSON

All cross-plane hashes MUST use a single canonical JSON encoder with these rules:

1. Object keys sorted lexicographically.
2. Arrays preserved in order.
3. `undefined` omitted.
4. `null` preserved.
5. Numbers serialized in normal JSON form; non-finite numbers forbidden.
6. Timestamps omitted from semantic hashes unless explicitly listed as semantic.
7. Hash material is a **named canonical projection** versioned `hashProjection: 'runtime-contract-semantic/v2'`. `lockedEnv` is declared non-secret config and is **included** in hash material (keys and values); `dispatchEnv` is never in the spec or hash material. This projection policy is orthogonal to the canonicalization algorithm `HashAlgorithm = 'sha256-canonical-json/v1'`; the two version strings are kept separate.

### 5.2 Hash vocabulary

All hashes are **closure/dedup/route/reuse/test** tools, **not** confidentiality controls. Each hash is computed over a named canonical projection of its source object per §5.1 rule 7. The canonical `lockedEnv` object (declared non-secret config) is included in hash material; `dispatchEnv` is in no hash material.

| Hash | Owner | Meaning |
| --- | --- | --- |
| `planHash` | ASP | Semantic hash of the compiled plan projection (minus self-hash fields, ephemeral timestamps; includes the canonical `lockedEnv` object). |
| `profileHash` | ASP | Semantic hash of one execution profile projection (minus self-hash fields, ephemeral timestamps; includes the canonical `lockedEnv` object). |
| `compatibilityHash` | ASP | Hash of fields that determine runtime reuse compatibility: command, args, cwd, transport, driver config/model/reasoning, bundle identity/lock, policy, resource limits, continuation provider/kind/non-secret identity, **plus the canonical `lockedEnv` object** (declared non-secret config; keys and values are hashed). |
| `specHash` | ASP | Semantic hash of broker `HarnessInvocationSpec`; includes the canonical `lockedEnv` object. |
| `startRequestHash` | ASP | Semantic hash of broker `InvocationStartRequest`; includes the canonical `lockedEnv` object (initial input **included**). |
| `contentHash` | ASP/HRC | Content hash of persisted artifact JSON/file bytes. |

HRC MAY verify that the selected profile’s immutable values still hash to the ASP-supplied hashes immediately before sending them to the broker. HRC MUST NOT use hashes to reconstruct missing execution mechanics.

### 5.3 Confidentiality and the spawn-env model

There is no generic secret classification, redaction transform, or digest-substituted value in the contract plane. The compiled spec carries `lockedEnv` (declared non-secret config) directly; durable, storage, and display planes persist explicit **projections** that MAY carry `lockedEnv` (non-secret). Confidentiality is enforced by keeping credential material out of the compiled spec entirely — credentials reach the harness only through a broker/driver-owned credential source (env value, external store, or an on-disk file credential materialized outside the DTO; see PLANE_SPEC §7.5.1) — **not** by contract-DTO redaction.

**Hard secret rule:** Secrets MUST NEVER appear in the compiled spec — including `spec.process.lockedEnv`, argv, cwd, driver config, initial input, labels, or correlation. Credential material reaches the harness only through a broker/driver-owned credential source (broker launch environment, external secret store, or an on-disk file credential materialized outside the compiled DTO; see PLANE_SPEC §7.5.1). The compiled spec is credential-free and ambient-free by contract.

**Spawn-env composition.** (The canonical statement lives in PLANE_SPEC; this is the compact version.) The broker composes the harness spawn environment as a **validated disjoint union** across four channels:

```text
harnessEnv = ambientAllowlist ⊎ credentials ⊎ lockedEnv ⊎ dispatchEnv
```

Key collisions across channels are **validation errors, never precedence**. `lockedEnv` and `dispatchEnv` MUST be disjoint from the ambient-baseline, credential/capability, and harness-reserved operational key classes; `dispatchEnv` MUST additionally not shadow any `lockedEnv` key. Controlled reserved-key overrides go through a typed driver-config field.

The four channels are:

- **ambient allowlist** — broker-inherited, not in spec, not hashed;
- **credentials** — broker/driver/external (env-value source) **or on-disk file credential** materialized outside the DTO, never in spec, not hashed; missing env-value creds → typed pre-start error, while on-disk file creds MAY surface as the native harness startup failure (Codex v1: empty credentials map, `auth.json` under `CODEX_HOME`, materialized by runtime-home prep as today) — see PLANE_SPEC §7.5.1;
- **lockedEnv** — ASP-declared, in spec, HASHED, HRC-immutable;
- **dispatchEnv** — HRC-supplied per-invocation, NOT in spec, NOT hashed, NOT a recompile trigger.

There is **no** reuse-soundness / `environmentRevision` rule. Credentials are read directly by the harness/broker, not via env passthrough; they are simply absent from `compatibilityHash`, so there is no reuse-invalidation language. Guardrail: anything affecting compiled launch shape or reuse compatibility is `lockedEnv` (hashed); a future route MUST NOT hide runtime mechanics in `dispatchEnv` or credentials — this guards against hiding mechanics, not an `environmentRevision` subsystem.

---

## 6. ASP compiler plane contract

### 6.1 API surface

ASP exposes the compiler API:

```ts
compileRuntimePlan(req: RuntimeCompileRequest): Promise<RuntimeCompileResponse>
```

`RuntimeCompileResponse` is either:

```text
ok: true, plan: CompiledRuntimePlan
ok: false, diagnostics: CompileDiagnostic[]
```

ASP MAY continue exposing legacy helper APIs during migration, but HRC broker-capable routes MUST call `compileRuntimePlan`, not `buildHarnessBrokerInvocation` directly.

### 6.2 Compile input

HRC supplies:

- identity allocation;
- host session/generation;
- placement;
- requested provider/model/harness/runtime/interaction mode;
- prompt, attachments, task context, and materialization hints;
- HRC policy overlays for permission, input, exposure, resources, and observability;
- continuation refs;
- correlation fields.

Compile input is the only place where HRC may affect broker execution mechanics. If HRC policy changes after compilation, the route must reject or recompile unless the policy change is represented by a documented non-mechanical overlay that does not mutate the broker request.

### 6.3 Compiler responsibilities

ASP MUST own and emit:

- placement resolution;
- resolved runtime bundle identity and lock;
- target materialization;
- model/provider resolution;
- harness family/runtime resolution;
- prompt/context expansion and materialization;
- attachment resolution and allowed attachment shape;
- process command/args/cwd and declared `lockedEnv`;
- harness transport descriptor;
- driver spec, including Codex app-server descriptors;
- continuation encoding into broker/native shape;
- permission/input/exposure policy compilation;
- resource limits;
- observability/correlation embedding;
- all semantic hashes;
- compiler diagnostics.

ASP MUST resolve `lockedEnv` from resolved space/agent/target config (validated), NEVER from `process.env`, and MUST NOT project operator/ambient env into the spec.

### 6.4 Compiler non-responsibilities

ASP MUST NOT:

- start broker processes;
- create HRC runtime records;
- admit or reject routes based on live HRC state;
- decide runtime reuse/adoption;
- persist HRC operational state;
- parse broker events;
- mutate HRC public API views.

### 6.5 Compiler output

ASP emits exactly one immutable compiler product:

```text
CompiledRuntimePlan
```

The plan contains one or more `RuntimeExecutionProfile` objects. Each profile is a complete execution strategy. For Codex headless v1, ASP MUST emit a `BrokerExecutionProfile` when the requested route is admissible at compile time.

A broker profile MUST include a complete `InvocationStartRequest`, including `spec` and optional `initialInput`. It MUST include `specHash`, `startRequestHash`, policy, continuation refs, expected capabilities, `compatibilityHash`, and observability contract. The live profile carries the raw `startRequest` plus these hashes only; it does **not** embed projection DTOs. HRC persists projections (`spec`/`start-request`/`plan`/`profile`) separately at the persistence/display boundary.

### 6.6 Execution profile rule

Profiles are closed products. HRC may select, reject, persist, or send them. HRC may not complete them. If ASP cannot produce a complete broker profile, it MUST emit diagnostics; HRC must select another already-complete profile or reject/recompile.

### 6.7 Recompile triggers

HRC MUST recompile when any of these change after plan creation:

- placement;
- resolved bundle or materialized root;
- model/provider/reasoning effort;
- harness family/runtime;
- interaction mode;
- prompt/context/attachments;
- `lockedEnv` (keys **and** values; both are hashed and a reuse key);
- process path/cwd/args;
- driver config;
- permission/input/exposure policy if encoded into profile;
- resource limits;
- continuation key/kind/provider;
- observability fields that alter harness process or driver config;
- any field included in `compatibilityHash`, `specHash`, or `startRequestHash`.

Changes to `dispatchEnv` are **NOT** a recompile trigger; `dispatchEnv` is HRC-supplied per-invocation, is in no hash material, and is merged at spawn.

### 6.8 Diagnostics

Diagnostics MUST be structured and MUST omit secret/credential material. An error diagnostic means HRC may not use the affected profile. A warning diagnostic may still be route-admissible if HRC policy allows it.

Diagnostics are compiler facts, not runtime events. HRC persists them as artifacts and may project them as public warnings.

### 6.9 Semantic boundary rule (lockedEnv vs dispatchEnv)

Anything affecting compiled launch shape or reuse compatibility — command/executable, cwd, driver config, transport, model/provider/reasoning, resource/policy, materialization paths, `ASP_HOME`, tool paths, routing flags — is `lockedEnv` and is hashed. `dispatchEnv` carries only per-invocation context/handles/correlation that the harness/tool consumes without changing the compiled runtime shape; a handoff id qualifies only as an opaque non-secret handle.

---

## 7. HRC runtime control plane contract

### 7.1 HRC responsibilities

HRC owns:

- public HTTP/SDK API shape;
- request normalization;
- operation/runtime/run identity allocation;
- session/generation policy;
- call into ASP compiler;
- route admission;
- selection of one compiled execution profile;
- runtime reuse/adoption/new-runtime decision;
- HRC product/security policy adjudication;
- capability intersection;
- controller invocation;
- broker process supervision above the broker boundary;
- persistence of plans, operations, invocations, events, state, artifacts;
- public compatibility aliases;
- permission mediation and audit;
- event projection into HRC run/message/runtime records;
- stop/interrupt/dispose/reconcile;
- conservative restart behavior.

### 7.2 HRC forbidden actions for broker-capable routes

HRC MUST NOT:

- invoke `launch/exec.ts`;
- create launch artifacts for broker execution;
- use callback/spool files as the broker execution event bus;
- import concrete harness driver packages;
- parse native harness protocols;
- inspect Codex JSONL/native app-server event names;
- construct or mutate `HarnessInvocationSpec` or `InvocationStartRequest`;
- patch driver config;
- patch process command/args/cwd or `lockedEnv`;
- write harness-specific config/OTEL files;
- silently fallback from broker to legacy execution.

### 7.3 Public API surface

HRC exposes public lifecycle and execution APIs. Existing endpoints may remain, but the response views MUST add controller/profile/capability fields while deriving legacy `transport` aliases.

Required public surfaces:

```text
POST /v1/runtimes/ensure
POST /v1/runtimes/start
POST /v1/turns
POST /v1/runtimes/input
POST /v1/runtimes/interrupt
POST /v1/runtimes/stop
POST /v1/runtimes/dispose
POST /v1/runtimes/inspect
GET  /v1/runtimes
POST /v1/runtimes/reconcile
POST /v1/runtimes/sweep
POST /v1/permissions/respond        # needed only when ask-client is enabled
```

Compatibility aliases may keep existing endpoint names such as `/v1/interrupt` and `/v1/terminate`, but the internal implementation MUST call runtime controllers by controller kind, not by legacy `transport`.

### 7.4 Runtime start contract

For broker-capable Codex headless start:

```text
1. HRC normalizes request and allocates IDs.
2. HRC calls ASP compileRuntimePlan(req).
3. HRC route engine selects exactly one compiled profile by profileId/profileHash.
4. HRC validates product policy and capability requirements.
5. HRC persists plan/profile projections and diagnostics.
6. HRC creates RuntimeOperation(kind='broker_invocation').
7. HRC starts one broker process for the runtime.
8. HRC sends broker.hello.
9. HRC validates broker hello capabilities and driver summary.
10. HRC verifies selected profile hashes without mutating profile content.
11. HRC sends an `InvocationDispatchRequest { startRequest, dispatchEnv? }` to the broker; `startRequest` (= selectedProfile.harnessInvocation.startRequest) is forwarded **verbatim** and is the only hashed payload. The broker validates `dispatchEnv` at dispatch (HRC MAY preflight) and merges it at spawn.
12. HRC persists BrokerInvocation.
13. HRC consumes broker event notifications.
14. HRC projects broker events through one BrokerEventMapper.
15. HRC returns RuntimeExecutionView / StartRuntimeResponse.
```

If any required capability is missing, HRC MUST reject, recompile for another profile, or explicitly degrade through a documented HRC policy. Silent degradation is forbidden.

### 7.5 Dispatch/input contract

For a runtime in `ready` state, HRC may dispatch user input through the selected controller. For broker runtimes, dispatch means:

```text
1. HRC creates RuntimeOperation(kind='broker_input' or 'broker_turn').
2. HRC checks persisted runtime state and broker status.
3. HRC checks input policy and effective capabilities.
4. HRC sends invocation.input with caller input.
5. HRC persists input disposition.
6. Broker emits input/turn events.
7. BrokerEventMapper projects run/message/runtime records.
```

For a runtime in `turn_active` state:

- if policy is `reject`, HRC returns busy/rejected;
- if policy is `queue`, HRC may queue only when the selected profile, HRC policy, broker hello, and invocation capabilities all support queue;
- if policy is `interrupt_then_apply`, HRC returns unsupported until broker support exists.

### 7.6 Runtime route decision contract

HRC consumes `RuntimeRouteInput` and emits `RuntimeRouteDecision`. The decision MUST:

- reference `compileId` and `planHash`;
- select one profile by `selectedProfileId` and `selectedProfileHash`;
- name the controller;
- contain admission result;
- contain reuse/adoption/new policy;
- contain capability resolution;
- contain product policy outcome;
- derive legacy `transport` alias.

HRC MUST NOT derive hidden execution profiles from raw provider/harness/transport strings. A controller may only execute the selected profile.

### 7.7 Runtime controller contract

Each controller implements the same control-plane interface:

```text
start
inspect
reconcile
dispatchTurn / deliverInput
interrupt
stop
dispose
```

Controllers execute mechanics. They do not recompute route policy. A controller receives a route decision plus selected immutable profile and returns typed result objects. Controller implementations may supervise processes they own, but the broker controller only supervises the broker process; it does not synthesize harness process mechanics.

### 7.8 HarnessBrokerController contract

`HarnessBrokerController` consumes a selected `BrokerExecutionProfile`. It MUST NOT build or patch the profile. It owns:

- broker process spawn/supervision;
- broker client lifecycle;
- broker hello/health/status calls;
- passing `InvocationStartRequest` unchanged;
- dispatching `InvocationInputRequest` according to HRC policy/capabilities;
- consuming broker event notifications;
- forwarding broker-to-client permission requests to HRC permission mediation;
- stop/interrupt/dispose calls;
- reconciliation based on broker process and status.

It MUST NOT:

- import concrete drivers;
- call Codex app-server helpers;
- parse native driver events;
- write Codex/Claude/Pi config;
- alter `startRequest.spec.process` or `startRequest.spec.driver`.

### 7.9 Permission mediation contract

HRC owns final product/security permission decisions. Broker emits permission requests either as broker-to-client JSON-RPC requests or as typed normalized events. HRC MUST audit every request and decision.

Rules:

- default policy is deny;
- no negotiated permission channel means deny;
- missing explicit default means deny;
- timeout uses explicit default decision;
- `yolo` compiles to explicit allow policy with provenance and audit;
- broker/driver emits a bounded display subject (`subject_display_json`); raw native payloads are not persisted by default;
- `ask-client` is enabled only if broker hello advertises broker-to-client requests and selected profile requires/permits it.

### 7.10 Event projection contract

HRC MUST persist broker events by `(invocationId, seq)` before or atomically with projection. Projection MUST be idempotent. There MUST be exactly one broker event mapper for broker-to-HRC event projection.

Broker events become:

- runtime state transitions;
- run state transitions;
- message records;
- tool call records;
- usage records;
- continuation records;
- diagnostics;
- permission audit records.

No route handler may independently parse broker event payloads to update run/runtime state except through the mapper.

### 7.11 Runtime state contract

Runtime state is a discriminated union by `kind`. Broker runtime state MUST contain:

- compile identity: compile ID, plan hash, profile hash, spec hash, start-request hash;
- broker identity: protocol, PID/endpoint, owner server instance;
- invocation identity: invocation ID, state, driver, child PID, capabilities, last event sequence;
- continuation refs;
- permission/input runtime state;
- active run ID.

Legacy `transport` remains compatibility only.

### 7.12 Persistence contract

HRC MUST persist the following record families:

```text
compiled_runtime_plans
runtime_operations
broker_invocations
broker_invocation_events
runtime_artifacts
permission_decisions
runtime state columns on runtimes
```

At minimum, broker routes must persist:

- `operationId`;
- `runtimeId`;
- `runId` when present;
- `invocationId`;
- `compileId`;
- `planHash`;
- `selectedProfileId`;
- `selectedProfileHash`;
- `specHash`;
- `startRequestHash`;
- plan/profile/spec/start-request projections (credential-free and ambient-free; declared `lockedEnv` included);
- capability resolution;
- route decision JSON;
- broker event ledger with `(invocationId, seq)`;
- continuation refs;
- permission audit records.

Persisted compiler artifacts are evidence for compiler closure. They are not a cache from which HRC may reconstruct process/driver mechanics.

### 7.13 Restart and reconcile contract

V1 is conservative. Unless broker attach/replay exists and is implemented, HRC MUST NOT claim live reattach after restart.

On restart:

- if broker process is gone and active run exists, mark runtime unknown/failed and finalize active run degraded according to policy;
- if broker status is reachable and terminal, reconcile active run to terminal state;
- if no terminal broker event exists, synthesize degraded completion only through reconciliation policy;
- do not claim continuation unless persisted continuation or broker status/event proves it;
- do not kill unrelated harness processes during orphan cleanup.

V2 may support attach/replay only when broker implements `broker.attach`, `invocation.eventsSince`, `invocation.snapshot`, and event ack semantics.

### 7.14 Public compatibility contract

Public responses MUST expose modern fields:

- controller kind;
- harness family/runtime/provider;
- interaction mode;
- startup method;
- turn delivery;
- runtime capabilities;
- compile ID;
- plan hash;
- selected profile hash;
- active operation ID;
- active invocation ID.

Public responses MAY also expose legacy `transport: 'tmux' | 'headless' | 'sdk'`, but it must be derived:

```text
terminal        -> tmux
embedded-sdk    -> sdk
harness-broker  -> headless
command-process -> headless
legacy-exec     -> headless
```

New internal routing MUST NOT branch on legacy `transport`.

---

## 8. Harness Broker execution plane contract

### 8.1 Broker responsibilities

Harness Broker owns:

- broker protocol implementation;
- driver registry;
- harness process execution below broker boundary;
- native driver protocol parsing;
- child process supervision;
- permission request emission;
- input disposition;
- ordered normalized event stream;
- invocation status;
- driver-level continuation reporting;
- stop/interrupt/dispose mechanics.

### 8.2 Broker forbidden actions

Harness Broker MUST NOT:

- import HRC server code;
- write HRC database records;
- expose native driver events as HRC public events;
- require HRC to parse driver-native payloads;
- infer HRC product policy beyond compiled policy and protocol decisions;
- mutate compiled `HarnessInvocationSpec` except for internal runtime bookkeeping that is not reflected as contract output.

### 8.3 Transport contract

V1 transport is:

```text
stdio-jsonrpc-ndjson
JSON-RPC 2.0 requests/responses
JSON-RPC notifications for invocation events
JSON-RPC broker-to-client requests for permission requests when negotiated
```

HRC starts one broker process per runtime for v1. Shared broker processes are forbidden until broker advertises and proves multi-invocation plus attach/replay semantics.

### 8.4 Required v1 commands

V1 required commands:

```text
broker.hello
broker.health
invocation.start
invocation.input
invocation.interrupt
invocation.stop
invocation.status
invocation.dispose
```

V1 required notifications/requests:

```text
notification: invocation.event
request:      invocation.permission.request    # only when negotiated
```

`invocation.events` is not a required v1 command if event delivery is notification-only. If replay is needed, implement v2 commands rather than implying v1 replay.

### 8.5 Required v2 commands

V2 attach/replay commands:

```text
broker.attach
broker.listInvocations
invocation.eventsSince
invocation.ackEvents
invocation.snapshot
invocation.permission.respond
```

HRC restart may use live reattach only after these commands are implemented and tested.

### 8.6 Hello and capability contract

`broker.hello` negotiates:

- protocol version;
- broker version;
- broker-level capabilities;
- client capabilities, including permission request handling;
- driver summaries;
- driver capabilities.

If no common protocol exists, broker rejects. HRC MUST fail route admission if required expected capabilities are absent.

### 8.7 Invocation start contract

`invocation.start` receives an `InvocationDispatchRequest { startRequest, dispatchEnv? }` envelope. The `startRequest` is the compiled `InvocationStartRequest` (with `HarnessInvocationSpec` and optional `initialInput`) forwarded verbatim and is the only hashed payload. Broker MUST validate the request against protocol schema, validate `dispatchEnv` at dispatch (disjoint from ambient/credential/reserved key classes and not shadowing any `lockedEnv` key), choose the driver by `spec.harness.driver`, compose the spawn env as the validated disjoint union of ambient allowlist + credentials + `lockedEnv` + `dispatchEnv`, and start the harness process.

Broker MUST preserve HRC-provided `invocationId` when present. Broker response includes invocation ID, initial state, and invocation capabilities.

Broker MUST emit ordered events starting with `invocation.started` or `invocation.failed`. If initial input exists and is accepted, broker emits input and turn events.

### 8.8 Invocation lifecycle state machine

Valid invocation states:

```text
starting -> ready
starting -> turn_active       # if initial input starts a turn
starting -> failed
ready -> turn_active
ready -> stopping
ready -> disposed
turn_active -> ready
turn_active -> stopping
turn_active -> failed
stopping -> exited
stopping -> failed
exited -> disposed
failed -> disposed
```

Broker status MUST report the current state, current turn ID when present, continuation when known, capabilities, and process info when known.

### 8.9 Input contract

`invocation.input` accepts input only according to invocation state, compiled policy, broker policy, and driver capability.

Disposition values:

```text
started
queued
rejected
```

For v1 Codex broker default:

```text
ready + user input -> started
turn_active + reject policy -> rejected
turn_active + queue policy without queue capability -> rejected(queue-not-supported)
interrupt_then_apply -> unsupported unless driver capability exists
```

### 8.10 Event contract

Broker events are ordered by monotonically increasing `seq` per invocation. Event envelopes MUST include invocation ID, sequence, time, type, payload, and optional turn/input/item/correlation/driver metadata. HRC persists events by `(invocationId, seq)`.

Required normalized event families:

```text
invocation.started
invocation.ready
input.accepted
input.queued
input.rejected
turn.started
assistant.message.started
assistant.message.delta
assistant.message.completed
tool.call.started
tool.call.delta
tool.call.completed
tool.call.failed
usage.updated
continuation.updated
turn.completed
turn.failed
turn.interrupted
invocation.stopping
invocation.exited
invocation.failed
invocation.disposed
diagnostic
driver.notice
permission.requested
permission.resolved
```

The current protocol name `invocation.permission.request` MUST be normalized before final freeze to `permission.requested` or explicitly versioned as broker-to-client request method only. The event union must include permission events if they are emitted as events.

### 8.11 Permission request contract

If permission policy is `ask-client` and client capability is negotiated, broker may issue:

```text
request method: invocation.permission.request
params: PermissionRequestParams
response: PermissionDecision
```

Broker MUST default-deny when the request channel is unavailable or handler fails unless an explicit compiled default says otherwise. If timeout occurs, broker uses the explicit default decision. Missing default means deny.

Broker SHOULD also emit normalized `permission.requested` and `permission.resolved` events for auditability, but the final protocol must avoid duplicate semantics. If both broker-to-client request and event are emitted, the request is the control message and events are audit facts.

### 8.12 Driver SPI contract

Each driver implements:

- driver summary and static capabilities;
- `start(spec, initialInput)`;
- `input(req)`;
- `interrupt(req)`;
- `stop(req)`;
- `status()`;
- `dispose()`;
- native event parser;
- continuation extractor.

Driver code is the only place where native harness protocol semantics live. HRC never imports or parses driver internals.

---

## 9. Capability contract

Effective runtime behavior is the intersection of:

```text
ASP expected capabilities
∩ HRC route/product policy
∩ Broker hello capabilities
∩ Broker invocation capabilities
∩ persisted runtime capabilities
```

Capability resolution result is one of:

```text
compatible
degrade   # only with explicit HRC policy
reject
```

Silent degrade is forbidden. `headless`, `sdk`, `tmux`, `codex-cli`, `agent-sdk`, and `broker-capable` are labels, not capability models.

---

## 10. Policy contracts

### 10.1 Permission policy

Default is deny. Explicit allow requires provenance. Ask-client requires negotiated broker-to-client request capability and explicit timeout/default semantics.

### 10.2 Input policy

Default Codex broker v1 input policy:

```text
readyInput: start-turn
busy: reject
supportedKinds: user
localImages: true
fileRefs: false
```

Queue requires support from compiled profile, HRC policy, broker hello/invocation capabilities, and driver implementation.

### 10.3 Agentchat exposure policy

Broker headless defaults to:

```text
{ mode: 'none' }
```

It MUST NOT inherit terminal Agentchat behavior. Explicit broker Agentchat exposure requires a concrete target contract.

### 10.4 Resource policy

Resource limits are compiled into the selected profile. HRC may reject based on policy but MUST NOT patch process limits after compilation.

---

## 11. Persistence contract

### 11.1 Required tables / record families

The to-be persistence model contains:

```sql
CREATE TABLE IF NOT EXISTS compiled_runtime_plans (
  plan_hash TEXT PRIMARY KEY,
  compile_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  compiler_name TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  plan_projection_json TEXT NOT NULL,
  diagnostics_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_operations (
  operation_id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL,
  run_id TEXT,
  host_session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  operation_kind TEXT NOT NULL,
  controller TEXT NOT NULL,
  compile_id TEXT,
  plan_hash TEXT,
  selected_profile_id TEXT,
  selected_profile_hash TEXT,
  startup_method TEXT NOT NULL,
  turn_delivery TEXT,
  status TEXT NOT NULL,
  route_decision_json TEXT NOT NULL,
  capability_resolution_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS broker_invocations (
  invocation_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  run_id TEXT,
  broker_protocol TEXT NOT NULL,
  broker_driver TEXT NOT NULL,
  broker_pid INTEGER,
  child_pid INTEGER,
  invocation_state TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  continuation_json TEXT,
  broker_continuation_json TEXT,
  spec_hash TEXT NOT NULL,
  start_request_hash TEXT NOT NULL,
  selected_profile_hash TEXT NOT NULL,
  spec_projection_json TEXT,
  start_request_projection_json TEXT,
  last_event_seq INTEGER,
  owner_server_instance_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS broker_invocation_events (
  invocation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  time TEXT NOT NULL,
  type TEXT NOT NULL,
  run_id TEXT,
  runtime_id TEXT NOT NULL,
  broker_event_json TEXT NOT NULL,
  hrc_event_seq INTEGER,
  projection_status TEXT NOT NULL DEFAULT 'pending',
  projection_error TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (invocation_id, seq)
);

CREATE TABLE IF NOT EXISTS runtime_artifacts (
  artifact_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  storage_kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  artifact_json TEXT,
  artifact_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS permission_decisions (
  permission_request_id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL,
  subject_display_json TEXT NOT NULL,
  default_decision TEXT NOT NULL,
  decision TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
```

`lockedEnv`-bearing projection JSON (e.g. `plan_projection_json`, `spec_projection_json`, `start_request_projection_json`) MAY carry the canonical `lockedEnv` object (non-secret). `dispatchEnv` is **NOT** persisted in the contract projection plane; if any audit captures it, it is operational dispatch metadata that lives outside the contract projection plane.

### 11.2 Runtime columns

Existing `runtimes` records gain:

```sql
runtime_controller TEXT
interaction_mode TEXT
harness_family TEXT
harness_runtime TEXT
model_provider TEXT
compile_id TEXT
plan_hash TEXT
selected_profile_hash TEXT
route_decision_json TEXT
runtime_state_json TEXT
legacy_transport TEXT
```

### 11.3 Migration principle

Migrate behavior before storage cleanup:

1. Add new fields/tables.
2. Write both old and new fields.
3. Read new fields and derive old API fields.
4. Delete old internal branching.
5. Stop using `launches` for broker routes.
6. Delete broker-capable legacy execution path.

---

## 12. Route catalog contract

The route catalog is a validation catalog, not a compiler substitute. HRC route decisions select profiles from compiled plans and validate them against the catalog.

Required route families:

```text
anthropic + claude-code + interactive      -> terminal controller
openai    + codex-cli   + interactive      -> terminal controller
anthropic + agent-sdk   + nonInteractive   -> embedded-sdk controller
openai    + pi-sdk      + nonInteractive   -> embedded-sdk controller
openai    + codex-cli   + headless         -> harness-broker controller, codex-app-server driver
openai    + codex-cli   + headless legacy  -> legacy-exec only under explicit opt-in
```

Hard exclusions:

```text
No openai + claude-code route.
No anthropic + codex route.
No SDK runtime under terminal controller.
No broker input outside harness-broker controller.
No legacy-exec for new harness behavior.
No broker-capable Codex headless through command-process.
No route requiring HRC to construct broker specs after compilation.
```

---

## 13. Cross-plane lifecycle flows

### 13.1 Broker start with initial turn

```text
Client -> HRC /v1/runtimes/start or /v1/turns
HRC allocates request/operation/runtime/invocation/input/run IDs
HRC -> ASP compileRuntimePlan
ASP -> HRC CompiledRuntimePlan with BrokerExecutionProfile
HRC persists plan projection and creates RuntimeOperation
HRC selects profile and validates capabilities/policy
HRC starts broker process
HRC -> Broker broker.hello
Broker -> HRC hello response
HRC -> Broker invocation.start(startRequest unchanged)
Broker -> HRC start response
Broker -> HRC invocation.event notifications
HRC persists events by (invocationId, seq)
HRC BrokerEventMapper projects runtime/run/message state
HRC -> Client RuntimeExecutionView / DispatchTurnResponse
```

### 13.2 Dispatch to ready broker runtime

```text
Client -> HRC /v1/turns or /v1/runtimes/input
HRC validates runtime state/capabilities/input policy
HRC creates RuntimeOperation
HRC -> Broker invocation.input
Broker -> HRC input response
Broker -> HRC input/turn/message/tool/usage/continuation events
HRC maps events idempotently
HRC -> Client DispatchTurnResponse
```

### 13.3 Permission request

```text
Broker driver observes native permission request
Broker emits/requests invocation.permission.request
HRC permission mediator validates capability and policy
HRC writes permission_decisions audit row
HRC returns PermissionDecision
Broker enforces decision
Broker emits permission.resolved audit event
HRC maps audit event idempotently
```

### 13.4 Stop/dispose

```text
Client -> HRC stop/dispose
HRC creates RuntimeOperation
HRC -> Broker invocation.stop or invocation.dispose
Broker emits stopping/exited/disposed or failed
HRC maps terminal events
HRC updates runtime/run state
HRC closes broker process when appropriate
```

### 13.5 Restart/reconcile v1

```text
HRC boots
HRC loads broker runtimes with runtime_state_json
If broker process reachable: status -> reconcile
If broker process unreachable: mark unknown/failed; finalize active runs degraded by policy
No live reattach claim unless v2 attach/replay exists
```

---

## 14. Test gates

### 14.1 Compiler tests

- ASP emits `CompiledRuntimePlan` for supported runtime shapes.
- Codex headless emits complete `BrokerExecutionProfile`.
- Plan/profile/spec/start-request hashes are stable.
- Projection-hash determinism: the same source object yields the same hash, computed over the named canonical projection (which includes the canonical `lockedEnv` object).
- `lockedEnv` values affect hashes: changing a `lockedEnv` key or value changes the affected semantic hashes (`planHash`/`profileHash`/`specHash`/`startRequestHash`/`compatibilityHash`).
- `dispatchEnv` is hashed nowhere and is changeable without recompile.
- The compiled spec is credential-free and ambient-free; secrets/credentials never appear in `spec.process.lockedEnv`, argv, cwd, driver config, initial input, labels, or correlation.
- A `lockedEnv` key that collides with a reserved/credential/ambient key class is rejected at compile time.
- Changing process/driver mechanics changes semantic hashes.
- Missing broker profile produces diagnostics, not HRC-side patching.
- Mutation attempts violate compiler closure tests.

### 14.2 HRC boundary tests

- Codex broker start does not spawn `launch/exec.ts`.
- Codex broker dispatch does not spawn `launch/exec.ts`.
- HRC broker path does not import concrete Codex/Claude/Pi driver packages.
- HRC broker path does not parse native harness events.
- HRC broker path does not assign `spec.driver`, `spec.process.args`, `spec.process.lockedEnv`, or `spec.process.cwd`.
- A `dispatchEnv` key that collides with a `lockedEnv`/reserved/credential/ambient key is rejected at dispatch.
- Legacy path requires explicit opt-in.

### 14.3 Route/capability tests

- `openai + codex + headless` resolves to `harness-broker` by default.
- `openai + codex + interactive` resolves to terminal.
- `anthropic + claude-code + nonInteractive` resolves to embedded SDK unless a real broker profile exists.
- Old `transport` aliases are derived.
- Missing required capability rejects before broker start.
- Degradation requires explicit policy.

### 14.4 Broker lifecycle tests

- `broker.hello` protocol mismatch fails cleanly.
- `invocation.start` persists invocation ID, spec hash, start-request hash, and capabilities.
- `invocation.ready` marks runtime ready.
- `turn.started` marks run started and runtime busy.
- `turn.completed` marks run completed and runtime ready.
- `invocation.failed` fails active run.
- `invocation.exited` without `turn.completed` finalizes active run degraded.
- Duplicate events are ignored by `(invocationId, seq)`.
- Out-of-order terminal handling is deterministic.
- Broker process exit triggers reconcile.

### 14.5 Permission tests

- Default deny declines requests and writes audit.
- Explicit allow requires provenance and writes audit.
- Ask-client without negotiated capability denies.
- Ask-client timeout uses explicit default.
- Missing default denies.
- Permission subject persisted as a bounded display subject (`subject_display_json`); raw native payloads are not persisted.

### 14.6 Input tests

- Ready invocation accepts user input and starts turn.
- Busy invocation with reject policy returns busy/rejected.
- Queue without broker queue capability returns `queue-not-supported`.
- FIFO queue works only when profile, HRC policy, broker capability, and driver capability all allow it.
- `interrupt_then_apply` returns unsupported until implemented.

### 14.7 Recovery tests

- Restart with starting broker runtime and missing broker marks failed/unknown.
- Restart with active run and missing broker finalizes degraded/unknown by policy.
- Broker terminal status reconciles open run terminal.
- Persisted continuation survives restart.
- Orphan cleanup does not kill unrelated harness processes.

---

## 15. Final acceptance definition

The to-be contract surface is accepted only when all are true:

1. ASP emits versioned, hashable `CompiledRuntimePlan` artifacts; the compiled spec carries declared non-secret `lockedEnv` (hashed) and is credential-free and ambient-free; `dispatchEnv` is hashed nowhere and is changeable without recompile.
2. HRC route decisions select profiles from compiled plans.
3. Codex headless selects `controller: 'harness-broker'` by default.
4. HRC never reconstructs, mutates, patches, infers, or synthesizes broker execution mechanics after ASP compilation.
5. HRC broker paths do not import concrete harness driver packages.
6. HRC broker paths do not spawn or reference `launch/exec.ts`.
7. HRC broker paths do not parse native harness events.
8. Broker invocation identity, plan hash, selected profile hash, spec hash, start-request hash, capabilities, continuation, state, and event sequence are persisted.
9. Broker events are mapped through one idempotent `BrokerEventMapper`.
10. Permission decisions are explicit, audited, default-deny, and persist only a bounded display subject.
11. Busy-input behavior is explicit and tested against actual broker capabilities.
12. HRC restart behavior is conservative in v1 and live-reattachable only after broker attach/replay support exists.
13. Public APIs expose controller/profile/capability fields and derive old `transport` aliases.
14. Legacy `exec.ts` is feature-gated, isolated, and deleted after Codex broker cutover.
15. Cross-repo boundary checks enforce dependency direction.
16. Persisted/displayed artifacts are named canonical projections that include the canonical `lockedEnv` object (non-secret); secrets/credentials never appear in `spec.process.lockedEnv`, argv, cwd, driver config, initial input, labels, or correlation; a `lockedEnv` collision with a reserved/credential key is rejected at compile and a `dispatchEnv` collision is rejected at dispatch; and there is no secret classification, redaction transform, or digest-substituted value anywhere in the contract plane.

Final deletion criterion:

> There is no broker-capable harness execution path in HRC that depends on `exec.ts`, launch artifacts, callback/spool delivery, HRC-owned harness protocol parsing, or HRC-owned reconstruction of ASP-compiled broker execution mechanics.
