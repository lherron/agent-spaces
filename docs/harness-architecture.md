---
id: agent-spaces/harness-architecture
title: Harness Architecture
kind: reference
authority: descriptive
status: active
visibility: internal
provenance: authored
---

# Harness Architecture

Agent Spaces is layered into a deterministic config/materialization layer,
a harness-agnostic runtime layer, a run-time execution layer,
harness-specific adapters, and a public host-facing API. HRC (target
lifecycle, run monitoring, tmux pane ownership) is a neighbor system, not
implemented here.

## Package layering

```text
asp-targets.toml / agent-profile.toml / local spaces
        |
        v
  spaces-config      (packages/config)
  - parse manifests, resolve refs/closures
  - compute lock + integrity
  - materialize per-space artifacts / target bundles
        |
        v
  spaces-runtime      (packages/runtime)
  - harness registry contracts
  - UnifiedSession / UnifiedSessionEvent
        |
        v
  spaces-execution     (packages/execution)
  - run-time orchestration
  - harness adapter dispatch
  - run/build/install wrappers
        |
        v
  spaces-harness-*      (packages/harness-claude, -codex, -pi, -pi-sdk)
  - Claude / Codex / Pi / Pi SDK specifics
        |
        v
  agent-spaces + asp CLI     (packages/agent-spaces, packages/cli)
  - host-facing request/response API
  - placement-driven execution
  - AgentEvent translation
```

`git`, `resolver`, `store`, `materializer`, `lint`, and `core` are not
standalone workspace packages — they are sub-exports inside `spaces-config`
(e.g. `spaces-config/resolver`, `spaces-config/materializer`).

`agent-scope` (packages/agent-scope) sits outside this chain as a
standalone identity package, since scope/session addressing is a semantic
seam consumed by every layer, not just a CLI convenience — see
`agent-spaces/identity-scope-and-env-contract`.

Dependency shape: `agent-scope → spaces-config → spaces-runtime → spaces-execution → {spaces-harness-claude, -codex, -pi, -pi-sdk} → agent-spaces → cli`.

## Runtime contract: `UnifiedSession` / `UnifiedSessionEvent`

`spaces-runtime/session` defines the harness-agnostic contract every
harness adapter implements against. `UnifiedSessionEvent` is the granular
event stream: `agent_start`, `agent_end`, `turn_start`, `turn_end`,
`message_start`, `message_update`, `message_end`, `tool_execution_start`,
`tool_execution_update`, `tool_execution_end`, `sdk_session_id`. This is the
canonical run-time event model.

`packages/agent-spaces/src/session-events.ts` translates that granular
stream into the coarser public `AgentEvent` contract (`state`, `message`,
`message_delta`, `tool_call`, `tool_result`, `log`, `complete`). `AgentEvent`
is the stable host-facing surface; it is not a competing replay model.

Some harness paths can additionally emit JSONL artifacts to an artifact
directory for observability/debugging. That output is optional telemetry —
not the event contract, not a stable replay API, and not a substitute for
`UnifiedSessionEvent` or `AgentEvent`.

## Continuation contract

The cross-package continuation term is `continuationKey` (types
`HarnessContinuationKey`, `HarnessContinuationRef`,
`SessionMetadataSnapshot.continuationKey`). User-facing CLI flags still use
`--resume` because it is harness UX vocabulary; internally the runtime
contract stays `continuationKey`. Codex maps `continuationKey` into
`resumeThreadId` in its session layer. Claude adapters may still pass
resume-specific provider flags internally, but the cross-package contract
name is `continuationKey`.

## Harness adapters

Provider-specific packages translate the shared runtime/execution
contracts into concrete invocation and session behavior. They sit
downstream of `spaces-runtime` and `spaces-execution`, not as peers of
`spaces-config`:

- `spaces-harness-claude` (`packages/harness-claude`) — Claude CLI + Agent
  SDK adapters. Default harness (`--harness claude`).
- `spaces-harness-codex` (`packages/harness-codex`) — Codex CLI /
  app-server adapter. Experimental (`--harness codex`).
