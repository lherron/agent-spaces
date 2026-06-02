# 🔧 Refactoring Analysis

**Target:** `packages/agent-spaces/src` (production sources; `testing/` and `__tests__/` excluded from findings)
**Lines analyzed:** ~5,500 production LOC (10,434 incl. testing helpers); deep-read: `compile-runtime-plan.ts` (1,781), `client.ts` (871), `run-placement-turn.ts` (444), `prepare-cli-runtime.ts` (403), `broker-invocation.ts` (370), `client-support.ts` (179), `types.ts` (402)
**Generated:** 2026-06-01  ·  **Focus:** all

## 📊 SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| Single Responsibility | 🔴 | `compile-runtime-plan.ts` is 1,781 lines with 4 near-identical plan-builder functions; `client.ts` factory mixes 10 RPC concerns in one closure; `runTurnNonInteractive`/`runTurnInFlight`/`runPlacementTurnNonInteractive` are 130–250-line methods doing validation + env + session lifecycle + event mapping + error shaping. |
| Open/Closed | 🟡 | Per-harness compile branches selected by `selectsInteractiveClaudeTmuxBroker`/`selectsInteractiveCodexTmuxBroker` boolean dispatch; adding a harness family requires editing `compileRuntimePlan` plus copying a whole ~225-line builder. `FOREGROUND_ROUTES`/`RUNTIME_TO_FAMILY` tables are the good (extensible) pattern; the plan builders are not. |
| Liskov Substitution | 🟢 | No throwing/no-op overrides found; `UnifiedSession`/`PiSession` substitute cleanly. Minor: `interrupt` is probed via structural `typeof` checks (`context.session as { interrupt?... }`) rather than a typed capability, but base behavior is preserved with a documented fallback. |
| Interface Segregation | 🟡 | `AgentSpacesClient` is a 10-method "god" surface (compile + resolve + describe + capabilities + 2 build-spec + 4 in-flight/turn ops). Consumers needing only `compileRuntimePlan` depend on the whole surface. `ProcessInvocationSpec`/`RunTurnNonInteractiveRequest` are wide (15+ members) but cohesive. |
| Dependency Inversion | 🟡 | Business logic directly news collaborators: `new PiSession(...)` in `client.ts:772` and `run-placement-turn.ts:285`, `createSession(...)` direct calls, `harnessRegistry.getOrThrow(...)` global singleton, and `process.stderr.write` timing in the compiler (`compile-runtime-plan.ts:548`). No injection seam for sessions/registry, which forces real materialization in tests. |

## 🎯 Priority Refactorings

### 1. Extract the duplicated plan-assembly pipeline in the four compile builders — SRP / DRY
- **Location:** `compile-runtime-plan.ts` — `compileBrokerPlan` (582), `compileForegroundPlan` (779), `compileEmbeddedSdkPlan` (1076), `compileClaudeTmuxBrokerPlan` (1324), `compileCodexTmuxBrokerPlan` (1556)
- **Current:** Each builder independently repeats the same tail: build `prepared` via `preparePlacementCliRuntime` with an identical ~14-line option spread, then `lockedEnv`/`lockedEnvKeys`/`bundleIdentity`/`lockHash` extraction, `compileId = stableId('compile', {requestId, operationId, generation, profileHash})`, `createdAt`, `resolvedBundle` cast, `toCompiledPlacement`, a ~50-line `planMaterial` literal, `planHash = projectionHash(planMaterial,'plan')`, and the final `{schemaVersion, ok:true, plan, diagnostics}`. The two tmux builders (`compileClaudeTmuxBrokerPlan` / `compileCodexTmuxBrokerPlan`) are nearly byte-identical except for `driver.kind` (`claude-code-tmux` vs `codex-cli-tmux`) and the extra `hookBridge` field.
- **Suggested:** Pull the prepare-options builder into one `buildPreparePlacementRequest(req, route, placement)` helper; extract `assembleCompiledPlan({req, prepared, profile, harness, model, diagnostics})` that owns `compileId`/`createdAt`/`planMaterial`/`planHash`/response. Collapse the two tmux builders into one `compileTmuxBrokerPlan(req, placement, options, driverKind)` parameterized by driver descriptor. Target: ~700 lines removed.
- **Risk:** Med (hashes are contract-load-bearing — `planHash`/`profileHash`/`specHash` are asserted by smoke matrix and byte-parity tests)  ·  **Effort:** 1–1.5 days  ·  **Tests:** `__tests__/compile-runtime-plan.test.ts`, `run-compile-byte-parity.test.ts`, `compiler-broker-profile.test.ts`, `compiler-broker-initial-input.test.ts`, then `bun run smoke:matrix`.

