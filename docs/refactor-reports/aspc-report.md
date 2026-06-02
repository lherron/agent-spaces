# 🔧 Refactoring Analysis

**Target:** `packages/aspc/src` (package `spaces-aspc`)
**Lines analyzed:** 519 (service.ts 265, facade.ts 146, client.ts 78, cli.ts 24, index.ts 6)
**Generated:** 2026-06-01  ·  **Focus:** all

## Overview

`spaces-aspc` is a small, well-factored package: a JSON-RPC service (`service.ts`),
a stdio facade/protocol server wiring (`facade.ts`), a client (`client.ts`), a thin
CLI entry (`cli.ts`), and barrel (`index.ts`). It already applies dependency
injection in the right places (`AspcServiceOptions.{broker,compiler}`,
`AspcFacadeOptions`). No file exceeds 300 lines, no function exceeds 50 lines, no
deep nesting (≥16-space indent grep returned nothing), and no long parameter lists
(>4) were detected. Findings below are modest and mostly maintainability-oriented;
none are critical.

## 📊 SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| Single Responsibility | 🟢 | Clean separation across files; `service.ts` is the only file mixing several response-shape builders, but functions stay small. |
| Open/Closed | 🟡 | `selectBrokerProfile` filters via a chain of sequential `if (selector?.x)` blocks; each new selector key requires editing the function. `cli.ts` command dispatch is a small `if`-chain. |
| Liskov Substitution | 🟢 | No inheritance hierarchies or overrides; interfaces implemented by factory closures. No throwing/no-op overrides found. |
| Interface Segregation | 🟢 | `AspcService` (4 methods) and `AspcClient` are appropriately scoped. No fat interfaces (>10 members). |
| Dependency Inversion | 🟡 | Mostly good (injected `broker`/`compiler`). Weak spot: the broker-method registrations in `facade.ts` cast `params as Parameters<typeof broker.x>[0]`, bypassing the validated-type seam and coupling the facade to the broker's positional signatures. |

## 🎯 Priority Refactorings

### 1. Selector matching is not open for extension — Open/Closed
- **Location:** `packages/aspc/src/service.ts:175-228` (`selectBrokerProfile`)
- **Current:** Three hand-written sequential filters (`profileId`, `profileHash`,
  `brokerDriver`), each gated on `selector?.x !== undefined`. Adding a new selector
  dimension means editing this body, and the three blocks are near-identical.
- **Suggested:** Drive matching from a small table of
  `{ key, profileField }` predicates and `reduce` the profile list through them, so
  new selector keys are added by appending one entry. Keep the ambiguous/missing
  diagnostics as-is.
- **Risk:** Low  ·  **Effort:** ~20 min  ·  **Tests:** add selector-matrix cases
  (single match, zero match → `broker_profile_missing`, multi match →
  `broker_profile_ambiguous`) in `test/facade.test.ts` or a new `service.test.ts`.

### 2. Typed-cast broker dispatch bypasses the validation seam — Dependency Inversion / type safety
- **Location:** `packages/aspc/src/facade.ts:96-146` (`registerBrokerMethods`)
- **Current:** Each handler validates with `validateCommand(...)` then immediately
  casts `params as Parameters<typeof broker.X>[0]` (and `params as InvocationDispatchRequest`
  for `invocation.start`). The cast discards the validated/narrowed type and ties the
  facade to the broker's positional argument order.
- **Suggested:** Have the per-method `validate*` functions (or a typed registry map
  of `method → { validate, invoke }`) return the narrowed param type so handlers pass
  validated values instead of `as`-casting. This also removes the 7 near-duplicate
  `server.register(...) { validateParams(...); return broker.X(params as ...) }` blocks
  in favor of one table-driven loop.
- **Risk:** Med (touches every broker RPC route; behavior must stay byte-identical)
  ·  **Effort:** ~45 min  ·  **Tests:** the harness-broker MATRIX smoke
  (`bun run smoke:matrix --config fake-codex`) plus existing `facade.test.ts` must pass
  unchanged.

