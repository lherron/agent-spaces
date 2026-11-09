# Scope and env contract (r2)

Lance ruling 2026-11-09 (T-12832 item 5): one scope and env contract with a shared conformance fixture across Go, TypeScript and Rust. Grammar and env only. No new identity model, no new variables, no variable retired.

## Problem

The scope grammar is defined once, in TypeScript (contracts/agent-scope), and re-implemented by hand in Go (wrkq/internal/scope), Rust (hrc-runtime crates/hrc-common/src/scope.rs, plus lane and session parsing in hrc-cli) and ad hoc in the kernel (prae main.rs `seat_key` and `identity`, kernel reads.rs, bindings/wrkq.rs `scope`). Nothing checks them against each other. Read on 2026-11-09, they disagree on real inputs:

| Input | TypeScript | Elsewhere |
| --- | --- | --- |
| `alice:t1` (task, project from context) | handle form, needs a project | Go: refused as a bad agent id. Kernel `seat_key`: returns `agent:alice:task:t1`, which is not a legal scope ref |
| `alice@demo~x` (lane) | scope `agent:alice:project:demo`, lane `lane:x` | Go: refused. Kernel: project `demo~x` |
| `alice@demo~`, `agent:a/lane:bad lane` | refused | hrc-cli: accepted, lane never validated |
| `cody@wrkq/lane:main` as a session ref | refused (scope must be canonical) | Go session.go: accepted |
| `alice@`, `a@b@c`, `alice/r` | refused | Kernel bindings/wrkq.rs: `agent:alice`, `agent:a:project:b@c`, `agent:alice/r` |
| `agent:é×33` | bad characters | Go: bad length (counts bytes) |

The env side has two writers that were never compared. For a managed launch the writer is HRC (hrc-native broker.rs:572-640); the documented writer (core/config/src/runtime/agent-session-env.ts) runs only for unmanaged `asp run`. They emit different sets: HRC writes ASP_SCOPE_REF, ASP_AGENT_ID, ASP_TASK_ID, ASP_HANDLE and WRKQ_ACTOR and not WRKQ_PRINCIPAL_REF; the TS builder writes WRKQ_PRINCIPAL_REF and none of the ASP_* identity copies. WRKQ_ACTOR never arrives: hrc-pty starts the harness through the login shell and the operator's ~/.zshenv unsets it. The compiler also computes WRKQ_PRINCIPAL_REF (raspd compile/mod.rs:421), but only into the context it evaluates prompt templates in; on a managed launch it is in neither lockedEnv nor the dispatch env, so no managed seat has it. Readers depend on keys the doc calls legacy: the kernel reads ASP_AGENT_ID and HRC_SESSION_REF; wrkq resolves AGENT_SCOPE_REF → ASP_SCOPE_REF → ASP_HANDLE → ASP_AGENT_ID+ASP_PROJECT.

## Deliverables

Three data files and one document, all in agent-spaces `contracts/agent-scope/conformance/`:

1. `scope-cases.json`: the grammar fixture.
2. `env-cases.json`: the env fixture.
3. `env-table.json`: the env table as data (the rendered table in docs/identity-scope-and-env-contract.md is generated from it).
4. `README.md`: the operations, refusal codes and adoption rule below.

### 1. Grammar fixture

One JSON file. Each case names an operation, an input, and either the exact result or a refusal code.

```json
{"version": 1, "cases": [
  {"id": "ref-001", "op": "scopeRef.parse", "in": "agent:alice:project:demo:task:t1:role:rev",
   "ok": {"kind": "project-task-role", "agentId": "alice", "projectId": "demo", "taskId": "t1", "roleName": "rev"}},
  {"id": "ref-005", "op": "scopeRef.parse", "in": "agent:alice:task:t1", "refuse": "shape_invalid"},
  {"id": "res-001", "op": "input.resolve", "in": "alice@demo", "opts": {},
   "ok": {"scopeRef": "agent:alice:project:demo:task:primary", "laneRef": "main"}}
]}
```

Operations (the TypeScript function each one is defined by):