### 2. Split `client.ts` factory into per-concern modules — SRP / ISP
- **Location:** `client.ts:105` `createAgentSpacesClient` (entire 766-line closure)
- **Current:** A single closure implements all 10 `AgentSpacesClient` methods. `runTurnInFlight` (310–552) and `runTurnNonInteractive` (619–869) are each ~240 lines, internally rebuilding the same "emit state:error → emit complete → return provider/frontend/model/result" failure shape 5+ times per method. The legacy non-placement `buildProcessInvocationSpec` branch (203–299) duplicates the adapter detect/loadBundle/buildRunArgs flow that `prepare-cli-runtime.ts` already owns.
- **Suggested:** `runTurnInFlight` and `runTurnNonInteractive` already have a placement sibling extracted (`run-placement-turn.ts`); extract their legacy bodies into `run-turn-non-interactive.ts` / `run-turn-in-flight.ts` mirroring that pattern. Extract a `failTurn(eventEmitter, frontendDef, req, error, code?)` helper for the repeated error-emit-and-return triple. Have the legacy `buildProcessInvocationSpec` branch reuse the prepare/adapter path instead of re-detecting.
- **Risk:** Med (event ordering is observable)  ·  **Effort:** 1 day  ·  **Tests:** `client.test.ts`, `client-process-invocation.characterization.test.ts`, `headless-empty-response.test.ts`, `m5-public-api-cutover.test.ts`.

### 3. Deduplicate the failure-result construction across turn methods — SRP / DRY
- **Location:** `client.ts` (330–337, 347–355, 369–378, 394–410, 538–550), `run-placement-turn.ts` (94–103, 119–135, 376–398, 416–443)
- **Current:** The block `const result: RunResult = {success:false, error: toAgentSpacesError(...)}; await eventEmitter.emit(state:error); await eventEmitter.emit(complete); return {provider, frontend, model, result}` is hand-copied ~9 times with subtle variations (some include `continuation`/`resolvedBundle`, some use `modelResolution.ok ? ... : req.model`). This is a classic shotgun-surgery hazard: a change to the failure event contract must be made in nine places.
- **Suggested:** One `emitTurnFailure(eventEmitter, base, error, code?)` returning the `RunTurnNonInteractiveResponse`, where `base` carries provider/frontend/model and optional continuation/resolvedBundle.
- **Risk:** Low  ·  **Effort:** 3–4 hrs  ·  **Tests:** existing `client.test.ts` + placement turn coverage.

### 4. Replace boolean route-selection with a routing table — OCP
- **Location:** `compile-runtime-plan.ts:520` `selectsInteractiveClaudeTmuxBroker`, `:529` `selectsInteractiveCodexTmuxBroker`, dispatch at `:560`
- **Current:** Two functions duplicate the identical family-resolution logic (`req.requested.harnessFamily ?? RUNTIME_TO_FAMILY[runtime]`, plus the `controllerIntent === 'foreground-terminal'` guard) and differ only in the family compared. The dispatcher in `compileRuntimePlan` is an if/if/else chain that grows per family.
- **Suggested:** A single `resolveInteractiveRoute(req): {family, builder}` that resolves family once and maps to a builder via a `Record<HarnessFamily, CompileBuilder>` table (mirroring the existing `FOREGROUND_ROUTES` pattern already in this file).
- **Risk:** Low  ·  **Effort:** 2–3 hrs  ·  **Tests:** `compile-runtime-plan.test.ts`, `compiler-broker-profile.test.ts`.

