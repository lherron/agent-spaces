# Architecture

Agent Spaces is currently split into a deterministic config/materialization layer, a harness-agnostic runtime layer, a run-time execution layer, harness-specific adapters, and a public host-facing API. This document describes the current post-cleanup, pre-HRC architecture only.

HRC is not documented here as implemented behavior.

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
  spaces-runtime
  - harness registry contracts
  - UnifiedSession / UnifiedSessionEvent
        |
        v
  spaces-execution
  - run-time orchestration
  - harness adapter dispatch
  - run/build/install wrappers
        |
        v
  spaces-harness-*
  - Claude / Codex / Pi / Pi SDK specifics
        |
        v
  agent-spaces + asp CLI
  - host-facing request/response API
  - placement-driven execution
  - AgentEvent translation
```

## Package Boundaries

```text
packages/
├── agent-scope/      # Canonical semantic addressing: scope/session refs and handles
├── config/           # spaces-config
├── runtime/          # spaces-runtime
├── execution/        # spaces-execution
├── harness-claude/   # Claude CLI + Agent SDK harness
├── harness-codex/    # Codex CLI/app-server harness
├── harness-pi/       # Pi CLI harness
├── harness-pi-sdk/   # Pi SDK harness
├── agent-spaces/     # Public host-facing API + event translation
└── cli/              # asp command line interface
```

Important correction: `git`, `resolver`, `store`, `materializer`, `lint`, and `core` are not standalone workspace packages anymore. They are sub-exports inside `spaces-config`.

### Dependency Shape

```text
agent-scope
    |
    v
spaces-config
    |
    v
spaces-runtime
    |
    v
spaces-execution
    |
    +--> spaces-harness-claude
    +--> spaces-harness-codex
    +--> spaces-harness-pi
    +--> spaces-harness-pi-sdk
    |
    v
agent-spaces
    |
    v
cli
```

More precisely:

- `spaces-config` owns config-time determinism: parsing, schemas, refs, closure resolution, locks, store paths, and artifact materialization.
- `spaces-runtime` owns harness-agnostic runtime primitives: harness registration plus the `UnifiedSession` / `UnifiedSessionEvent` contract.
- `spaces-execution` owns volatile run-time orchestration: install/build/run wrappers, harness lookup, and session launch plumbing.
- `spaces-harness-*` packages own provider/frontend-specific behavior.
- `agent-spaces` owns the public host-facing API, placement entrypoints, and the translation from runtime session events to stable host events.
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

This is the canonical run-time event model.

### `AgentEvent`

`agent-spaces` exposes `AgentEvent` as the public host-facing event API. It is intentionally coarser than `UnifiedSessionEvent`.

Examples:

- `state`
- `message`
- `message_delta`
- `tool_call`
- `tool_result`
- `log`
- `complete`

`packages/agent-spaces/src/session-events.ts` translates the granular runtime stream into this public contract. `AgentEvent` is not a competing replay model and should not be described as one.

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

The canonical host correlation field is `hostSessionId`.

- `cpSessionId` remains deprecated compatibility input only.
- New public docs should not present `cpSessionId` as the primary field.

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
7. Compose target bundles under `asp_modules/`.
8. Hand the bundle to the selected execution/harness layer.

The deterministic parts of steps 1-7 live in `spaces-config`. Step 8 and session lifecycle handling live in `spaces-execution` and the harness packages.

## Harness Adapters

Current harness packages:

- `spaces-harness-claude`
- `spaces-harness-codex`
- `spaces-harness-pi`
- `spaces-harness-pi-sdk`

These packages translate the shared runtime/execution contracts into provider-specific invocation and session behavior. They are intentionally downstream of `spaces-runtime` and `spaces-execution`, not peers of `spaces-config`.

## CLI Surface

`packages/cli` is the top-level distribution package and exposes:

- classic target-oriented commands such as `run`, `install`, `build`, `describe`, `explain`, `lint`, `list`, and `doctor`
- registry commands under `asp repo`
- space authoring commands under `asp spaces`
- placement-driven execution through `asp agent`

See `docs/cli-reference.md` for the current command surface.
