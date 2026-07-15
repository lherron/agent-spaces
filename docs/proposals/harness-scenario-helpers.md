# Deterministic Harness Scenario Helpers

- **Status**: proposal; rollout tracked; no implementation
- **Date**: 2026-07-15
- **Scope**: `agent-spaces` first, with an intentional consumption seam for `hrc-runtime`
- **Proposed package**: `packages/harness-scenarios` published as `spaces-harness-scenarios`
- **Architecture review**: Daedalus approved with the conditions incorporated below (hrcchat message 14755)
- **Rollout container**: `agent-spaces/harness-scenario-helpers` (`T-06393` through `T-06397`)

## Decision

Build one small package with three public entry points:

```text
spaces-harness-scenarios
├── .                    semantic scenario model, deterministic ids/clock, compiler contract
├── ./codex-app-server   exact Codex app-server scripts and playback
└── ./broker             typed broker envelopes and durable read-surface fixtures
```

The package should let a test describe a conversation once, then choose the altitude at which the test begins:

1. **Provider altitude**: compile to exact Codex app-server JSON-RPC responses and notifications, feed those through the real Codex event mapper and event sequencer, and test the whole driver-to-renderer path.
2. **Broker altitude**: compile directly to validated `InvocationEventEnvelope` values and feed a controllable durable read surface, for focused renderer and replay tests.
3. **HRC altitude**: reuse the broker output as input to HRC's real `BrokerEventMapper`. ASP must not generate canonical HRC lifecycle events. HRC may keep a tiny HRC-owned event builder only for tests whose declared boundary begins after mapping.

Do not create three packages yet. There is one engine, one release cadence, and no dependency pressure that justifies more package boundaries. The subpath exports keep provider and broker dependencies out of the root API while preserving the option to split later.

## Why this is worth doing

The Codex app-server renderer is already tested against its correct source of truth: durable normalized broker events. The friction is fixture construction.

Today:

- `renderer.red.test.ts` manually supplies sequence numbers, timestamps, ids, event names, and payloads for long transcripts.
- The local `event(...)` helper casts payloads to `InvocationEventEnvelope`, so the event name and payload shape are not coupled.
- Renderer replay tests separately reconstruct `eventsSince` and `observe` behavior.
- Fake Codex app-server tests have useful low-level JSON-RPC helpers, but each scenario still hand-authors the notification sequence.
- HRC mapper fixtures have another local envelope builder and their own canonical sequence.

The repetition makes tests harder to read and allows two dangerous classes of false confidence:

1. A fixture can have an invalid payload while looking like an authoritative protocol event.
2. A direct normalized fixture can prove the renderer works while accidentally bypassing the native mapping behavior that the test meant to cover.

The helper should remove ceremony without hiding which production boundary a test traverses.

## What the shadcn helper gets right

