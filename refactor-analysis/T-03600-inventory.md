# T-03600 — Refreshed deferred-refactor inventory

> Re-audit date: 2026-06-22 · source-of-truth: current tree (HEAD), not the
> 2026-06-14 reports. Each original bullet from T-03531/T-03600 is reclassified
> against live source via the section-3 `rg` sweeps. Categories used:
> `resolved`, `in-repo refactor`, `Expand/Contract`, `downstream-blocked`,
> `optional`, `stale-test-debt`, `stale/no-op`, `product decision`.

This document is the executable plan the task asks for: it pins each item to a
category so a future implementer applies in-repo refactors, opens Expand/Contract
migrations, defers downstream-blocked work, and leaves product decisions as
decision records (below) instead of guessing.

## Product decision records (Lance-owned — do not guess)

These two bullets are genuine policy calls. They stay decision records until
Lance chooses in the task or a linked comment.

### Decision: `opus-4-6` Agent SDK alias policy
File: `packages/config/src/core/models.ts:61` maps Agent SDK aliases including
`opus-4-6`. It is a real `AgentSdkModelAlias`, consumed by harness-claude — a
versioned-catalog policy call, not a bug.
- Options:
  1. Keep `opus-4-6` as a versioned catalog alias alongside the bare `opus`
     latest-alias (status quo).
  2. Collapse `opus-4-6` to bare `opus` and drop the version-pinned entry,
     forcing all callers onto the latest-alias.
- API impact: option 2 removes an exported `AgentSdkModelAlias` member; any
  config/model lookup that pins `opus-4-6` would fail the compiler's strict
  uncatalogued-pin reject. Option 1 is additive / no API change.
- Downstream migration impact: harness-claude and any hrc-runtime / ACP target
  config pinning `opus-4-6` must move to `opus`; requires a cross-repo grep for
  `opus-4-6` before removal. Lance standing guidance is "use aliases, never pin
  versions", which favors option 2 but is a product call, not auto-applied.
- Validation: `bun test packages/config`, `bun run typecheck`, plus a cross-repo
  `rg -n "opus-4-6" ../hrc-runtime ../agent-control-plane` import inventory and a
  real harness-claude launch smoke after any catalog change.

### Decision: `parseSessionHandle` strict-vs-lenient parsing
File: `packages/agent-scope/src/session-handle.ts:36` calls `laneRefFromId(...)`;
`lane-ref.ts` wraps the string rather than validating it, so lane parsing is
currently lenient. Whether `parseSessionHandle(...)` should reject invalid
`LaneRef` input is a public-contract decision.
- Options:
  1. Lenient (status quo): wrap any lane string, never throw.
  2. Strict: validate `LaneRef` shape and reject invalid handles with a
     `CodedError`.
- API impact: option 2 changes `parseSessionHandle`'s observable contract from
  total to partial (can now throw); callers that today pass through malformed
  lanes would start failing.
- Downstream migration impact: `parseSessionHandle` is consumed downstream at
  `hrc-runtime/packages/hrc-core/src/selectors.ts:307`; a strict flip needs an
  import inventory across hrc-runtime and ACP and a migration of any caller that
  relied on lenient pass-through before the contract tightens.
- Validation: `bun test packages/agent-scope`, `bun run typecheck`, downstream
  `rg -n "parseSessionHandle" ../hrc-runtime ../agent-control-plane` plus a
  downstream compile/test before adopting strict mode.

## Classification table