- `spaces-harness-pi` (`packages/harness-pi`) — Pi CLI adapter
  (`--harness pi`; env `PI_CODING_AGENT_DIR`, flags `--no-extensions`,
  `--no-skills`, hooks-scripts — see `packages/harness-pi/AGENTS.md`).
- `spaces-harness-pi-sdk` (`packages/harness-pi-sdk`) — Pi SDK adapter and
  session runtime (`--harness pi-sdk`; models as `provider:model`, extension
  imports happen inside the runner so extensions must be dependency-free or
  depend on packages available to the harness runtime).

## Harness Broker

`spaces-harness-broker` (`packages/harness-broker`, `bin: harness-broker`)
is a long-lived process exposing a JSON-RPC NDJSON protocol over `stdio` or
a unix socket (`harness-broker run --transport stdio` or `--transport unix --socket <path>`; advertised transports `stdio-jsonrpc-ndjson`,
`unix-jsonrpc-ndjson`). It manages invocations through pluggable drivers
under `packages/harness-broker/src/drivers/`:

- `claude-code-tmux`
- `codex-app-server`
- `codex-cli-tmux`
- `pi-tui-tmux`
- `noop`

The broker emits a normalized event vocabulary
(`invocation.started`/`invocation.ready`, `turn.completed`,
`assistant.message.completed{final}`, permission events) consumed by broker
clients such as HRC, and supports structured output, mid-turn input
queueing, and continuation/resume. Protocol types live in
`spaces-harness-broker-protocol` (`packages/harness-broker-protocol`); a
typed client lives in `spaces-harness-broker-client`
(`packages/harness-broker-client`). Unix-socket paths are budget-checked
against the `sockaddr_un` limit (104 bytes macOS / 108 bytes Linux) before
bind (`packages/harness-broker/src/socket-path.ts`).

**Boundary with HRC:** the `claude-code-tmux` driver *consumes* a leased
tmux pane whose ownership is `'hrc'` — it never constructs or owns a tmux
server. HRC drives the broker and owns run lifecycle (target vs. run state,
zombie/failed reconciliation, `turn.reaped`); the broker only executes
invocations against a pane it was handed
(`packages/harness-broker/src/drivers/claude-code-tmux/driver.ts`).

Any harness-broker change requires the MATRIX smoke (`bun run smoke:matrix`, or a single row via `--config <name>`), run from a real
terminal via `ghostmux` (see this repo's `AGENTS.md` and
`packages/harness-broker/AGENTS.md`) — running it inline inside a Claude
Code session leaks `CLAUDECODE`/`CLAUDE_CODE_SESSION_ID`/
`CLAUDE_CODE_CHILD_SESSION` into the child `claude` process, producing
false negatives in transcript-tailing smoke rows.

## ASPC compiler

`spaces-aspc` (`packages/aspc`, `bin: aspc`, `aspc-facade`) is a JSON-RPC
service that compiles a `CompiledRuntimePlan` and harness invocation.
Methods: `aspc.compileRuntimePlan`, `aspc.compileHarnessInvocation`,
`aspc.compileAndStart` (`packages/aspc/src/facade.ts`). It also serves as a
broker facade, forwarding broker methods over the same JSON-RPC surface.
Protocol types live in `spaces-aspc-protocol` (`packages/aspc-protocol`).

## Repo boundary rule

ASP source must not import `hrc-*`, `acp-*`, `gateway-*`,
`coordination-substrate`, `wrkq-lib`, or `wlearn` (enforced by `bun run check:boundaries`). ASP integrates with sibling repos through env,
protocol, and start-request inputs — never by importing them. The 10
cross-repo publishable boundary packages (`agent-scope`, `cli-kit`,
`spaces-config`, `spaces-runtime`, `spaces-runtime-contracts`,
`spaces-execution`, `spaces-harness-{claude,codex,pi,pi-sdk}`,
`spaces-harness-broker-protocol`/`-client`, `spaces-aspc-protocol`,
`agent-spaces`) each carry a `prepack` step that strips `exports.*.bun`
from the published manifest so Bun consumers in the HRC/ACP repos resolve
`dist/*.js` rather than unshipped `src/`.