| op | Input → result | Defined by |
| --- | --- | --- |
| `scopeRef.parse` | string → kind and parts | parseScopeRef |
| `scopeRef.format` | parts → canonical string | formatScopeRef |
| `scopeHandle.parse` | string → canonical scope ref | parseScopeHandle |
| `scopeHandle.format` | scope ref → handle | formatScopeHandle |
| `laneRef.normalize` | string or absent → lane ref | normalizeLaneRef |
| `sessionHandle.parse` | string → scope ref + lane ref | parseSessionHandle |
| `sessionRef.parse` | string → scope ref + lane ref | parseSessionRef |
| `sessionRef.format` | scope ref + lane ref → string | formatSessionRef |
| `input.resolve` | string + opts (`projectId`, `taskId`, `defaultTaskId`, `envDefaultTask`, `defaultRoleName`) → scope ref + lane ref | resolveQualifiedScopeInput |
| `identity.project` | any string → parts or `{"kind": "unparsed"}`; never refuses | new, see Lenient reads |

Refusal codes are coarse on purpose. Messages stay each language's own; nobody branches on finer causes today.

| Code | Meaning |
| --- | --- |
| `empty` | empty input |
| `token_invalid` | a segment is not 1..64 characters of `[A-Za-z0-9._-]` |
| `shape_invalid` | segments, separators or their order are wrong (including an input that is neither a scope ref nor a handle) |
| `directive_not_allowed` | a `+` directive where the operation takes none |
| `task_requires_project` | `input.resolve` got a task with no project from input or opts |

The first cut is the 52 cases in the T-12838 research note (15 scope ref, 13 handle, 7 session handle, 9 session ref, 2 lane, 6 resolve), plus format round-trips and the `identity.project` cases. The TypeScript implementation is the source of expected values: a script in the package regenerates `ok`/`refuse` from the functions above and fails if the committed file differs, so the fixture cannot drift from the canonical code.

### Rulings the fixture encodes

1. Parse does not default; resolve does. `scopeHandle.parse("alice@demo")` is `agent:alice:project:demo`. `input.resolve("alice@demo")` is `…:task:primary`. Both stay. Which one a caller uses is that caller's decision, but it must be one of these two operations, not a third behaviour.
2. `alice:t1` is a handle whose project comes from context. `scopeHandle.parse` refuses it (`shape_invalid`); `input.resolve` accepts it with `opts.projectId` and refuses `task_requires_project` without.
3. Lanes are validated wherever they are parsed. `~`, `~x~y`, `~lane:x` and `/lane:bad lane` refuse.
4. A session ref's scope part is a canonical scope ref. `cody@wrkq/lane:main` refuses.
5. `lane:default` is a lane named `default`. The `default` → `main` rewrite that some callers apply is not grammar.
6. Token length and character set are one refusal (`token_invalid`), so byte-versus-UTF-16 counting cannot produce different answers.

### Lenient reads

Stored rows predate validation, so one operation is allowed to be lenient: `identity.project`, which projects whatever string is in a record into parts for display and filtering and returns `{"kind": "unparsed"}` when it cannot. It is defined by hrc-common `legacy_derive_identity` as it behaves today, moved into the fixture as cases. It is never used to accept input: anything that arrives from a caller (CLI argument, env, RPC parameter) goes through a strict operation. Every other lenient path found in the survey is nonconformant and is removed on adoption.

### 2 and 3. Env table and env fixture

`env-table.json` has one row per variable: name, format, class, writer on a managed launch, writer on an unmanaged launch, known readers.

How the env of a seat is composed, in order. The table names the step that has the last word for each variable; that step is the variable's writer.

Managed launch (HRC births the seat):

1. HRC derives identity, correlation and their copies from the session (hrc-native broker.rs `dispatch_environment`).
2. The launch intent's `launch.env` and `launch.unsetEnv` are applied on top. This is the caller's override channel. The contract does not constrain it and the fixture cases run with it empty.
3. HRC adds its plumbing ids (HRC_RUNTIME_ID, HRC_INVOCATION_ID, HRC_INITIAL_INPUT_ID).
4. Every key present in the compiled plan's `lockedEnv` is removed from HRC's map (broker.rs:807-810), and `lockedEnv` supplies it. So ASP's compile has the last word on any key it locks.
5. On the hrcpty path the harness starts through the operator's login shell (`$SHELL -lc`). The profile is not a writer: it must not set or unset a variable in this table. The observed-env cases are taken after it, so a profile that does shows up as a failing case. The existing `unset WRKQ_ACTOR` line becomes moot when the write is removed.

Unmanaged launch (`asp run`, `asp agent`): `buildAgentSessionEnv` derives identity; ASP's `lockedEnv` is composed with it in the same process. There is no HRC correlation, so those keys are absent.

