# Scope and env conformance fixtures

One scope grammar and one env contract, checked across TypeScript, Rust and Go
by shared data rather than a shared library. Design: architecture/contracts/
scope-env-conformance.md (invariant `agent-spaces.scope-env-conformance`).

| File | What it is | Where its values come from |
| --- | --- | --- |
| `scope-cases.json` | grammar cases: an operation, an input, and the exact result or a refusal code | generated from this package by `generate.ts`; never edit by hand |
| `env-table.json` | one row per variable: format, class, writer on each launch path, known readers | edited by hand; renders the table in docs/identity-scope-and-env-contract.md |
| `env-cases.json` | env cases of three kinds, each tested at the step that writes | observed on max3 (provenance in each case) |

## Grammar operations

Each case is `{"id", "op", "in", ["opts"], ["note"], "ok" | "refuse"}`.

| op | `in` | `ok` | Defined by |
| --- | --- | --- | --- |
| `scopeRef.parse` | string | `{kind, agentId, projectId?, taskId?, roleName?}` | `parseScopeRef` |
| `scopeRef.format` | `{agentId, projectId?, taskId?, roleName?}` | canonical scope ref | `formatScopeRef` |
| `scopeHandle.parse` | string | canonical scope ref | `parseScopeHandle` |
| `scopeHandle.format` | canonical scope ref | handle | `formatScopeHandle` |
| `laneRef.normalize` | string, or `null` for an absent argument | lane ref | `normalizeLaneRef` |
| `sessionHandle.parse` | string | `{scopeRef, laneRef}` | `parseSessionHandle` |
| `sessionRef.parse` | string | `{scopeRef, laneRef}` | `parseSessionRef` |
| `sessionRef.format` | `{scopeRef, laneRef}` | session ref string | `formatSessionRef` |
| `input.resolve` | string, with `opts` | `{scopeRef, laneRef}` | `resolveQualifiedScopeInput` |
| `identity.project` | any string | `{kind, agentId, projectId?, taskId?, roleName?}` or `{kind: "unparsed", agentId: <input>}`; never refuses | hrc-common `legacy_derive_identity` as of 2026-11-09 |

`input.resolve` opts: `projectId`, `taskId`, `defaultTaskId`, `defaultRoleName`,
and `envDefaultTask`, the value of `ASP_DEFAULT_TASK` for that call (absent
means unset). An implementation that reads the env var must set it per case.

`identity.project` is the only lenient operation. It projects stored records
for display and filtering and is never used to accept input from a caller.

### Refusal codes

| Code | Meaning |
| --- | --- |
| `empty` | the operation's input is empty (after its own trimming, for `sessionRef.parse`) |
| `token_invalid` | a segment is not 1..64 characters of `[A-Za-z0-9._-]` (one code, so byte and UTF-16 counting agree) |
| `shape_invalid` | segments, separators or their order are wrong, including an input that is neither a scope ref nor a handle |
| `directive_not_allowed` | a `+` directive where the operation takes none |
| `task_requires_project` | `input.resolve` got a task with no project from input or opts |

Messages stay each language's own; only codes are compared. In TypeScript
every grammar error is a `ScopeGrammarError` (`code`), and every
`ValidationResult` failure carries the same `code`. Directive-content errors
from `input.resolve` (`ProvisionDirectiveError`: unknown, denied or invalid
directive values) are not grammar refusals and have no fixture case.

## Env composition and case kinds

A variable's writer is the step of the composition with the last word on it.
Managed launch: (1) HRC derives identity from the session; (2) `launch.env` /
`launch.unsetEnv` apply on top, the caller's override channel, empty in every
case; (3) HRC adds its plumbing ids; (4) every key in the compiled plan's
`lockedEnv` is removed from HRC's map and `lockedEnv` supplies it; (5) the
hrcpty harness starts through the login shell, which must not write a table
variable. Unmanaged launch (`asp agent`): `buildAgentSessionEnv`, composed with
ASP's `lockedEnv` in the same process.

Each env case is `{"id", "kind", "in", "expected", "provenance"}`; `expected`
is an exact map.

| kind | `in` | `expected` | Runs against |
| --- | --- | --- | --- |
| `unmanaged` | `{placement}` from a real `asp agent` launch | exactly what `buildAgentSessionEnv(placement)` returns | core/config `agent-session-env-conformance.test.ts` |
| `locked` | `{scopeRef, projectRoot?}` | `{ASP_PROJECT}` of `lockedEnv`, or `{}` | Bun `locked-env-conformance.test.ts`; raspd `compile::env_conformance` |
| `managed` | `session {scopeRef, laneRef, hostSessionId, generation}`, `runId?`, `placement {projectRoot?}`, `taskContext?`, `ids {runtimeId, invocationId?, initialInputId?}`, `daemon {wrkqDb, wrkqdTokenFile?, runtimeRoot}`, `lockedEnvKeys`, `launch` (empty) | HRC's whole map after steps 1, 3 and 4 | hrc-runtime's writer (hrc-native broker.rs) |

Ids and host paths in env cases are fixed placeholders. A case with
`provenance.observed: false` was derived by reading the writer, not observed.

## Adoption

A consumer declares the operations it implements and must declare every
operation it has code for; it may not keep a private parser for one it does
not declare. Its verify:

1. loads its copy of the fixture and runs every case for its declared
   operations (and the env case kinds of the writer it owns);
2. when the sibling agent-spaces checkout is present, fails if its copy
   differs from the canonical file here.

TypeScript consumers read the files from the package
(`agent-scope/conformance/scope-cases.json`); other repos copy them to a fixed
path with their sync recipe.

## Changing the fixtures

- Grammar: add or edit inputs in `scope-case-inputs.ts`, then
  `bun conformance/generate.ts`. `bun test` fails while `scope-cases.json`
  differs from what the package generates, and while the doc's env table
  differs from `env-table.json`.
- Env table: edit `env-table.json`, then `bun conformance/generate.ts`.
- Env cases: rebuilt from captured evidence by the scripts in the T-12838
  artifact directory (`capture-managed.sh`, `capture-unmanaged.sh`,
  `build-env-cases.ts`).
