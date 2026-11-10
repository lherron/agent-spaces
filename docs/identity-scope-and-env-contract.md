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

`contracts/agent-scope` defines four related types. It is intentionally
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

The contract is data: `contracts/agent-scope/conformance/env-table.json`
names every variable's class, its writer on each launch path and its known
readers, and `env-cases.json` beside it holds the cases each writer runs
(`contracts/agent-scope/conformance/README.md`). The table below is generated
from the JSON; edit the JSON. Invariant: `agent-spaces.scope-env-conformance`
(architecture/contracts/scope-env-conformance.md).

A variable's writer is the step of the composition that has the last word on
it.

Managed launch (HRC births the seat):

1. HRC derives identity, correlation and their copies from the session
   (hrc-native broker.rs `dispatch_environment`).
2. The launch intent's `launch.env` and `launch.unsetEnv` are applied on top.
   This is the caller's override channel; the contract does not constrain it
   and the fixture cases run with it empty.
3. HRC adds its plumbing ids (HRC_RUNTIME_ID, HRC_INVOCATION_ID,
   HRC_INITIAL_INPUT_ID).
4. Every key in the compiled plan's `lockedEnv` is removed from HRC's map and
   `lockedEnv` supplies it, so ASP's compile has the last word on any key it
   locks.
5. On the hrcpty path the harness starts through the operator's login shell
   (`$SHELL -lc`). The profile is not a writer of identity: it must not set or
   unset a variable in the canonical, correlation, compat, project or handle
   rows. Plumbing rows are outside that rule and record what it does today.

Unmanaged launch (`asp agent`): `buildAgentSessionEnv` derives identity and
ASP's `lockedEnv` is composed with it in the same process. `asp run` writes no
identity env. Variables are emitted only when their inputs are present; this
is not a promise that every launch receives every field.

<!-- env-table:begin — generated from contracts/agent-scope/conformance/env-table.json by conformance/generate.ts; edit the JSON, then run `bun conformance/generate.ts` -->

Writers, by the step of the composition order that has the last word:

- `hrc.dispatch`: HRC derives identity, correlation and their copies from the session (managed step 1; hrc-native broker.rs `dispatch_environment`)
- `hrc.preparation`: HRC adds its plumbing ids to the dispatch env (managed step 3; broker.rs `preparation`)
- `asp.lockedEnv`: ASP's compile puts the key in the plan's `lockedEnv` (raspd `locked_env`, Bun `composeAgentLocalEnv`); on a managed launch HRC removes every locked key from its map (step 4), so ASP has the last word
- `buildAgentSessionEnv`: the TypeScript builder in core/config/src/runtime/agent-session-env.ts, on an unmanaged `asp agent` launch
- `hrc-pty`: the hrcpty supervisor that starts the harness, outside HRC's dispatch map
- `login-profile`: the operator's login shell profile (`$SHELL -lc`, step 5); the contract says it must not set or unset an identity variable (canonical, correlation, compat, project or handle rows); plumbing rows naming it record what the profile does today

Classes:

- **canonical identity**: both writers emit them, same values for the same inputs
- **canonical correlation**: derived from the session's correlation; run id only when a run exists at spawn
- **compat copy**: a named function of a canonical key. The row says which launch path writes it today and lists its readers; this contract does not add a compat copy to a path that lacks it. A compat row is removed by a table change once its reader list is empty, never by a writer alone
- **project discovery id**: not a copy. With a project root ASP's compile writes it in `lockedEnv`: the scope's project id, or the basename of the project root when the scope has none, so it can be present when AGENT_PROJECT is absent. On a managed launch with no project root HRC writes it, equal to AGENT_PROJECT
- **locked project root**: written by ASP's compile in `lockedEnv` on both launch paths whenever there is a project root. HRC also derives it at step 1 and removes it at step 4, so HRC never has the last word on it
- **ASP materialization**: the agent's own directories and materialization pointers, written by ASP's compile in `lockedEnv` on both launch paths. Not identity; listed so that every variable a seat receives from the platform has a named writer
- **derived handle, managed only**: written by HRC only: `agent[@project[:task]][~lane]`, lane omitted when `main`. It leaves out the role, so for a role-scoped seat it is not the session's identity and does not round-trip; AGENT_SCOPE_REF is
- **runtime plumbing**: wiring written by HRC's writer, hrc-pty, the harness broker or the daemon's own inputs. The keys HRC's writer emits are tested as part of the exact map in the managed cases; the rest are listed with their writer
- **removed**: written today, read by nothing; the write is deleted