| Original bullet | Live source fact | Category |
| --- | --- | --- |
| Lane 3: `runPlacementTurnNonInteractive` (run-placement-turn.ts) | Still large; pinned by broad source-inspection tests now rewritten in this task | in-repo refactor |
| Lane 3: `runTurnNonInteractive` (client.ts) | Intentionally separate from the in-flight path; completes on a simple `turnEnded` boolean (turn-driver.ts:33) — do NOT fold into `attachTurnDriver` without equal-timing characterization | in-repo refactor |
| Lane 3: `runTurnInFlight` (client.ts) | In-flight driver path; `attachTurnDriver(...)` already lifted (turn-driver.ts:38, resolved for in-flight) | in-repo refactor |
| Lane 3: `preparePlacementCliRuntime` (prepare-cli-runtime.ts) | Still large; pinned by broad source-inspection tests now rewritten in this task | in-repo refactor |
| Lane 3: `packages/execution/src/run.ts` `run()` ~290L | `installRunTarget(...)`/`buildProjectRunCompilerContext(...)` already extracted above it; extract only cohesive helpers preserving option-bag field sets exactly | in-repo refactor |
| Lane 3: `applyEventState` switch split (harness-broker) | Load-bearing stateful switch; report-marked OPTIONAL, low priority unless characterized first | optional |
| `composeAgentLocalEnv` (compose-agent-local-env.ts:57) | Shared helper preserves CLI-vs-placement env divergence; both turn paths delegate | resolved |
| `hrcEventsBridgePath` (harness.ts:371 / pi-adapter.ts:665) | Declared on the shared Pi bundle type and read through it | resolved |
| `ASPC_FACADE_VERSION` (aspc/service.ts:30-40) | Reads facade version from `../package.json`; treat as verification/smoke coverage, not a product decision | resolved |
| Lane 4: `cli-kit` remove 10 unused exports | Zero in-repo callers but consumed out-of-repo (e.g. `repeatable` has live acp-cli callers); needs cross-repo import inventory before any removal | downstream-blocked |
| Lane 4: `buildProcessInvocationSpec` legacy non-placement branch (client.ts:248) + contract type (types.ts:180) | Still called downstream by `hrc-server/.../cli-adapter.ts:244`; remove only via additive/deprecation + HRC migration | Expand/Contract |
| Lane 4: `AgentSpacesClientOptions.registryPath` (client.ts:159/253/362) | Still accepted/stored/threaded; keep until re-audit proves no supported caller needs it | downstream-blocked |
| Lane 4: `renderKeyValueSection` (spaces-execution) | Still imported by `hrc-cli/.../handlers-scope-cmd.ts:5` and used at `:406`; not removable until HRC caller migrated | downstream-blocked |
| Lane 4: `symmetric driver/normalizer exports` (harness-broker index.ts:31) | Export-shape decision, low value | optional |
| Lane 4: `buildThreadStartParams`/buildTurnStartParams default dedup (driver.ts) | Default dedup, low value | optional |
| Lane 4: `SchemaRecord` ~130-key reshape (harness-broker-protocol schemas.ts:65) | Exported, consumed downstream; high-risk hand-maintained type | downstream-blocked |
| Lane 4: `startInvocation` positional convenience overload (harness-broker-client client.ts:134) | Public surface on a downstream-consumed pkg, low value | downstream-blocked |
| `getStorePath` (config store/paths.ts) | No longer present as a live source API; live helpers are `getProjectDataPath`/`getProjectTargetsPath` | stale/no-op |
| `PathResolver.store` (config store/paths.ts) | No longer present as a live source API | stale/no-op |
| Config path integration debt (`pathResolver.store` in integration-tests/tests/install.test.ts:112) | Test still references removed surface; migrate to live `PathResolver`/snapshot APIs | stale-test-debt |
| `LintOptions.rules` (config lint/index.ts) | Old `LintOptions.rules` surface no longer exposed; removed from open decisions | stale/no-op |
| `opus-4-6` alias policy (config core/models.ts:61) | Real `AgentSdkModelAlias`; see decision record above | product decision |
| `parseSessionHandle` strict-vs-lenient (agent-scope session-handle.ts:36) | Public-contract behavior; see decision record above | product decision |
| Lane 2 left: `execute-embedded-sdk` slash-split / env-channel dedup | Divergent semantics, not byte-identical; only via deliberate behavior-change redesign with its own characterization tests | optional |
| Lane 2 left: `inferTargetFromBundleRoot` unify (cli) | Divergent semantics; deliberate redesign only | optional |
| Lane 2 left: `notification-method dispatch` (harness-codex) | Divergent semantics; deliberate redesign only | optional |

## Source-introspection blocker cleanup

The broad whole-function regex/`extractFunction` blockers that pinned the bodies
of `preparePlacementCliRuntime` and `runPlacementTurnNonInteractive` are
rewritten to narrow, named-region assertions that still fail on the wiring
regressions they protect (planner cutover, `resolvePlacementContext` +
`materializeSpec` pipeline, agent-local env compose via `composeAgentLocalEnv`,
scoped-env overlay restore, empty-response/`producedContent` guard, pi-sdk bundle
load). Files updated:

- `packages/agent-spaces/src/__tests__/phase4-harness-adapter-integration.test.ts`
- `packages/agent-spaces/src/__tests__/m5-public-api-cutover.test.ts`
- `packages/agent-spaces/src/__tests__/headless-empty-response.test.ts`
- `packages/cli/src/__tests__/m6-agent-cli.test.ts`

The replacements bound each function by its declaration and the next top-level
declaration (named-region helper) instead of a greedy `[\s\S]*?^}` scan, so a
future Lane 3 extraction that preserves the wiring keeps the tests green while a
regression that drops the wiring still fails them.