### 5. Introduce a session/registry injection seam — DIP
- **Location:** `client.ts:426`/`:754`/`:772` (`createSession`/`new PiSession`), `run-placement-turn.ts:251`/`:285`, `prepare-cli-runtime.ts:165` (`harnessRegistry.getOrThrow`)
- **Current:** Turn execution hard-depends on concrete `createSession`/`PiSession`/`harnessRegistry`. There is no seam to substitute a fake session, so every turn test must drive real materialization and a real adapter, and the three turn implementations each re-wire the same `onEvent`/`mapUnifiedEvents`/`shouldDrainOutstandingTurn` machinery inline.
- **Suggested:** A `SessionFactory` interface (`createAgentSdkSession`, `createPiSdkSession`) injected through `AgentSpacesClientOptions`, defaulting to the current concretes. Extract the shared `onEvent → mapUnifiedEvents → drain → resolve` wiring into one `driveSessionTurn(session, context, ...)` used by all three turn paths.
- **Risk:** Med (touches the hot turn path)  ·  **Effort:** 1–1.5 days  ·  **Tests:** add fake-session unit tests; keep `execute-embedded-sdk.test.ts`, `phase4-harness-adapter-integration.test.ts` green.

### 6. Segregate `AgentSpacesClient` into role interfaces — ISP
- **Location:** `types.ts:387` `interface AgentSpacesClient` (10 methods)
- **Current:** One interface bundles compile, resolve, describe, capabilities, two build-spec methods, and four turn/in-flight ops. A caller that only compiles plans (e.g. dry-run preview) must accept the whole surface, and any new method widens every implementor/mock.
- **Suggested:** Split into `RuntimeCompiler`, `SpaceResolver`, `InvocationSpecBuilder`, and `TurnExecutor` role interfaces; let `AgentSpacesClient = RuntimeCompiler & SpaceResolver & InvocationSpecBuilder & TurnExecutor` so the public type is unchanged but consumers can depend on the narrow role.
- **Risk:** Low (purely additive type refactor)  ·  **Effort:** 2–3 hrs  ·  **Tests:** typecheck + `m5-public-api-cutover.test.ts`.

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| God file (1,781 LOC, >300 limit) | `compile-runtime-plan.ts` | 🟠 |
| Duplicated builder pair (near-byte-identical) | `compile-runtime-plan.ts:1324` & `:1556` | 🟠 |
| Long method (~240 LOC) | `client.ts:310 runTurnInFlight`, `:619 runTurnNonInteractive` | 🟠 |
| Long method (~390 LOC) + deep nesting (≥5 levels inside promise/try/onEvent) | `run-placement-turn.ts:57 runPlacementTurnNonInteractive` | 🟠 |
| Duplicated failure-emit-and-return block (×9) | `client.ts` & `run-placement-turn.ts` | 🟠 |
| Repeated `as unknown as CompiledRuntimePlan['resolvedBundle']` cast (×5) | `compile-runtime-plan.ts:715,899,1216,1501,1728` | 🟡 |
| Structural duck-typing for `interrupt` (`as { interrupt?: ... }`) | `client.ts:583,609`, also `interruptInFlightTurn` | 🟡 |
| Magic numbers (broker process limits) | `broker-invocation.ts:33` `20_000 / 900_000 / 5_000` | 🟡 |
| Magic string set (provider/driver literals) repeated | `compile-runtime-plan.ts` (`'unknown'`, `'agent-runtime-plan/v1'`, exposure literals) | 🟡 |
| Hardcoded model catalog arrays (drift vs `spaces-config`) | `client-support.ts:23-52` `PI_SDK_MODELS`/`CODEX_CLI_MODELS` | 🟡 |
| Side-effecting `process.stderr.write` inside pure compiler | `compile-runtime-plan.ts:544 emitAspCompileTiming` | 🟡 |
| Empty `catch {}` swallowing cleanup errors (×4) | `client.ts:524,845`, `run-placement-turn.ts:420` | 🟡 |
| Primitive-obsession env maps threaded everywhere (`Record<string,string>` for lockedEnv/dispatchEnv/harnessEnv) | `run-placement-turn.ts:155-194`, `prepare-cli-runtime.ts:269-323` | 🟡 |

## 🚀 Quick Wins (low risk, high value)