The compile plan's `dispatchRequest.dispatchEnv` is a verbatim echo of the `placement.dispatchEnv` HRC sent; the compiler adds nothing to it and it is not an override channel (hrc-native broker.rs:792-795 changes to match).

What `lockedEnv` contains from this table's point of view: the agent's own directories and materialization pointers (ASP_HOME, ASP_AGENTS_ROOT, ASP_AGENT_ROOT and its VAR/STATE/CACHE/LOG dirs, ASP_AGENT_NAME, ASP_PLUGIN_ROOT, ASP_PROJECT_ID, ASP_PROJECT_STATE_DIR, ASP_PRIMING_PROMPT), AGENTCHAT_ID, and one key that overlaps identity: ASP_PROJECT, written whenever the placement has a project root (raspd compile/mod.rs:2233-2243, Bun prepare-cli-runtime.ts:509). It is the only identity-related key ASP locks, and by step 4 ASP is its writer on those launches.

Classes:

| Class | Variables | Rule |
| --- | --- | --- |
| canonical identity | AGENT_SCOPE_REF, AGENT_ID, AGENT_PROJECT, AGENT_TASK, AGENT_LANE, AGENT_SESSION_REF, AGENT_ACTOR, AGENT_PROJECT_ROOT | both writers emit them, same values for the same inputs |
| canonical correlation | AGENT_RUN_ID, AGENT_HOST_SESSION_ID, AGENT_GENERATION | managed only; run id only when a run exists at spawn |
| compat copy | AGENT_LANE_REF, ASP_SCOPE_REF, ASP_AGENT_ID, ASP_TASK_ID, ASP_PROJECT_ROOT, HRC_SESSION_REF, HRC_RUN_ID, HRC_HOST_SESSION_ID, HRC_GENERATION, WRKQ_PRINCIPAL_REF | each is a named function of a canonical key. The row says which launch path writes it today and lists its readers; this contract does not add a compat copy to a path that lacks it. A compat row is removed by a table change once its reader list is empty, never by a writer alone |
| project discovery id | ASP_PROJECT | not a copy. With a project root: written by ASP's compile in `lockedEnv`, value is the scope's project id, or the basename of the project root when the scope has no project. So it can be present when AGENT_PROJECT is absent. Managed launch with no project root: written by HRC, equal to AGENT_PROJECT |
| derived handle, managed only | ASP_HANDLE | written by HRC only: `agent[@project[:task]][~lane]`, lane omitted when `main`. It leaves out the role, so for a role-scoped seat it is not the session's identity and does not round-trip; AGENT_SCOPE_REF is. `buildAgentSessionEnv` does not write it |
| HRC plumbing | HRC_RUNTIME_ID, HRC_INVOCATION_ID, HRC_INITIAL_INPUT_ID, HRC_TASK_ID and the other HRC_TASK_* keys, HRC_PTY_SOCKET, HRC_MAIL_STOP_SOCKET, HRC_WRKQ_DB, HRC_WRKQD_TOKEN_FILE, WRKQD_TOKEN_FILE, WRKQ_DB, WRKQ_DB_PATH, WRKQ_DB_PATH_FILE | HRC only; listed, not fixture-tested |
| removed | WRKQ_ACTOR | written at broker.rs:597, unset by the login profile before the harness starts, read by nothing; the write is deleted |

One thing changes behaviour: HRC stops writing WRKQ_ACTOR. Everything else is recorded as it is written today:

- Managed launches carry the ASP_* copies (ASP_SCOPE_REF, ASP_AGENT_ID, ASP_TASK_ID, ASP_PROJECT_ROOT), ASP_HANDLE and ASP_PROJECT, and not WRKQ_PRINCIPAL_REF. wrkq derives the same principal from AGENT_SCOPE_REF (internal/attribution/principal.go: explicit env first, then scope-derived, both through `buildAttribution` with the scope attached), so no managed reader needs it.
- Unmanaged launches carry WRKQ_PRINCIPAL_REF, the HRC_SESSION_REF copy, and ASP_PROJECT from `lockedEnv` when there is a project root; not the ASP_* identity copies and not ASP_HANDLE.

Making the two paths emit the same compat set would be a behaviour change on three nodes with no reader that needs it. If one is wanted later it is its own change with its own readback (objection from mable@hrc-runtime, EN-48638, accepted).