### 3. Duplicated failure-response construction — Code smell (DRY)
- **Location:** `packages/aspc/src/service.ts:81-88, 138-160` and the diagnostic
  helpers at `:246-265`
- **Current:** `compileHarnessInvocation` and `compileAndStart` each assemble an
  `ok: false` response with `schemaVersion`, `compile/compileResponse`, and
  `diagnostics`. The not-ok branch at `:147-160` also rebuilds a synthetic
  `agent-runtime-compile-response/v1` inline.
- **Suggested:** Extract small builders (`failHarnessInvocation(diagnostics)`,
  `failCompileAndStart(compile)`) so the literal `schemaVersion` strings and
  response shapes live in one place per schema version.
- **Risk:** Low  ·  **Effort:** ~15 min  ·  **Tests:** assert error-path schema
  versions and diagnostic propagation.

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| Repeated `params as Parameters<typeof broker.X>[0]` casts (7×) lose type safety | `service`… `facade.ts:103,108,113,124,129,134,139,144` | 🟠 |
| 7 near-identical `server.register(...)` broker handlers (boilerplate) | `facade.ts:101-145` | 🟡 |
| Sequential near-duplicate `if (selector?.x) profiles = profiles.filter(...)` blocks | `service.ts:182-190` | 🟡 |
| Inline `as { dispatchEnv?: ... }` structural cast on `placement` | `service.ts:234-236` | 🟡 |
| Duplicated `ok: false` response literals across two methods | `service.ts:81-88, 138-159` | 🟡 |
| Two version constants (`ASPC_FACADE_VERSION='0.1.0'` vs package.json `0.1.1`) risk drift | `service.ts:21` | 🟡 |
| `process.exit(0/1)` scattered in entry points (acceptable for CLI, but untestable) | `cli.ts:12,21`, `facade.ts:91` | 🟡 |
| Empty `validateParams(method,id,params)` wrapper ignores `method`/`id` beyond passthrough | `facade.ts:97-99` | 🟡 |

## 🚀 Quick Wins (low risk, high value)