1. Extract `failTurn(...)`/`emitTurnFailure(...)` helper (Refactoring #3) — removes ~9 copies, isolates the failure-event contract. Pure mechanical.
2. Collapse `selectsInteractiveClaudeTmuxBroker` + `selectsInteractiveCodexTmuxBroker` into one family-resolving helper (#4 first half) — kills duplicated family-resolution.
3. Lift the repeated `resolvedBundle` cast into one `toResolvedBundle(bundle, bundleIdentity)` helper (5 call sites).
4. Promote `DEFAULT_BROKER_PROCESS_LIMITS` magic numbers (`broker-invocation.ts:33`) to named, documented constants (already partly named — add unit comments / source-of-truth link).
5. Split `AgentSpacesClient` into intersected role interfaces (#6) — additive, typecheck-only.

## ⚠️ Technical Debt Notes

- **Hashes are contract surface.** `planHash`/`profileHash`/`specHash`/`startRequestHash` and the `compatibilityHash` material builders are asserted byte-for-byte by `run-compile-byte-parity.test.ts` and the `smoke:matrix` runner. Any extraction of the plan-assembly tail (#1) MUST preserve field order and the exact `stableId`/`projectionHash` inputs — run `bun run smoke:matrix` before declaring done.
- **Model catalogs duplicated.** `PI_SDK_MODELS`/`CODEX_CLI_MODELS`/`DEFAULT_*` live in `client-support.ts` while `AGENT_SDK_MODELS`/`CLAUDE_CODE_MODELS` are imported from `spaces-config`. The split invites drift; consider sourcing all catalogs from `spaces-config`.
- **`controllerIntent === 'foreground-terminal'` guard is duplicated** across both `selects*` predicates and is descriptive-order-sensitive per the in-file "cody 0B mandate" comment — centralize it when doing #4 to avoid one predicate drifting from the other.
- **Cleanup `catch {}` swallows errors** despite the repo CLAUDE.md rule "`asp run` should never silently capture errors." These are session-stop cleanup paths in failure handlers (arguably acceptable), but they should at minimum log; verify against the project error-handling policy before touching.
- **`testing/` helpers are large** (`pre-hrc-broker-contract-harness.ts` 1,312 LOC, `pre-hrc-interactive-tmux-runner.ts` 972 LOC) but are smoke-harness scaffolding, intentionally excluded from these production findings; they would warrant their own pass if they grow further.

## ✅ Safety Checklist (for whoever applies these)

- [ ] Tests cover the affected code (compile byte-parity + smoke matrix for #1/#4; `client.test.ts`/characterization for #2/#3; embedded-sdk + phase4 for #5)
- [ ] Work on a feature branch; commit current state first
- [ ] Apply one refactoring at a time, run tests between each (`bun run test`, then `bun run typecheck`, then `bun run smoke:matrix` after any compile-plan change)
- [ ] Re-run `bun run check:boundaries` and `bun run check:manifests` (this is a cross-repo boundary package)
- [ ] Confirm `planHash`/`profileHash` are unchanged after #1 (hashes are a published contract)
- [ ] Review the diff before committing

## 🔁 Additional Findings (second pass — 2026-06-01)

These are NEW items not covered by the first pass. The first pass focused on SRP/duplication in the big files and a DIP injection seam; it did not examine `execute-embedded-sdk.ts`, `session-events.ts`, `runtime-env.ts`, `run-tracker.ts`, or `client-materialization.ts` in depth, and it did not analyze the `process.env` overlay concurrency model, the event-emitter ordering, or several edge-case bugs below.

### A1. `process.env` overlay is global and non-reentrant — concurrency race / correctness — HIGH
- **Principle/smell:** Shared-mutable-state race; hidden global side effect.
- **Location:** `runtime-env.ts:10` `applyEnvOverlay`; live call sites `client.ts:418` (in-flight agent-sdk), `client.ts:747` (placement legacy), `run-placement-turn.ts:230`, `execute-embedded-sdk.ts:425`, plus `withAspHome` (`runtime-env.ts:29`) which wraps EVERY public method (`client.ts:116,131,203,311,627`).
- **Why it matters:** `applyEnvOverlay` mutates the singleton `process.env`, snapshots prior values, and returns a `restore()`. In the in-flight path (`client.ts:418→528`) the overlay is held for the ENTIRE lifetime of the turn — `restoreEnv()` only runs in the `finally` after `await completionPromise`. Because the client supports multiple concurrent `hostSessionId`s (the `inFlightRuns` map, the `queueInFlightInput`/`interruptInFlightTurn` ops, and `withAspHome` wrapping concurrent `compileRuntimePlan`/`describeSpace` calls), two overlapping operations interleave their `process.env` writes. The snapshots stack and `restore()` runs in completion order, not LIFO of application — so the later-completing turn restores the *original* value, silently clobbering the still-active earlier turn's `ASP_HOME`/credentials/`PATH`. Embedded-sdk turns are especially exposed: `composeEnv` can inject provider creds into `process.env` that leak into a concurrent unrelated turn.
- **Risk:** High to change (touches the hot turn path and ASP_HOME resolution everywhere)  ·  **Effort:** 1–2 days (thread an explicit env object into session/materialize instead of mutating `process.env`; at minimum serialize overlays or scope them per-call).  ·  **Tests:** add a concurrent two-session unit test that asserts `process.env` is unchanged after interleaved turns; keep `placement-correlation-env.test.ts` green.

### A2. Event emitter swallows downstream `onEvent` errors and serializes via an unbounded promise chain — error handling / leak — MED
- **Principle/smell:** Swallowed exception (violates the repo "never silently capture errors" rule); unbounded promise-chain growth.
- **Location:** `session-events.ts:54-56` in `createEventEmitter`.
- **Why it matters:** `lastEmission = lastEmission.then(() => onEvent(...))` then `void lastEmission.catch(() => {})`. Any throw/rejection from a host `onEvent` callback is silently dropped, and because the catch is attached to the same `lastEmission` reference, a single failing emit also turns the returned promise's rejection into a no-op for the caller while still chaining the next emit off a settled promise. The chain only ever grows (`then` on `then`), so a very long-lived interactive session accumulates a long resolved-promise chain (minor memory) and, more importantly, an `onEvent` consumer error is invisible — the opposite of the project error-handling policy. `idle()` returning `lastEmission` will resolve even though an emit failed.
- **Risk:** Med  ·  **Effort:** 3–4 hrs (surface emit failures to the caller or at least log; consider an explicit queue rather than promise-chaining).  ·  **Tests:** `session-events.test.ts` — add a throwing-`onEvent` case asserting the error is observable.

### A3. `composeEnv` PATH composition reads stale `composed['PATH']` and can re-derive from a wrong base — edge case — MED
- **Principle/smell:** Missing-edge-case handling / subtle precedence bug.
- **Location:** `execute-embedded-sdk.ts:125-129` `composeEnv`.
- **Why it matters:** `basePath = composed['PATH'] ?? process.env['PATH'] ?? ''`. `composed` is `{...lockedEnv, ...dispatchEnv}`. Per the file's own contract comment (lines 122-124) "PATH is never carried inside lockedEnv", yet a `dispatchEnv.PATH` (HRC-mutable channel) would be treated as the base and silently dropped if `pathPrepend` is empty but a different precedence was intended — and when `pathPrepend` is non-empty the function prepends to whichever of lockedEnv/dispatchEnv PATH happened to win, not necessarily the ambient `process.env.PATH` it documents. If neither carries PATH the empty-string fallback `''` produces a trailing `delimiter` is avoided by the `.filter(length>0)`, but the precedence between `dispatchEnv.PATH` and `process.env.PATH` is undocumented and untested.
- **Risk:** Med (PATH controls which `pi`/codex binary is found)  ·  **Effort:** 2 hrs (make the base explicitly `process.env.PATH`, document dispatchEnv.PATH handling).  ·  **Tests:** add `composeEnv` cases for dispatchEnv.PATH + pathPrepend combinations to `execute-embedded-sdk.test.ts`.

### A4. Duplicated `toAgentSpacesError` with divergent behavior — DRY / latent bug — MED
- **Principle/smell:** Shotgun-surgery duplication; the two copies are NOT identical.
- **Location:** `run-tracker.ts:56` and `run-turn-helpers.ts:8` (and a third inlined `toAgentSpacesError` is imported into `client.ts`).
- **Why it matters:** `run-turn-helpers.ts:13` derives the error code from `error instanceof CodedError ? error.code : undefined`; the `run-tracker.ts:58` copy does NOT — it only uses an explicitly passed `code`. So `completeInFlightFailure`/`buildInFlightResponse` (run-tracker) silently lose `CodedError.code` that the helpers version would have preserved. A caller comparing `result.error.code` gets different values depending on which turn path produced the failure. This is a correctness divergence hiding behind identical names, exactly the kind of duplication the first report's #3 was about but for a different (untracked) function.
- **Risk:** Med  ·  **Effort:** 1 hr (delete the run-tracker copy, import the helpers version)  ·  **Tests:** `client.test.ts` — assert `CodedError.code` survives an in-flight failure.

### A5. `executeEmbeddedSdkTurn` env overlay can leak on a synchronous throw before `restoreEnv` is set — resource cleanup — LOW/MED
- **Principle/smell:** Resource-cleanup ordering.
- **Location:** `execute-embedded-sdk.ts:377-488` (`restoreEnv` declared at 378, assigned at 425, restored in `finally` at 487).
- **Why it matters:** The `finally` correctly guards `restoreEnv?.()`. But the overlay is applied at 425 only AFTER `loadBundle` (389) and session construction (420). The bundle load and `createPiSession` run with the UN-overlaid env, while `session.start()`/`sendPrompt` run with it. If pi-sdk reads env at construction time (line 420) rather than at `start()`, the four-channel env contract documented at the top of the file is not actually in force for that phase. The ordering should apply the overlay before any pi-sdk call that may read env. (Not a leak — a contract-timing gap.)
- **Risk:** Low/Med  ·  **Effort:** 1 hr (move `applyEnvOverlay` above `loadBundle`/`createPiSession`)  ·  **Tests:** `execute-embedded-sdk.test.ts` — assert the overlay is active during bundle load.

### A6. `collectTools` does no error handling on malformed MCP JSON — edge case — LOW
- **Principle/smell:** Missing-edge-case handling; unguarded `JSON.parse`.
- **Location:** `client-materialization.ts:281-287` `collectTools`.
- **Why it matters:** `JSON.parse(raw)` on the MCP config throws an opaque `SyntaxError` (no file path, no context) if the file is malformed, surfacing to the user as a bare parse error rather than an actionable "invalid MCP config at <path>". Per the repo policy errors should propagate, which is fine, but a context-wrapping CodedError would be far more useful here and is cheap.
- **Risk:** Low  ·  **Effort:** 30 min  ·  **Tests:** add a malformed-config case.

### A7. `deriveHandleParts` `parseScopeRef` fallback silently masks parse failures — error handling — LOW
- **Principle/smell:** Broad `catch {}` that hides real errors behind a heuristic.
- **Location:** `broker-invocation.ts:53-70`.
- **Why it matters:** A genuine bug in `parseScopeRef` (or a malformed canonical scopeRef) is indistinguishable from "older shorthand caller" and falls into the manual `@`/`:` string-splitting heuristic, producing plausible-but-wrong agentId/projectId/taskId that then flow into broker correlation labels. There is no log/diagnostic on the catch, so a correlation mislabel is invisible. Consider distinguishing "not a canonical ref" from "parse threw unexpectedly".
- **Risk:** Low  ·  **Effort:** 1 hr  ·  **Tests:** `compiler-broker-profile.test.ts` correlation assertions.

### A8. Test gap: no concurrency / multi-session coverage for `inFlightRuns` and env overlays — test gap — MED
- **Principle/smell:** Missing tests for the highest-risk (stateful, global-mutating) paths.
- **Location:** `client.test.ts`, `session-events.test.ts`, `execute-embedded-sdk.test.ts` (absence).
- **Why it matters:** Every existing test drives a single session to completion. There is no test that (a) starts two in-flight runs on different `hostSessionId`s concurrently and asserts env isolation (A1), (b) interleaves `queueInFlightInput`/`interruptInFlightTurn` against a running turn, or (c) asserts emitter ordering/error surfacing under back-pressure (A2). These are precisely the paths most likely to regress under the refactors the first report proposes.
- **Risk:** Med (adds coverage; no source change)  ·  **Effort:** 1 day  ·  **Tests:** new `client-concurrency.test.ts`.
