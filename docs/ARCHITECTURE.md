# Architecture

Agent Spaces separates deterministic config/materialization, compiler selection,
runtime helpers, execution drivers, and process hosts. This overview describes
the ASP side of the current boundary; [the architecture brief](architecture-brief.md)
covers the end-to-end flow and [architecture records](../architecture/README.md)
own the normative contracts. HRC is a neighboring runtime consumer.

## System Overview

```text
asp-targets.toml / agent-profile.toml / local spaces
        |
        v
  spaces-config
  - parse manifests
  - resolve refs and closures
  - compute lock + integrity
  - materialize per-space artifacts / target bundles
        |
        v
  agent-spaces compiler
  - harness catalog and selection
  - compileRuntimePlan / frozen dispatch request
        |
        v
  injected runtime / harness hosts
  - driver preparation and materialization
  - aspd compile RPC / harness-broker dispatch
        |
        v
  HRC (managed) or asp CLI (foreground)
  - lifecycle and dispatch / foreground launch
```

## Package Boundaries

```text
contracts/agent-scope/       # Canonical scope/session refs and handles
contracts/aspc-protocol/     # Public compile RPC contract
contracts/harness-broker-*/  # Broker protocol and client
contracts/spaces-runtime-contracts/ # Runtime plan and selection contracts
core/config/                # spaces-config: parse, resolve, materialize
core/runtime/               # spaces-runtime: prompts and session helpers
drivers/execution/          # spaces-execution: foreground execution/preparation
drivers/harness-*/          # Claude, Codex, Muse, retained Pi implementations
compiler/agent-spaces/      # agent-spaces: catalog and compiler client
harness/aspc*/              # Compile service and facade
harness/harness-broker/     # Process host and event capture
harness/agent-harness*/     # Native agent-harness and runtime
apps/cli/                   # @lherron/agent-spaces: asp CLI
```

Important correction: `git`, `resolver`, `store`, `materializer`, `lint`, and `core` are not standalone workspace packages anymore. They are sub-exports inside `spaces-config`.

### Dependency Shape

Imports point inward through `apps → harness → compiler → drivers → core → contracts`,
with a stricter compiler rule: `compiler/` cannot import `drivers/`.
The CLI and ASPC inject the implementation runtime through
`AgentSpacesClientOptions.runtime`; the compiler does not select an adapter by
importing its implementation. `scripts/lib/import-graph.ts` enforces these layers.

More precisely:

- `spaces-config` owns config-time determinism: parsing, schemas, refs, closure resolution, locks, store paths, and artifact materialization.
- `spaces-runtime` owns runtime helpers, prompt construction, and retained `UnifiedSession` / `UnifiedSessionEvent` contracts.
- `spaces-execution` owns volatile run-time orchestration: install/build/run wrappers, harness lookup, and session launch plumbing.
- `spaces-harness-*` packages own provider/frontend-specific behavior.
- `agent-spaces` owns the harness catalog, runtime-plan compiler, inspection, and process/broker invocation preparation. Its client prepares execution rather than running managed turns.
- `agent-scope` is intentionally standalone because scope/session identity is used as a semantic seam, not just as a CLI convenience.

## Identity Seams

`agent-scope` defines the canonical addressing vocabulary.

### `ScopeRef`

Canonical address string. Examples:

- `agent:alice`
- `agent:alice:project:demo`
- `agent:alice:project:demo:task:T-1`
- `agent:alice:project:demo:task:T-1:role:reviewer`

This is the durable form used when the system needs an unambiguous identity.

### `ScopeHandle`

Human-friendly shorthand for the same scope:

- `alice`
- `alice@demo`
- `alice@demo:T-1`
- `alice@demo:T-1/reviewer`

`ScopeHandle` is a UI/CLI shorthand. `ScopeRef` is canonical.

### `SessionRef`

Structured session identity:

```ts
type SessionRef = {
  scopeRef: string
  laneRef: 'main' | `lane:${string}`
}
```

`SessionRef` combines a canonical scope with a lane. If no lane is provided, normalization defaults to `main`.

### `SessionHandle`

Human shorthand for `SessionRef`:

- `alice@demo:T-1/reviewer`
- `alice@demo:T-1/reviewer~planning`

`~main` is elided, so the first example is still a full session handle.

## Config-Time Determinism

`spaces-config` is the source of truth for the deterministic part of the system.

It owns:

- manifest parsing for `space.toml`, `asp-targets.toml`, and agent profile/config files
- ref parsing such as `space:<id>@<selector>`
- selector resolution against git tags and dist-tags
- dependency closure and load order
- integrity hashes and lock file generation
- snapshot/store management
- per-space artifact materialization and target bundle assembly

Representative sub-exports:

- `spaces-config/core`
- `spaces-config/git`
- `spaces-config/resolver`
- `spaces-config/store`
- `spaces-config/materializer`
- `spaces-config/lint`

## Space Sources and Locality

A space ref carries both an identity and a source locality. Four lock-entry kinds exist (`core/config/src/resolver/space-classification.ts`):

| Kind | Ref form | Source | Lock commit marker |
| --- | --- | --- | --- |
| registry | `space:<id>@<selector>` | content-addressed store, resolved from git tag / dist-tag / sha | real git sha |
| dev | `space:<id>@dev` | registry working directory | `dev` |
| project | `space:project:<id>[@dev]` | `<projectRoot>/spaces/<id>/` | `project` |
| agent | `space:agent:<id>[@dev]` | `<agentRoot>/spaces/<id>/` | `agent` |