1. Extract the three failure-response builders in `service.ts` (Refactoring #3) — pure
   internal helpers, no public surface change.
2. Replace the 7 broker `server.register` blocks with a single table-driven loop
   (`facade.ts`) to remove boilerplate; keep validation per method.
3. Source `ASPC_FACADE_VERSION` from `package.json` (or a single shared constant) to
   prevent the `0.1.0` / `0.1.1` drift surfaced in `aspc.hello`.
4. Add a dedicated `service.test.ts` covering `selectBrokerProfile` (zero/one/ambiguous
   matches) and `compileRuntimePlanSafe`'s `compiler_exception` path — these branches
   carry user-facing diagnostics yet aren't exercised by `facade.test.ts`.

## ⚠️ Technical Debt Notes

- The facade still registers `invocation.permission.request` via the legacy
  request channel (`facade.ts:49`). Per repo notes the broker MATRIX smoke now
  rejects `invocation.permission.request` unless `--allow-legacy-permission-event`
  is passed; confirm this facade's permission wiring is on the supported path before
  any HRC cutover.
- `buildDispatchRequest` reaches into `req.compileRequest.placement.dispatchEnv` via a
  structural cast (`service.ts:234-236`); the protocol type for `placement` apparently
  doesn't expose `dispatchEnv`. Tightening the `spaces-runtime-contracts` /
  `spaces-aspc-protocol` type to include it would remove the cast and make the
  precedence (`req.dispatchEnv ?? placementDispatchEnv`) type-checked.
- `AspcClient.request<T>` is an untyped escape hatch (`client.ts:63-65`) used for
  broker passthrough RPCs; acceptable, but document that responses are unvalidated on
  the client side.

## ✅ Safety Checklist (for whoever applies these)

- [ ] Tests cover the affected code (add `selectBrokerProfile` + error-path coverage first)
- [ ] Work on a feature branch; commit current state first
- [ ] Apply one refactoring at a time, run tests between each (`bun test packages/aspc/test`)
- [ ] Run the broker MATRIX smoke after touching `facade.ts` routing (`bun run smoke:matrix --config fake-codex`)
- [ ] Typecheck (`bun run typecheck`) after removing `as` casts to confirm narrowing holds
- [ ] Review the diff before committing

## 🔁 Additional Findings (second pass — 2026-06-01)

These are NEW items not covered by the first pass. They skew toward error-handling,
async/resource-cleanup correctness, and contract-surface gaps — the categories a
first structural pass typically under-weights.

### A1. `server.start()` rejection is swallowed; facade can hang or die on unhandledRejection — Error handling
- **Principle/smell:** Swallowed exception / missing async error path.
- **Location:** `packages/aspc/src/facade.ts:87` (`void server.start()`)
- **Detail:** `runAspcFacadeStdio` fires `void server.start()` with no `.catch(...)`.
  If `start()` rejects (e.g. transport setup fails), the rejection is unobserved.
  The *only* clean-exit path is the `stdin 'end'` handler at `:89`, which never
  fires on a start failure, so the process either hangs or terminates via Node's
  unhandledRejection with a non-deterministic exit code. The repo's own rule
  (`CLAUDE.md`: "`asp run` should never silently capture errors … exit immediately")
  is violated by dropping this promise.
- **Risk:** Med (changes process lifecycle) · **Effort:** ~15 min · **Tests:**
  add a facade test injecting a `start()` that rejects and assert non-zero exit /
  surfaced error.

### A2. `compileAndStart` lets `broker.start` throw raw — inconsistent contract surface — Error handling / API contract
- **Principle/smell:** Inconsistent error channel; leaky abstraction.
- **Location:** `packages/aspc/src/service.ts:91-96`
- **Detail:** The compile half of `compileAndStart` returns a structured
  `{ ok:false, compile, diagnostics }` envelope (`:81-88`), but the start half awaits
  `broker.start(...)` with no try/catch. A broker-side failure therefore propagates as
  a raw JSON-RPC error to the caller, so the *same method* reports compile failures as
  a 200-style `ok:false` body and start failures as a transport-level fault. Callers
  must handle two different failure shapes for one call. Either wrap start failures into
  an `ok:false` envelope (e.g. `{ ok:false, compile, startError }`) or document that
  start failures are out-of-band — but it should be one consistent contract.
- **Risk:** Med (defines a new failure shape) · **Effort:** ~30 min · **Tests:**
  add a case with an injected broker whose `start` rejects; assert the documented shape.

### A3. `AspcClient` has no subprocess-liveness wiring — pending requests hang forever on facade death — Async/resource correctness
- **Principle/smell:** Missing edge-case handling; resource/liveness gap.
- **Location:** `packages/aspc/src/client.ts:18-78` (whole class)
- **Detail:** The client wires `onNotification`/`onRequest` but never observes the
  underlying transport/subprocess *closing*. If the facade child process exits or the
  stdio pipe breaks, any in-flight `request(...)` promise (e.g. `compileAndStart`, which
  can be long-running) is left pending with no rejection and no timeout, and there is no
  `onClose`/`onError` hook for the host to learn the facade died. This is the classic
  "lost-promise on peer death" hang. Expose a close/error callback and reject outstanding
  requests when the transport ends.
- **Risk:** Med · **Effort:** ~30-45 min (depends on `StdioTransport` surface) ·
  **Tests:** start a facade, kill the child, assert the pending request rejects.

### A4. `hello` ignores the client's requested `protocolVersions` — no negotiation/rejection — API contract gap
- **Principle/smell:** Dead parameter / missing validation; contract gap.
- **Location:** `packages/aspc/src/service.ts:47` (`hello(_req)`)
- **Detail:** The handler discards `_req` entirely and unconditionally answers with its
  own `ASPC_PROTOCOL_VERSION`. A client that advertises only versions the facade does
  *not* speak still receives a success response, so version mismatches surface as
  confusing downstream failures instead of a clean negotiation error. At minimum, check
  `req.protocolVersions` includes `ASPC_PROTOCOL_VERSION` and return an explicit
  incompatibility result when it does not. (First pass noted only the `0.1.0/0.1.1`
  facade-version drift, not the dropped protocol-version negotiation.)
- **Risk:** Low · **Effort:** ~20 min · **Tests:** assert hello with an unsupported
  `protocolVersions` is rejected/flagged.

### A5. Dead defensive branch in `selectBrokerProfile` can misroute the diagnostic — Dead code / correctness
- **Principle/smell:** Unreachable guard that, if reachable, returns the wrong error.
- **Location:** `packages/aspc/src/service.ts:192-211`
- **Detail:** When `profiles.length === 1` the code does `const profile = profiles[0]`
  then `if (profile !== undefined) return { ok:true, profile }`. With length === 1,
  `profiles[0]` is never `undefined`, so the guard is dead code. Worse, if it somehow
  *were* undefined, control falls through to the `length === 0` branch (`:199`) and
  reports `broker_profile_missing` even though exactly one profile matched — a wrong
  diagnostic. Drop the redundant guard (rely on the length check) so the single-match
  path can't fall through. The first pass flagged the *filter chain* (O/C) but not this
  control-flow hazard.
- **Risk:** Low · **Effort:** ~5 min · **Tests:** the existing single-match selector
  test already guards the happy path; add an assertion that length===1 always returns ok.

### A6. `onRequest`/`onNotification` are silent last-writer-wins setters — API contract smell
- **Principle/smell:** Hidden mutable singleton handler; surprising overwrite.
- **Location:** `packages/aspc/src/client.ts:67-73`
- **Detail:** Both setters overwrite any previously registered handler with no warning,
  no return of the prior handler, and no "already registered" guard. A second caller
  silently disables the first (e.g. two host modules each wiring permission handling).
  Either document single-registration explicitly, throw on double-register, or move to an
  add/remove listener model. Low-severity but a real foot-gun on the public client surface.
- **Risk:** Low · **Effort:** ~15 min · **Tests:** assert double-register behavior is
  intentional (throw or documented overwrite).

### A7. `runAspcFacadeStdio` close path swallows `close()` rejection — Error handling
- **Principle/smell:** Swallowed exception in cleanup.
- **Location:** `packages/aspc/src/facade.ts:89-93`
- **Detail:** On `stdin 'end'`, `void server.close().then(() => process.exit(0))` has no
  `.catch`. If `close()` rejects, the `.then` never runs, `process.exit(0)` is skipped,
  and the failure is an unhandledRejection — the process may hang instead of exiting.
  Add a `.catch` that logs to stderr and `process.exit(1)`. (Distinct from A1, which is
  the start path.)
- **Risk:** Low · **Effort:** ~10 min · **Tests:** facade test with a `close()` that
  rejects asserting a non-zero exit.

### A8. Test coverage gap: no failure-path or unit-level service tests — Test gap
- **Principle/smell:** Missing-edge-case test coverage.
- **Location:** `packages/aspc/test/facade.test.ts` (entire suite is happy-path E2E)
- **Detail:** Every test drives the real subprocess facade and asserts the `ok:true`
  branch. Untested: `compileRuntimePlanSafe`'s `compiler_exception` path (`service.ts:122-130`),
  `broker_profile_missing` / `broker_profile_ambiguous` (`:199-227`), the `compile.ok===false`
  short-circuit in `compileAndStart` (`:81-88`), `compileAndStart` with no broker throwing
  the "requires a co-hosted broker" error (`:76-78`), and the CLI's bad-transport / bad-command
  exits (`cli.ts:11,21`). These are the exact branches carrying user-facing diagnostics. A
  `service.test.ts` using injected `compiler`/`broker` stubs would cover them without a
  subprocess. (First pass mentioned a selector test in passing; this expands the concrete
  uncovered branch list.)
- **Risk:** Low (test-only) · **Effort:** ~45 min · **Tests:** the new file itself.