| Variable | Format | Class | Managed writer | Unmanaged writer | Known readers |
| --- | --- | --- | --- | --- | --- |
| `AGENT_SCOPE_REF` | canonical scope ref, e.g. `agent:cody:project:agent-spaces:task:T-04218` | canonical identity | hrc.dispatch | buildAgentSessionEnv | wrkq |
| `AGENT_ID` | bare agent id | canonical identity | hrc.dispatch | buildAgentSessionEnv | none recorded |
| `AGENT_PROJECT` | project id | canonical identity | hrc.dispatch (the scope has a project) | buildAgentSessionEnv (the scope has a project) | none recorded |
| `AGENT_TASK` | task id | canonical identity | hrc.dispatch (the scope has a task) | buildAgentSessionEnv (the scope has a task) | none recorded |
| `AGENT_LANE` | bare lane id, `main` by default | canonical identity | hrc.dispatch | buildAgentSessionEnv | none recorded |
| `AGENT_SESSION_REF` | `<scopeRef>/lane:<laneId>` | canonical identity | hrc.dispatch | buildAgentSessionEnv (the scope ref parses) | none recorded |
| `AGENT_ACTOR` | bare actor slug: the agent id unless the caller names another | canonical identity | hrc.dispatch | buildAgentSessionEnv | none recorded |
| `AGENT_PROJECT_ROOT` | absolute project root path | canonical identity | hrc.dispatch (the placement has a project root) | buildAgentSessionEnv (the placement has a project root) | none recorded |
| `AGENT_RUN_ID` | run id | canonical correlation | hrc.dispatch (a run exists at spawn) | buildAgentSessionEnv (the placement carries a run id, as `asp agent --run-id` gives) | none recorded |
| `AGENT_HOST_SESSION_ID` | host session id | canonical correlation | hrc.dispatch | buildAgentSessionEnv (the placement carries a host session id, as `asp agent --host-session-id` gives) | none recorded |
| `AGENT_GENERATION` | decimal generation of the host session | canonical correlation | hrc.dispatch | buildAgentSessionEnv (the placement carries a generation; no `asp agent` flag sets one) | none recorded |
| `AGENT_LANE_REF` | managed: `main` or `lane:<laneId>`; unmanaged: the placement's lane ref verbatim, which `asp agent` gives as the bare lane id | compat copy of `AGENT_LANE` | hrc.dispatch | buildAgentSessionEnv | none recorded |
| `ASP_SCOPE_REF` | canonical scope ref | compat copy of `AGENT_SCOPE_REF` | hrc.dispatch | not written | wrkq |
| `ASP_AGENT_ID` | bare agent id | compat copy of `AGENT_ID` | hrc.dispatch | not written | wrkq, kernel |
| `ASP_TASK_ID` | task id | compat copy of `AGENT_TASK` | hrc.dispatch (the scope has a task, else the launch's task context has one) | not written | none recorded |
| `ASP_PROJECT_ROOT` | absolute project root path — written through the tool runtime env, not by either identity builder | locked project root | asp.lockedEnv (the placement has a project root; HRC's step-1 write is removed at step 4) | asp.lockedEnv (the placement has a project root) | none recorded |
| `HRC_SESSION_REF` | `<scopeRef>/lane:<laneId>` — wrkq stamps the host session on writes from it and reads it strictly: a lane-less or non-canonical value stamps nothing | compat copy of `AGENT_SESSION_REF` | hrc.dispatch | buildAgentSessionEnv (the scope ref parses) | wrkq, kernel, hrc CLI |
| `HRC_RUN_ID` | run id | compat copy of `AGENT_RUN_ID` | hrc.dispatch (a run exists at spawn) | buildAgentSessionEnv (the placement carries a run id) | hrc CLI |
| `HRC_HOST_SESSION_ID` | host session id | compat copy of `AGENT_HOST_SESSION_ID` | hrc.dispatch | buildAgentSessionEnv (the placement carries a host session id) | none recorded |
| `HRC_GENERATION` | decimal generation | compat copy of `AGENT_GENERATION` | hrc.dispatch | buildAgentSessionEnv (the placement carries a generation) | none recorded |
| `WRKQ_PRINCIPAL_REF` | `agent:<AGENT_ACTOR>` — managed seats have none; wrkq derives the same principal from AGENT_SCOPE_REF | compat copy of `AGENT_ACTOR` | not written | buildAgentSessionEnv | wrkq |
| `ASP_PROJECT` | project id | project discovery id | asp.lockedEnv (the placement has a project root); hrc.dispatch (no project root and the scope has a project) | asp.lockedEnv (the placement has a project root) | wrkq, hrc CLI |
| `ASP_HANDLE` | `agent[@project[:task]][~lane]`, no role | derived handle, managed only | hrc.dispatch | not written | wrkq, hrc CLI |
| `HRC_RUNTIME_ID` | runtime id | runtime plumbing | hrc.preparation | buildAgentSessionEnv (the placement carries one; `asp agent` never does) | kernel |
| `HRC_INVOCATION_ID` | invocation id | runtime plumbing | hrc.preparation | buildAgentSessionEnv (the placement carries one; `asp agent` never does) | none recorded |
| `HRC_INITIAL_INPUT_ID` | input id | runtime plumbing | hrc.preparation (the launch carries an initial input) | buildAgentSessionEnv (the placement carries one; `asp agent` never does) | none recorded |
| `HRC_TASK_ID` | task id | runtime plumbing | hrc.dispatch (the launch has task context) | not written | none recorded |
| `HRC_TASK_PHASE` | task phase | runtime plumbing | hrc.dispatch (the task context has a phase) | not written | none recorded |
| `HRC_TASK_ROLE` | task role | runtime plumbing | hrc.dispatch (the task context has a role) | not written | none recorded |
| `HRC_TASK_HINTS` | hints text | runtime plumbing | hrc.dispatch (the task context has hints) | not written | none recorded |
| `HRC_TASK_REQUIRED_EVIDENCE` | comma-separated evidence kinds | runtime plumbing | hrc.dispatch (the task context lists required evidence kinds) | not written | none recorded |
| `HRC_PTY_SOCKET` | absolute socket path | runtime plumbing | hrc-pty (hrcpty-hosted seats) | not written | none recorded |
| `HRC_MAIL_STOP_SOCKET` | `<runtime root>/hrc.sock` | runtime plumbing | hrc.dispatch | not written | none recorded |
| `HRC_WRKQ_DB` | wrkq target | runtime plumbing | login-profile (exported by ~/.zshenv; not in HRC's map) | login-profile (exported by ~/.zshenv) | none recorded |
| `HRC_WRKQD_TOKEN_FILE` | absolute path of the wrkqd token file | runtime plumbing | login-profile (exported by ~/.zshenv; not in HRC's map) | login-profile (exported by ~/.zshenv) | none recorded |
| `WRKQD_TOKEN_FILE` | absolute path of the wrkqd token file, never its contents | runtime plumbing | hrc.dispatch (the daemon has HRC_WRKQD_TOKEN_FILE) | not written | none recorded |
| `WRKQ_DB` | wrkq target: the daemon's HRC_WRKQ_DB, else its WRKQ_DB | runtime plumbing | hrc.dispatch | not written | none recorded |
| `WRKQ_DB_PATH` | forced empty | runtime plumbing | hrc.dispatch (written empty); login-profile (~/.zshenv unsets it) | not written | none recorded |
| `WRKQ_DB_PATH_FILE` | forced empty | runtime plumbing | hrc.dispatch (written empty) | not written | none recorded |
| `WRKQ_ACTOR` | bare agent id | removed | hrc.dispatch (broker.rs:597 today; this write is deleted); login-profile (~/.zshenv unsets it before the harness starts) | not written | none recorded |
| `ASP_HOME` | absolute path of the ASP home | ASP materialization | asp.lockedEnv | asp.lockedEnv | none recorded |
| `ASP_AGENTS_ROOT` | absolute path of the agents root | ASP materialization | asp.lockedEnv | asp.lockedEnv | none recorded |
| `ASP_AGENT_ROOT` | absolute path of the agent's directory | ASP materialization | asp.lockedEnv | asp.lockedEnv | none recorded |
| `ASP_AGENT_NAME` | agent directory name | ASP materialization | asp.lockedEnv | asp.lockedEnv | none recorded |
| `ASP_AGENT_VAR_DIR` | absolute path under the agent root | ASP materialization | asp.lockedEnv | asp.lockedEnv | none recorded |
| `ASP_AGENT_STATE_DIR` | absolute path under the agent root | ASP materialization | asp.lockedEnv | asp.lockedEnv | none recorded |
| `ASP_AGENT_CACHE_DIR` | absolute path under the agent root | ASP materialization | asp.lockedEnv | asp.lockedEnv | none recorded |
| `ASP_AGENT_LOG_DIR` | absolute path under the agent root | ASP materialization | asp.lockedEnv | asp.lockedEnv | none recorded |
| `ASP_PLUGIN_ROOT` | absolute path of the materialized bundle | ASP materialization | asp.lockedEnv | asp.lockedEnv | none recorded |
| `ASP_PROJECT_ID` | `<project>_<agent>` bundle scope id | ASP materialization | asp.lockedEnv | asp.lockedEnv | none recorded |
| `ASP_PROJECT_STATE_DIR` | absolute per-project state path under the agent root | ASP materialization | asp.lockedEnv | asp.lockedEnv | none recorded |
| `ASP_PRIMING_PROMPT` | the seat's priming prompt text | ASP materialization | asp.lockedEnv | asp.lockedEnv | none recorded |

<!-- env-table:end -->

`AGENT_SCOPE_REF` and `AGENT_SESSION_REF` are both canonical but name
different concepts: use `AGENT_SCOPE_REF` for durable identity/ownership
logic, `AGENT_SESSION_REF` only when lane-aware session routing or
correlation matters.

## ASP-owned config vars

| Variable | Format | Legacy fallback |
| --- | --- | --- |
| `ASP_HOME` | absolute path | replaces `ASP_ROOT_DIR` |
| `ASP_AGENTS_ROOT` | absolute path | canonical (see `agent-spaces/materialization-install-flow`) |
| `ASP_PI_PATH` | absolute path | replaces `PI_PATH` (Pi harness) |
| `ASP_PROJECT` | project id | project discovery id; see the Agent-Session env table |

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