Readers recorded in the first table, from code read on 2026-11-09: wrkq (AGENT_SCOPE_REF, ASP_SCOPE_REF, ASP_HANDLE, ASP_AGENT_ID, ASP_PROJECT, WRKQ_PRINCIPAL_REF), the kernel (ASP_AGENT_ID, HRC_SESSION_REF, HRC_RUNTIME_ID), the native hrc CLI (HRC_SESSION_REF, HRC_RUN_ID, ASP_HANDLE, ASP_PROJECT).

`env-cases.json` has three kinds of case, each tested at the step that writes:

- `managed`: input is the session identity (`scopeRef`, `laneRef`, `hostSessionId`, `generation`, optional `runId`, `projectRoot`) plus `lockedEnvKeys`, the keys the compiled plan locked. Expected is HRC's map after steps 1, 3 and 4, with no step-2 overrides. HRC's writer runs these. They include a role-scoped scope (ASP_HANDLE without the role) and a project-root launch (ASP_PROJECT absent from HRC's map because it is locked).
- `unmanaged`: input is a placement; expected is exactly what `buildAgentSessionEnv` returns. The TypeScript builder runs these.
- `locked`: input is a scope and a project root; expected is the ASP_PROJECT entry of `lockedEnv`, including the agent-only scope whose value is the root's basename. The compiler that builds `lockedEnv` runs these (raspd, and Bun while it exists).

The managed cases are taken from the env of live seats on max3 (claude-hrcpty, and the tool shell of a codex-hrcpty seat) with ids replaced by fixed placeholders; the unmanaged cases from a real `asp run`.

## Distribution and adoption

The fixture ships as data in the `agent-scope` package (TypeScript consumers already depend on it) and is copied into each other repo at a fixed path by that repo's sync recipe. Each consumer's verify does two things: loads its copy and runs every case for the operations it implements, and, when the sibling agent-spaces checkout is present, fails if its copy differs from the canonical file.

A consumer declares the operations it implements. It must implement every operation it has code for today; it may not keep a private parser for one it does not declare.

| Consumer | Owner | Adopts by |
| --- | --- | --- |
| agent-spaces contracts/agent-scope | mable@agent-spaces | fixture generated from and tested against the package; refusal codes added to its errors; `buildAgentSessionEnv` passes the unmanaged env cases, unchanged in what it emits |
| hrc-runtime crates (hrc-common, hrc-cli selectors, broker.rs env) | mable@hrc-runtime | cargo test loads both fixtures; lane and session parsing in hrc-cli move behind hrc-common; WRKQ_ACTOR write removed. A lane form that exists in live stored rows becomes an `identity.project` case, not a new refusal on read |
| wrkq internal/scope | mable@wrkq | go test loads the grammar fixture; `alice:t1`, lanes and strict session refs added; `Resolve`'s project-kind projection stays as wrkq's own step on top of a conformant parse |
| kernel (prae `seat_key`, `identity`; reads.rs; bindings/wrkq.rs `scope`) | mable@praesidium-kernel | one conformant parser crate (hrc-common's or a copy tested on the fixture) replaces the four ad hoc ones |

The TypeScript call sites in hrc-runtime packages and agent-control-plane that parse session refs without the package (eight, listed in the research note) are reported to their owners. They are not part of this contract's close.

## Closes when

1. The grammar fixture is committed with every case generated from the TypeScript package, and the package's test fails when a case is edited by hand.
2. Rust, Go and the kernel each run the grammar fixture in their verify and pass every case for their declared operations. Each run is shown red first on at least the divergences in the Problem table that apply to it.
3. Both env writers pass the env cases for their launch path, and a fresh managed seat and a fresh `asp run` seat on max3 each show exactly the canonical and compat keys the table lists for that path, with WRKQ_ACTOR written by nothing.
4. Editing a consumer's copy of the fixture fails that consumer's verify on max3.

## Explicitly unsupported

- Byte-identical error messages across languages. Codes only.
- A shared library or generated parser. Three small hand-written parsers checked by one fixture is the design.
- Retiring any compat variable. The table records readers; retirement is a later table change.
- Verify on a machine without the agent-spaces checkout detecting a stale copy. All consumers build on hosts that have it.
- The `default` → `main` lane rewrite and the narrower agent-name regexes in ACP. Reported, not ruled here.
- Agreement between an identity key and its copies when a launch intent overrides or unsets one through `launch.env` or `launch.unsetEnv`. That channel exists for the caller to override; cases run with it empty.
- Validating historical rows. `identity.project` stays lenient for them.