The design was studied from the
[shadcn helper documentation](https://ui.shadcn.com/docs/helpers/ai-sdk) and
`shadcn-ui/ui` at commit
[`bc070538`](https://github.com/shadcn-ui/ui/tree/bc0705384b51252af26dcc65425b216bf5eb063c/packages/helpers).
Its useful mechanism is not the chat-specific surface; it is the layering:

1. a framework-neutral semantic event log;
2. deterministic id, metadata, and turn construction;
3. a lowering pass that converts semantic events into scheduled stream steps;
4. a thin target format that encodes those steps into the target protocol;
5. a transport/player that exercises the real client lifecycle.

That separation lets shadcn describe text, reasoning, tools, data, and timing once while emitting either AI SDK or TanStack AI events. It also keeps the core free of framework imports.

We should borrow that architecture, not copy its API wholesale. The following shadcn features are out of scope for v1 here:

- UI message hydration and transcript matching;
- fallback assistant turns;
- files, sources, and arbitrary UI data parts;
- a non-zero default delay;
- framework-specific client transports.

Our problem is an ordered protocol scenario, not a mock chat database.

## Canonical vocabulary

| Noun | Meaning | Owner |
| --- | --- | --- |
| **Scenario** | An immutable, ordered description of one interaction, independent of a target protocol. | `spaces-harness-scenarios` core |
| **Semantic step** | A user message, turn boundary, assistant message, generic tool call/result, usage snapshot, or explicit pause. | core |
| **Target extension** | An exact target-owned step that cannot be faithfully represented by the common vocabulary, such as a Codex plan notification. | target adapter |
| **Compiler** | A pure transform from a scenario to target frames plus a deterministic schedule. | target adapter |
| **Frame** | One exact target value: a Codex JSON-RPC response/notification or broker envelope. | target adapter |
| **Schedule** | Logical offsets between frames. Zero-delay is the default; wall-clock sleeping is injected. | core/player |
| **Player** | Sends compiled frames to a structural sink. It does not know the production mapper or renderer. | target adapter |
| **Projection** | A production transform from one altitude to another, such as Codex notification to broker event or broker event to HRC lifecycle event. | production package that owns the target model |
| **Read-surface fixture** | A controllable implementation of broker history plus live observation, including overlap and failure modes. | `./broker` |

“Scenario” is deliberately different from “event.” A scenario is author intent; an event is a protocol fact produced by a compiler or production projection.

## Boundary map

```text
                         semantic HarnessScenario
                         /                     \
                        /                       \
       ./codex-app-server compiler         ./broker compiler
                  |                              |
       exact JSON-RPC notifications        validated broker envelopes
                  |                              |
       real Codex event mapper             durable read-surface fixture
                  |                              |
       real event sequencer                         +--> Codex renderer
                  |
          durable broker ledger
                  |
           Codex renderer

validated broker envelopes
          |
          +--> real HRC BrokerEventMapper --> HRC lifecycle --> frame renderer
                                                  ^
                                                  |
                              HRC-owned builder ---+
                              (post-mapping unit tests only)
```

The direct broker compiler is a test convenience, not a substitute for the native path. Tests of Codex mapping must begin with exact native notifications. Tests of HRC mapping must begin with broker envelopes and traverse the real HRC mapper.

## Ownership and dependency rules

### Core

The root entry point may import only generic TypeScript utilities from within its package. It must not import:

- Codex app-server types;
- `spaces-harness-broker` implementation code;
- HRC packages or HRC vocabulary;
- a global adapter registry.

Core validates only scenario-local facts:

- referenced ids exist;
- ids are unique;
- an opened turn/message/tool has at most one terminal step;
- a terminal step cannot precede its start;
- schedule offsets are finite and non-negative;
- generation is deterministic for the same scenario and compile options.

Core must not claim that a scenario is a valid Codex, broker, or HRC lifecycle. That authority belongs to the target adapter and the real target validator.

### Codex app-server adapter

`./codex-app-server` owns:

- exact JSON-RPC request/response and notification shapes;
- Codex thread/turn/item ids used in compiled frames;
- native lifecycle ordering;
- a structural sink for request expectations, replies, and notifications;
- provider-native extension steps;
- validation against a checked-in, generated Codex protocol snapshot.

It must not import the production Codex-to-broker mapper. Integration tests import the adapter and the real mapper independently. This avoids a cycle and prevents a single implementation from manufacturing both the input and its expected projection.

### Broker adapter

`./broker` may depend on `spaces-harness-broker-protocol`, but not on `spaces-harness-broker`.

It owns:

- direct construction of type-coupled, runtime-validated broker envelopes;
- deterministic envelope metadata;
- a structural, in-memory durable read surface using the protocol's `invocation.eventsSince` request/response types;
- explicit replay/live controls and fault injection.

Its returned read surface should be structurally assignable to `RendererDurableReadSurface`; the renderer must not gain a production dependency on the test package.

### HRC

No `./hrc` export belongs in the ASP package.

HRC owns the meaning and lifecycle of `HrcEventEnvelope` and `HrcLifecycleEvent`. Reuse is achieved by feeding generated broker envelopes through HRC's real `BrokerEventMapper`, not by teaching ASP to predict HRC output. A tiny HRC-local builder remains appropriate for `hrc-frame-render` unit tests because those tests intentionally start after mapping.

This preserves the existing ASP → HRC dependency direction and keeps failures attributable to the right projection.

## Proposed public API

The exact spelling can be refined during implementation, but the public shape should remain this small.

### Root core

```ts
import { defineHarnessScenario } from 'spaces-harness-scenarios'

const scenario = defineHarnessScenario(({ user, turn, pause }) => {
  user.message('Run the checks')

  turn({ id: 'turn-1' }, ({ assistant, tool, usage }) => {
    assistant.message('I will run the checks.', {
      deltas: ['I will ', 'run the checks.'],
    })

    tool.call(
      {
        id: 'tool-1',
        name: 'test',
        input: { command: 'bun test' },
      },
      ({ progress, complete }) => {
        progress({ text: 'running' })
        complete({ result: { exitCode: 0, output: 'ok' }, durationMs: 25 })
      }
    )

    pause(10)
    usage.snapshot({ totalTokens: 1234 })
    assistant.message('All checks passed.', { final: true })
  })
})
```

Defaults are limited to ceremony:

- deterministic ids when an id is omitted;
- a fixed/injected start time and deterministic tick;
- start/delta/end frames implied by one semantic message or tool call;
- completed turn outcome unless explicitly failed or interrupted;
- zero delay unless `pause(...)` is present.

Content, tool inputs/results, usage, failure reasons, and provider-specific details must be explicit.

### Scenario-local lifecycle

This is a construction invariant, not a replacement for any target lifecycle:

| State | Allowed next steps | Terminal condition |
| --- | --- | --- |
| scenario open | user message, turn, pause, target extension | end of script |
| turn open | assistant message, tool call, usage, pause, target extension | completed, failed, or interrupted exactly once |
| assistant message open | ordered deltas | completed exactly once |
| tool call open | ordered progress | completed or failed exactly once |
| any terminal entity | none for that entity | further content is an error |

Target adapters may impose stronger ordering and required fields. They may not weaken these reference and terminal-integrity checks.

The core compiler contract is structural rather than registry-based:

```ts
export interface ScenarioCompiler<TFrame, TExtension = never> {
  compile(
    scenario: HarnessScenario<TExtension>,
    options: ScenarioCompileOptions
  ): CompiledScenario<TFrame>
}

export interface CompiledScenario<TFrame> {
  frames: ReadonlyArray<{ atMs: number; frame: TFrame }>
}
```

Compiled results are deep-cloned or deeply frozen at the boundary so one test cannot mutate the next playback.

### Exact Codex path

```ts
import {
  codexAppServerCompiler,
  codexNative,
  playCodexAppServerScenario,
} from 'spaces-harness-scenarios/codex-app-server'

const nativeScenario = scenario.extend(
  codexNative.notification({
    method: 'turn/plan/updated',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      explanation: null,
      plan: [{ step: 'Run tests', status: 'inProgress' }],
    },
  })
)

const script = codexAppServerCompiler.compile(nativeScenario, {
  seed: 'renderer-plan',
  thread: { mode: 'start', id: 'thread-1' },
  turnId: 'turn-1',
  startTime: '2026-01-01T00:00:00.000Z',
})

await playCodexAppServerScenario(script, fakeServerSink)
```

`codexNative.notification(...)` is the supported route for plan/diff updates, exact command/file/MCP/web item variants, unusual token-usage payloads, and mapper edge cases. It is schema checked. A separately named `unsafeCodexNotification(...)` may exist only for negative validator/robustness tests; it must be visually obvious at the call site and must not be accepted by the normal compiler.

The sink should be no larger than the fake app-server interaction requires:

```ts
interface CodexAppServerScenarioSink {
  expectRequest(method: string): Promise<JsonRpcRequest>
  reply(id: JsonRpcId, result: unknown): Promise<void>
  notify(notification: CodexNotification): Promise<void>
}
```

The existing fake Codex app server can supply an adapter for this structural sink without moving production mapper code into the new package.

### Direct broker path

```ts
import {
  brokerScenarioCompiler,
  createBrokerReadSurfaceFixture,
} from 'spaces-harness-scenarios/broker'

const compiled = brokerScenarioCompiler.compile(scenario, {
  invocationId: 'inv-renderer-1',
  seed: 'renderer-happy-path',
  startTime: '2026-01-01T00:00:00.000Z',
  prelude: 'ready',
})

const fixture = createBrokerReadSurfaceFixture(compiled.frames)
const projection = createCodexAppServerRendererProjection({
  invocationId: 'inv-renderer-1',
  readSurface: fixture.readSurface,
})

await projection.start()
fixture.emitNext()
```

The read-surface fixture needs explicit controls for the renderer's real failure modes:

- seed retained history;
- hold and release the `eventsSince` response;
- emit a live event during bootstrap;
- replay the same sequence number in history and live delivery;
- deliver live events out of order;
- set a retention floor;
- reject bootstrap with `EventReplayUnavailable` or an arbitrary error;
- close observation and assert no later delivery;
- advance a virtual schedule without relying on real sleeps.

These are controls on delivery, not new semantic scenario steps.

## Protocol hardening prerequisite

The new helper must not institutionalize the current type hole in `spaces-harness-broker-protocol`.

Today `InvocationEventEnvelope<TPayload>` carries an independent `type` and `payload`, and `validateEventEnvelope` uses a partial event-validator registry. That permits a fixture such as `type: 'assistant.message.completed'` with a non-matching payload to compile or pass validation.

Before the direct broker adapter is called “validated,” add a protocol-owned payload map:

```ts
export interface InvocationEventPayloadMap {
  'turn.started': TurnStartedPayload
  'assistant.message.started': AssistantMessageStartedPayload
  'assistant.message.delta': AssistantMessageDeltaPayload
  'assistant.message.completed': AssistantMessageCompletedPayload
  'tool.call.started': ToolCallStartedPayload
  // ...every InvocationEventType
}

export type InvocationEventType = keyof InvocationEventPayloadMap

export type InvocationEventEnvelope<
  K extends InvocationEventType = InvocationEventType,
> = {
  [P in K]: InvocationEventEnvelopeFor<P, InvocationEventPayloadMap[P]>
}[K]
```

Then make the runtime validator registry exhaustive rather than `Partial`. At minimum, every event emitted by the scenario compiler must have protocol-owned shape validation; the preferred implementation completes the registry for every event type so the public `validateEventEnvelope` name is truthful.

The scenario compiler calls that target validator for every output frame. It does not implement a parallel broker lifecycle validator in core.

## Codex protocol provenance

Exact native tests only stay useful if their types track the app-server protocol.

Codex app-server
[officially supports generating TypeScript definitions and JSON Schema](https://github.com/openai/codex/blob/d72d669ca727a26765315ffe03db3dd2594d9b91/codex-rs/app-server/README.md#generating-typescript-schema),
so add a refresh script that runs the installed, pinned Codex toolchain and writes a reviewed snapshot under the adapter, for example:

```text
packages/harness-scenarios/src/codex-app-server/generated/
├── types/
├── json-schema/
└── SOURCE.json
```

`SOURCE.json` records the `codex --version`, source commit when known, generation command, and timestamp. The refresh command must be deterministic and `git diff` is the protocol-upgrade review surface.

Do not silently reuse the existing `docs/codex-artifacts/json-schema` snapshot as a runtime contract: it is documentation-oriented and predates the current inspected Codex source. Implementation should either replace it with a single canonical generated location or clearly declare the package snapshot authoritative and the docs copy derived.

## What each test path proves

| Test intent | Fixture starts at | Production path that must run | Helper output |
| --- | --- | --- | --- |
| Transcript folding, wrapping, colors, redraw | broker envelope | renderer transcript/projection | direct broker compiler |
| Replay/live overlap, dedupe, retention failure | broker read surface | renderer projection | read-surface fixture |
| Codex assistant/tool/plan/diff mapping | native notification | real Codex event mapper + sequencer | Codex compiler/native extension |
| Fake app-server driver integration | JSON-RPC handshake | real driver + mapper + ledger | Codex script/player |
| Direct-vs-native semantic parity | semantic scenario | both compiler paths; native side uses real mapper/sequencer | both adapters |
| HRC broker mapping and persistence | broker envelope | real HRC `BrokerEventMapper` and store | direct broker compiler |
| HRC frame formatting only | HRC lifecycle event | frame renderer | HRC-owned local builder |
| HRC end-to-end projection | broker envelope | real HRC mapper then frame renderer | direct broker compiler |
| Real harness/provider behavior | real process | existing MATRIX/ghoste2e path | no scenario helper |

Tests must name their altitude. A renderer unit may not be presented as proof of Codex native mapping, and a frame-render unit may not be presented as proof of HRC projection.

## Required invariant tests

### Core

1. Same scenario, seed, ids, and start time produce byte-identical compiled frames.
2. Different seeds deterministically change generated ids without changing explicit ids.
3. Duplicate ids, dangling references, double terminals, terminal-before-start, negative delays, and post-terminal content fail with stable error codes.
4. Compiler output cannot be mutated through a previously returned object.
5. Abort before first frame emits nothing; abort during playback emits no invented terminal unless the target contract requires one.

### Broker adapter

1. Every emitted envelope passes the real protocol validator.
2. Compile-time fixtures prove event names select the correct payload shape.
3. Sequence numbers are monotonic per invocation and timestamps are deterministic.
4. Replay/live overlap is deduplicated by the real renderer while out-of-order live delivery is reconciled correctly.
5. Retention and bootstrap failures remain visible in rendered output.

### Codex adapter

1. Every safe native frame passes the generated Codex schema.
2. One canonical scenario lowered through Codex → real mapper → real sequencer and independently through the broker compiler produces semantically equivalent normalized events. Compare a documented common projection, not provider-only metadata.
3. Provider-specific mapper cases begin with exact native notifications, captured goldens, or safe native extension steps.
4. Generic tool parity uses one documented canonical Codex representation. Command execution, file changes, MCP, web search, image generation, plans, and diffs each get native golden coverage rather than relying on that generic representation.
5. An app-server handshake/turn script drives the existing fake server and reaches the real renderer through the ledger.

### HRC consumption

1. Generated broker envelopes traverse the real `BrokerEventMapper` into expected HRC lifecycle rows.
2. HRC-local lifecycle fixtures test frame rendering separately.
3. At least one integration test traverses generated broker envelope → real HRC mapper → frame renderer.

## Failure model

| Failure | Where represented | Expected behavior |
| --- | --- | --- |
| Scenario is internally inconsistent | core validation | deterministic construction/compile error |
| Safe Codex extension violates schema | Codex adapter | compile error before playback |
| Broker payload does not match event type | protocol validator | compile error before fixture exposure |
| Target cannot lower a semantic step | target adapter | explicit unsupported-step error; never drop silently |
| Playback is aborted | player | stop at the current frame; target-specific terminal only if declared |
| History is unavailable below retention floor | read-surface fixture | reject with the real error shape; renderer displays failure |
| Live event overlaps bootstrap history | read-surface fixture | deliver both; production renderer proves dedupe |
| Provider notification is unknown to mapper | native extension + real mapper | production diagnostic behavior is asserted |
| HRC mapping changes | real HRC mapper test | HRC expectation changes or fails; ASP compiler remains unchanged |

No adapter may silently return zero frames for an unsupported semantic step. Target-specific omission, if ever necessary, must be explicit in the scenario and test assertion.

## Package and repository integration

The implementation needs the normal publishable-package plumbing:

- `packages/harness-scenarios/package.json`, `tsconfig.json`, source, and tests;
- `prepack` stripping of `exports.*.bun`;
- root build, test, and typecheck ordering;
- boundary/import-graph registration;
- local Verdaccio publication and cross-repo pack smoke registration;
- public-surface/manifests checks;
- HRC's ASP package sync list and pinned dev dependency when HRC first consumes it.

`spaces-harness-scenarios` depends on `spaces-harness-broker-protocol`; it does not depend on `spaces-harness-broker`. `spaces-harness-broker` may take a dev dependency on the scenarios package for tests. If the workspace tooling treats that dev-only edge as a cycle, keep the integration tests at the repository root rather than reversing the production graph.

## Phased rollout

The rollout is tracked in the `agent-spaces/harness-scenario-helpers` wrkq feature container. Each task treats its linked phase section below as its implementation contract.

| Phase | Task | Depends on | Owned delivery | Exit gate |
| --- | --- | --- | --- | --- |
| 0 | `T-06393` | none | type-coupled broker envelopes and exhaustive runtime validation | protocol tests and repository contract checks pass |
| 1 | `T-06394` | `T-06393` | scenario core, direct broker compiler, durable read-surface fixture | representative renderer and replay/failure proofs pass |
| 2 | `T-06395` | `T-06394` | generated Codex protocol snapshot, native compiler/player, mapper parity | schema, native parity, and fake-server-to-renderer proofs pass |
| 3 | `T-06396` | `T-06395` | published package consumption through HRC's real mapper | broker-to-HRC-to-frame integration passes from the real HRC checkout |
| 4 | `T-06397` | `T-06396` | selective fixture migration and duplicate-helper cleanup | final cross-package/cross-repo matrix and real-surface smokes pass |

The phases are sequential by default. A phase is ready to start only after the preceding task records its exit evidence; task state alone is not sufficient. Each phase keeps its explicitly deferred work in the next phase rather than widening its package or ownership boundary.

### Phase 0 — Make broker fixtures authoritative

**Tracked task:** `T-06393` — `phase-0-broker-fixture-contract`

**Entry condition:** the approved proposal and current broker protocol behavior are the baseline; there is no earlier implementation dependency.

**Owned delivery:**

1. Introduce `InvocationEventPayloadMap` and migrate typed emitters.
2. Make payload validation exhaustive.
3. Add protocol tests proving type/payload coupling and runtime rejection.

**Exit gate:** incorrect event/payload pairs fail at compile time and runtime, every scenario-emittable broker event has protocol-owned validation, and the existing broker protocol/harness-broker contract checks pass. This phase is a prerequisite, not incidental cleanup.

### Phase 1 — Core and direct broker path

**Tracked task:** `T-06394` — `phase-1-core-broker-adapter`

**Entry condition:** `T-06393` is complete with its protocol validation evidence recorded.

**Owned delivery:**

1. Scaffold `spaces-harness-scenarios` with root and `./broker` exports.
2. Implement the immutable scenario model, deterministic id/clock, validation, and schedule.
3. Implement the semantic-to-broker compiler.
4. Implement the durable read-surface fixture.
5. Convert a representative renderer happy path, a replay/live race, and a retention failure. Keep some low-level tests to prove raw handling.

**Exit gate:** the representative renderer scenario removes manual envelope ceremony, every compiled broker frame passes the real validator, deterministic/failure invariants pass, and replay/live/retention behavior is proven through the production renderer projection. This is the first usable package milestone.

### Phase 2 — Exact Codex path

**Tracked task:** `T-06395` — `phase-2-codex-app-server-adapter`

**Entry condition:** `T-06394` is complete and the package's root/broker API is stable enough to consume without redesign.

**Owned delivery:**

1. Add generated Codex protocol snapshot and refresh/check commands.
2. Implement semantic lowering for user, turn, assistant, one canonical generic tool representation, usage, and terminal outcomes.
3. Add safe native extensions and separately branded unsafe negative fixtures.
4. Add the structural app-server sink/player and adapt the existing fake server.
5. Add native-to-broker parity and provider-specific golden tests.

**Exit gate:** every safe native frame passes the generated schema, the canonical scenario is semantically equivalent through native and direct broker paths, provider-specific cases begin with exact native input, and a fake app-server handshake reaches the renderer through the production mapper, sequencer, and ledger.

### Phase 3 — HRC consumption

**Tracked task:** `T-06396` — `phase-3-hrc-consumption`

**Entry condition:** `T-06395` is complete and the full package is available through the normal Verdaccio development publication flow.

**Owned delivery:**

1. Publish the package through the existing Verdaccio dev flow.
2. Add it as an HRC test-only dependency.
3. Replace one HRC mapper fixture with a generated broker scenario.
4. Add the required broker → real mapper → frame renderer integration proof.
5. Keep HRC-local post-mapping builders small and explicitly named by altitude.

**Exit gate:** the published package is installed in the real HRC checkout, generated broker events traverse the real `BrokerEventMapper` into persisted lifecycle rows and the frame renderer, and ASP boundary checks prove no HRC vocabulary or dependency leaked into the package.

### Phase 4 — Selective migration

**Tracked task:** `T-06397` — `phase-4-selective-migration`

**Entry condition:** `T-06396` is complete, so all supported fixture altitudes have a proven production-path integration.

**Owned delivery:**

1. Inventory duplicated builders in the affected ASP and HRC tests.
2. Convert fixtures when the helper makes intent and proof altitude clearer.
3. Remove only helpers whose consumers were migrated or deliberately replaced.
4. Retain explicit raw events for protocol validators, unknown-event behavior, malformed input, exact edge ordering, and regression goldens.
5. Run the final cross-package and cross-repo verification matrix and required real-surface smokes.

**Exit gate:** remaining tests declare their altitude accurately, intentionally raw coverage is documented, removed helpers have no consumers, and the proposal's complete acceptance criteria are proven. This phase is selective cleanup, not a mandate to convert every fixture.

## Acceptance criteria

The proposal is implemented when:

1. A renderer scenario containing user text, assistant deltas, a tool lifecycle, usage, and a terminal turn is expressed without hand-authored seq/time/envelope boilerplate.
2. The same semantic scenario passes the required direct-vs-native equivalence test through the real Codex mapper and sequencer.
3. Every safe Codex frame and every broker envelope is checked by its target-owned runtime validator.
4. Renderer replay/live race and retention-failure tests use controllable fixture behavior rather than ad hoc promises and arrays.
5. HRC consumes broker output through its real mapper; no HRC type or lifecycle noun appears in the ASP package.
6. Package boundary, typecheck, unit, pack, and cross-repo smoke checks pass.
7. The installed/published package is smoke-tested from HRC through the normal Verdaccio sync path before any implementation task is marked complete.

## Risks and countermeasures

### The DSL becomes another protocol

Keep the semantic vocabulary deliberately small. New provider features enter as target extensions first. Promote a concept to core only after two target adapters share its meaning.

### Direct broker fixtures hide mapper defects

Require each test to declare its altitude and maintain the native parity suite. Mapping tests begin with exact native frames.

### Generated Codex types drift

Generate from the official app-server tool, record provenance, check in the snapshot, and review diffs as part of Codex upgrades.

### Runtime validation gives false assurance

Remove the partial validator registry and require every scenario-emittable event to have a target-owned validator before release.

### HRC ownership leaks downward

Ship no HRC subpath or vocabulary. Use generated broker events as HRC input and keep HRC output construction local to HRC.

### Timing tests become slow or flaky

Compile logical offsets and inject scheduling. Default to zero-delay or virtual time; use real sleeps only in deliberate transport integration tests.

### A fluent API obscures exact order

Expose `compiled.frames` as a stable inspection surface and keep explicit frame/native-extension helpers. The writer is syntax sugar over an ordered log, not an opaque simulator.

## Non-goals

- replacing the real harness-broker MATRIX or ghostmux end-to-end tests;
- mocking Codex itself as proof of provider behavior;
- generating expected HRC projections inside ASP;
- simulating HRC storage, lease, or recovery semantics in the shared core;
- supporting every Codex notification in the semantic DSL;
- snapshotting rendered ANSI output as the only assertion;
- building a generic plugin registry or test framework.

## Final recommendation

Proceed with one `spaces-harness-scenarios` package and implement it in the order above. The highest-value first slice is not the fluent writer; it is the combination of type-coupled broker envelopes, exhaustive runtime validation, and a deterministic read-surface fixture. Once that foundation is trustworthy, add the exact Codex compiler and prove parity through the real mapper. HRC then gets reuse at the correct boundary simply by consuming broker envelopes through its own production projection.

That yields the shadcn-style ergonomics we want while preserving Praesidium's more important property: every test makes clear which abstraction boundary it actually proved.