Project- and agent-local spaces use the same `space.toml` schema and directory layout as registry spaces. They are read directly from the filesystem (no git resolution); only `@dev` is meaningful as a selector. Integrity is computed from directory content, and the lock entry records the marker commit plus a relative `path` (`spaces/<id>`) — see `closure.ts` and `integrity.ts`.

`space:path:<path>@dev` also supports explicit local directories. Shared `@dev`
spaces now default to `<agentsRoot>/spaces/<id>/`. Git-backed publication and
dist-tag commands are retired; registry entries describe retained pinned locks,
not the recommended authoring workflow.

### Dependency Edge Rules

Locality constrains which spaces may depend on which (`closure.ts`, enforced at closure time). Disallowed edges:

- registry → agent
- registry → project
- agent → project
- project → agent

Registry spaces must stay standalone (no dependency on local spaces). Local spaces may depend on registry spaces and on same-locality local spaces (project → project, agent → agent). Violations throw at resolution with a `Disallowed dependency edge` error.

## Runtime and Execution

### `UnifiedSession` and `UnifiedSessionEvent`

`spaces-runtime/session` defines the harness-agnostic runtime contract used by harness implementations.

`UnifiedSessionEvent` is the granular event stream. It includes events such as:

- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `sdk_session_id`

This remains the retained adapter session model. Managed execution uses the
broker protocol's invocation event envelopes, not a stream from the compiler client.

### `AgentEvent`

`agent-spaces` still exports the coarser `AgentEvent` type in
`compiler/agent-spaces/src/types.ts`.

Examples:

- `state`
- `message`
- `message_delta`
- `tool_call`
- `tool_result`
- `log`
- `complete`

The old `session-events.ts` translator and in-process turn-running client methods
are gone. Exporting the retained type does not provide a compiler event stream.
Current managed reads use `spaces-harness-broker-protocol` and its durable
event sequence; `AgentEvent` is not a competing replay model.

### JSONL Artifacts Are Telemetry

Some harness paths can emit JSONL artifacts to an artifact directory for observability/debugging. That output is optional telemetry.

It is not the main event contract, not a stable replay API, and not a substitute for `UnifiedSessionEvent` or `AgentEvent`.

## Continuation Contract

The current continuation term is `continuationKey`.

Relevant types:

- `HarnessContinuationKey`
- `HarnessContinuationRef`
- `SessionMetadataSnapshot.continuationKey`

Important distinctions:

- Public/runtime docs should say `continuationKey`, not `resume`.
- Some user-facing CLI flags still use `--resume` because they are harness UX flags.
- Codex maps `continuationKey` into `resumeThreadId` in the Codex session layer.
- Claude adapters may still pass resume-specific provider flags internally, but the cross-package contract is `continuationKey`.

## Correlation and Compatibility Surfaces

The canonical host correlation field is `hostSessionId`. The exported
`BaseEvent` and current host-correlation types use it; `cpSessionId` is not a
field on those contracts.

Cleanup already reflected in the current public seam:

- `hostSessionId` is canonical in `BaseEvent` and request types.
- `RunEventEmitter` and `RunEvent` have been removed from the public surface.
- dead session/harness barrel exports were removed from the public API path.

## Resolution and Materialization Flow

High-level flow:

1. Parse project/agent manifests and space refs.
2. Resolve selectors to exact commits.
3. Compute dependency closure and load order.
4. Generate/update `asp-lock.json`.
5. Snapshot resolved space content into the content-addressed store.
6. Materialize harness-specific space artifacts.
7. Compose external-harness bundles under the content-addressed `ASP_HOME` layout.
8. Return a frozen dispatch plan for managed execution, or launch through the
   foreground CLI. The native agent-harness route loads sources directly rather
   than materializing a compatibility bundle.

The resolution/materialization machinery lives in `spaces-config`; the compiler
selects the recipe and uses the injected runtime to prepare its artifacts. The
foreground `spaces-execution` path launches locally; managed lifecycle belongs to HRC.

## HRC boundary

HRC is a neighboring consumer, not an ASP implementation layer.
For ordinary v2 compilation, Agent Spaces selects the harness recipe and emits
one frozen execution plus its one canonical dispatch start request. HRC retains
placement, authorization, resource allocation, terminal leases, lifecycle,
messaging, continuation, credentials, and reattachment. Migrating HRC callers,
prepared state, or live state to v2 is outside this ASP-only cutover.

The ordinary public RPC is `aspc.compileHarnessInvocation`, with
`agent-runtime-compile-request/v2` input and one
`execution.dispatchRequest.startRequest` on success. See
[harness architecture](harness-architecture.md) for current selection and
[aspd](aspd.md) for namespaced service operation.

## Retained implementation packages

These packages are retained implementation layers, not public selectable
harness identities. The active selection vocabulary is solely
`agent-harness`, `claude`, `codex`, and `muse`; the compiler catalog decides
which retained implementation a resolved recipe uses.

- `spaces-harness-claude`
- `spaces-harness-codex`
- `spaces-harness-muse`
- `spaces-harness-pi`
- `spaces-harness-pi-sdk`

These implementations materialize provider-specific artifacts and prepare
invocations through the driver plane. They do not expand the public harness
selection vocabulary.

## CLI Surface

`apps/cli` is the top-level distribution package and exposes:

- classic target-oriented commands such as `run`, `install`, `build`, `describe`, `explain`, `lint`, `list`, and `doctor`
- shared spaces root commands under `asp repo`
- space authoring commands under `asp spaces`
- placement-driven execution through `asp agent`

See `docs/cli-reference.md` for the current command surface.
