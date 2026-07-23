---
id: agent-spaces/identity-scope-and-env-contract
title: Identity, Scope, and Environment Contract
kind: reference
authority: descriptive
status: active
visibility: internal
provenance: authored
---

# Identity, Scope, and Environment Contract

ASP owns the canonical agent identity vocabulary (the `agent-scope`
package) and the Agent-Session environment-variable contract that carries
that identity into every launched agent process. Both are consumed across
repo boundaries (HRC, ACP, wrkq/wrkf tooling), so they are documented here
as a stable seam rather than an implementation detail.

## `agent-scope`: the identity vocabulary

`packages/agent-scope` defines four related types. It is intentionally
standalone in the package graph (not layered under `spaces-config`)
because scope/session identity is a semantic seam used by every layer, not
just a CLI convenience.

### `ScopeRef` — canonical durable address

```text
agent:alice
agent:alice:project:demo
agent:alice:project:demo:task:T-1
agent:alice:project:demo:task:T-1:role:reviewer
```

The unambiguous, durable form used whenever the system needs a stable
identity (ownership logic, storage keys, cross-repo correlation).

### `ScopeHandle` — human-friendly shorthand

```text
alice
alice@demo
alice@demo:T-1
alice@demo:T-1/reviewer
```

Same scope, UI/CLI-friendly form. `asp agent <scope> <mode>` accepts either
a `ScopeHandle` or a canonical `ScopeRef`.

### `SessionRef` — scope plus lane

```ts
type SessionRef = {
  scopeRef: string
  laneRef: 'main' | `lane:${string}`
}
```

Combines a canonical scope with a lane; normalization defaults an omitted
lane to `main`.

### `SessionHandle` — human shorthand for `SessionRef`

```text
alice@demo:T-1/reviewer
alice@demo:T-1/reviewer~planning
```

`~main` is elided — `alice@demo:T-1/reviewer` is already a complete session
handle for the main lane.

## Correlation fields

The canonical host correlation field is `hostSessionId`. `cpSessionId` is a
deprecated compatibility input only and should not be presented as the
primary field in new public docs or APIs. `hostSessionId` is canonical in
`BaseEvent` and request types; `RunEventEmitter`/`RunEvent` have been
removed from the public surface.

The continuation term is `continuationKey`
(`HarnessContinuationKey`/`HarnessContinuationRef`,
`SessionMetadataSnapshot.continuationKey`) — not `resume`. `--resume`
remains a user-facing CLI flag on `asp run` because it is harness UX
vocabulary; the cross-package runtime contract stays `continuationKey`.
Codex maps it to `resumeThreadId` internally.

## Agent-Session environment contract

Owner/producer: agent-spaces placement/materialization. Writer: the
canonical agent-session env builder in `packages/agent-spaces`
(`agent-session-env.ts`, `buildCorrelationEnvVars`). Readers: agent
processes, HRC launch paths, hrcchat, hooks, wrkq/wrkf tooling. Every
launched agent process receives these variables so that its own actions
(e.g. wrkq writes) are attributable back to the launching identity.

| Variable | Format | Legacy fallback |
| --- | --- | --- |
| `AGENT_SCOPE_REF` | Canonical durable scope identity, e.g. `agent:cody:project:agent-spaces:task:T-04218` | `ASP_SCOPE_REF` / handle-derived identity during migration |
| `AGENT_ID` | Bare agent id, e.g. `cody` | `AGENTCHAT_ID` during migration |
| `AGENT_PROJECT` | Project id, e.g. `agent-spaces` | `ASP_PROJECT` during migration |
| `AGENT_TASK` | Task id when task scoped, e.g. `T-04218` | none |
| `AGENT_LANE` | Bare lane id, default `main` | `AGENT_LANE_REF` during migration |
| `AGENT_SESSION_REF` | Lane-aware session identity, `<scopeRef>/lane:<lane>` | `HRC_SESSION_REF` during migration |
| `AGENT_RUN_ID` | Per-launch run id | `HRC_RUN_ID` during migration |
| `AGENT_HOST_SESSION_ID` | Host session id | `HRC_HOST_SESSION_ID` during migration |
| `AGENT_PROJECT_ROOT` | Absolute project root path | `ASP_PROJECT_ROOT` during migration |
| `AGENT_ACTOR` | Bare actor slug for task writes | legacy `WRKQ_ACTOR` alias is killed; wrkq now reads `WRKQ_PRINCIPAL_REF` |

`AGENT_SCOPE_REF` and `AGENT_SESSION_REF` are both canonical but name
different concepts: use `AGENT_SCOPE_REF` for durable identity/ownership
logic, `AGENT_SESSION_REF` only when lane-aware session routing or
correlation matters.

wrkq caller attribution is principal-only: sessions emit
`WRKQ_PRINCIPAL_REF=agent:<AGENT_ACTOR>` as the canonical wrkq principal
env var; the bare-slug `WRKQ_ACTOR` alias is no longer accepted by wrkq for
attribution.

## ASP-owned config vars

| Variable | Format | Legacy fallback |
| --- | --- | --- |
| `ASP_HOME` | absolute path | replaces `ASP_ROOT_DIR` |
| `ASP_AGENTS_ROOT` | absolute path | canonical (see `agent-spaces/materialization-install-flow`) |
| `ASP_PI_PATH` | absolute path | replaces `PI_PATH` (Pi harness) |
| `ASP_PROJECT` | project id | migration-only; replaced by `AGENT_PROJECT` for agent sessions |

## What ASP does not own

ASP is not the task store (wrkq owns tasks/containers/handoffs/comments;
ASP only writes `AGENT_ACTOR`/`WRKQ_PRINCIPAL_REF` for attribution — ASP
code does not call wrkq), not the workflow engine (wrkf), not HRC's target
lifecycle or tmux pane ownership, not the external gateway (ACP), and not
the agent persona content itself (personas live under
`~/praesidium/var/agents`; ASP only materializes/overlays them — see
`agent-spaces/materialization-install-flow`). The repo boundary rule (`bun run check:boundaries`) enforces the import side of this: ASP source must
not import `hrc-*`, `acp-*`, `gateway-*`, `coordination-substrate`,
`wrkq-lib`, or `wlearn`.
