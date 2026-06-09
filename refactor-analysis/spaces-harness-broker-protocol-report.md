# Refactor analysis — spaces-harness-broker-protocol

Package dir: `packages/harness-broker-protocol`
Package type chosen: **data** (wire-DTO contract + hand-rolled structural validators; no concurrency, no hot path). Tuned the lens toward boundary fidelity, illegal-state encoding, and DE-abstraction of validator structure rather than performance.

## Summary

This package is the JSON-RPC/NDJSON wire contract for the harness broker: DTO type
declarations (`commands.ts`, `events.ts`, `invocation.ts`, `lifecycle.ts`,
`capabilities.ts`) plus a large hand-rolled validator (`schemas.ts`, 1970 LoC) and a
set of already-extracted helper modules (`validation-primitives.ts`, `env-keys.ts`,
`tmux-ids.ts`, `errors.ts`, `jsonrpc.ts`, `ndjson.ts`).

The two prior passes (T-02028, T-02030) are clearly visible and did real work:
- the per-method `switch` is now a `COMMAND_PARAM_VALIDATORS` dispatch table (T19 done);
- the 27-arm event-payload `switch` is now `EVENT_PAYLOAD_VALIDATORS` (T19 done);
- the harness-recovery mode bodies are a `HARNESS_RECOVERY_MODE_VALIDATORS` table (T19 done);
- shared `ProtocolError` / `ProtocolValidationError` bases collapse error-constructor dup (T15 done);
- generic validation primitives, env policy, and tmux-id rules are extracted into
  cohesive modules with intent-documented public-surface preservation (T03/T15 done);
- compile-time exhaustiveness guards (`AssertExhaustive`) close the registry-drift gap;
- magic-number / primitive-obsession fruit (positive-integer, boolean, string-record,
  enum-array helpers) is already factored.

What remains is almost entirely **load-bearing**. This is a **near-clean** target.
I found **one** auto-applicable internal-only item (a dead computed value / unused
seam-return), and **two public-surface observations** that I am deliberately NOT
applying because the package has real external consumers and a type-shape test suite
that pins exact names.

**applicableCount = 1.**

## Public boundary verdict

`index.ts` does `export *` across every module, so the ENTIRE module surface is public.
Two facts make this a hard boundary:

1. `spaces-runtime-contracts` independently mirrors these shapes
   (`BrokerPermissionPolicy` etc.), i.e. there are real cross-package consumers — any
   type rename/reshape is a contract change requiring expand/contract (M02), not a free
   internal edit.
2. `test/inspection-types.test-d.ts` asserts the exact exported alias names
   (`InvocationSnapshotResponse` is "an alias", `InvocationSnapshot` keeps its name).
   Type-level tests will fail on any structural rename.

Verdict: the boundary is **coherent and intentional**. Do not widen/narrow exported
DTOs in an internal pass. The only safe churn is inside the validator internals of
`schemas.ts` and other non-exported functions.

## Findings by mechanism

### Finding 1 — [T16] Dead computed value + unconsumed seam-return in `validateDispatchRuntime`
- **Location**: `src/schemas.ts:1141-1171` (`terminalSurfaceLooksValid`), and the
  boolean return of `validateTerminalSurfaceLease` (`src/schemas.ts:1180-1251`).
- **Mechanism**: T16 collapse premature abstraction / de-abstract.
  `terminalSurfaceLooksValid` is assigned from `validateTerminalSurfaceLease(...)` (line
  1143) but never read — it is only `void`-ed at line 1171 with a comment saying the
  detailed lease issues "already emitted ... cover the rejection." The lease validator's
  doc says the boolean is "for callers that need to know whether downstream tmux drivers
  can rely on the lease," but the *only* caller does not need it. The variation the
  boolean return was designed to serve never materialized.
- **Direction**: DE-abstract. Either (a) call `validateTerminalSurfaceLease(...)` as a
  statement and delete the `terminalSurfaceLooksValid` local + the `void` line, OR (b)
  if you want to keep the boolean as a documented option, leave it but still drop the
  dead local. Minimal change: drop the local assignment and the `void`, keep the
  call. `validateTerminalSurfaceLease` can keep returning `boolean` (it is a private
  function; the return is harmless) OR be narrowed to `void` if you also want to shed
  the unused return — that second step touches only this file's private function.
- **Preservation**: Behavior is byte-identical: the function is called purely for its
  side effect (pushing issues); discarding the return changes nothing observable. Issue
  emission, ordering, and early-return logic are untouched.
- **Risk**: Low. **apiImpact**: internal-only (`validateDispatchRuntime` and
  `validateTerminalSurfaceLease` are both un-exported).
- **Tests**: existing `schemas.test.ts` dispatch-runtime cases cover this path; no test
  reads the discarded boolean, so none need updating. No new lint expected (removing a
  `void`d unused local clears, not creates, a finding).
- **Contraindication checked**: the seam-return is NOT a deliberate defense-in-depth
  signal (no caller consumes it) and NOT diverging-copy duplication. The only argument
  for keeping it is "future caller might want it" — but per the de-abstract rule, remove
  structure whose variation never materialized. If you prefer to preserve the option,
  apply only the dead-local removal (still safe) and leave the return type.

### Finding 2 (OBSERVATION, deferred) — [T16] Unexercised hasher seam `computeHash` in `validateLifecyclePolicyOverlay`
- **Location**: `src/schemas.ts:719-732` (`LifecyclePolicyHasher` type + the
  `computeHash: LifecyclePolicyHasher = lifecyclePolicyHash` parameter).
- **Mechanism**: T16 — a one-instantiation injection seam. Grep confirms the single call
  site (`src/schemas.ts:711`) passes no 4th argument, and no test or other module passes
  one either; the seam defaults to `lifecyclePolicyHash` 100% of the time.
- **Why deferred (not auto-applied)**: This is a judgment call, not a mechanical win.
  The seam is private (internal-only) and Low-risk to remove, BUT the doc comment makes
  an explicit, defensible claim that it exists for test substitution of the crypto
  dependency. That is exactly the documented contraindication: "an unused seam can be a
  deliberate option." Removing it is a behavior-neutral simplification, but it deletes a
  stated testability affordance. I am surfacing it rather than auto-applying so a human
  decides whether the testability option is worth keeping. (It does not meet the
  deferral *trigger* of High-risk/public-surface, so it is recorded here as an
  observation, not in deferredFindings.)
- **Preservation if removed**: identical — the default is the only value ever used.
- **Risk**: Low. **apiImpact**: internal-only.
- **Recommendation**: leave as-is unless the team is actively culling unused seams; the
  cost (one parameter + a type alias) is trivial and the documented intent is coherent.

### Finding 3 (OBSERVATION, deferred) — [T16] Empty interface `LifecyclePolicyAcceptedPayload extends AcceptedLifecyclePolicy {}`
- **Location**: `src/lifecycle.ts:103`.
- **Mechanism**: T16 — an empty-body interface that is a pure rename of another type.
  `biome`/`tslint` families often flag `no-empty-interface`. A `type X = Y` alias would
  be the conventional spelling.
- **Why deferred / left alone**: **public-surface.** `LifecyclePolicyAcceptedPayload` is
  re-exported (events.ts imports it, it appears in the public `InvocationEventPayload`
  union and in `dist/*.d.ts`). Switching `interface extends {}` to `type =` is observably
  equivalent for assignability but (a) changes declaration-merging capability and (b)
  is a public-surface edit on a cross-package contract. Per the boundary verdict, do not
  reshape exported types in an internal pass. The current biome config evidently does not
  flag it (the repo lints clean per recent commit `5965e65`), so there is no active lint
  debt to repay. **Leave alone.**

## Deliberately left alone (with reasons)

- **`SchemaRecord`'s ~150-key optional-`unknown` map (`schemas.ts:66-196`)**: looks like
  a god-type, but it is a deliberate ergonomic device — a single permissive record type
  that lets every hand-rolled validator read `record.someKey` without per-field casts.
  Splitting it per-DTO would multiply types without changing behavior and would fight the
  "one unwrapped record, accumulate issues" validator style. Load-bearing. No action.
- **DTO duplication between `InvocationRuntimeContext.terminalSurface` (commands.ts:140)
  and `TerminalSurfaceReportedPayload` (events.ts:323) and the validator copies in
  tmux-ids/schemas**: these are intentionally-diverging copies (request lease carries
  `allowedOps`; event payload does not; legacy `tmux-session` vs `tmux-pane` arms differ).
  Unifying them would couple request and event evolution. Defense-in-depth + divergence
  contraindication applies. No action.
- **`harness.exited` `exitCode !== null` special-case (schemas.ts:1376-1378)**: this is
  not a smell — it faithfully encodes the `number | null | undefined` DTO (null is a
  legal "no code" value, distinct from undefined). Real reachable guard; keep explicit.
- **Repeated `optionalEnum(..., true)` literal-list arrays across validators**: these are
  the actual protocol enums; folding them into shared constants would add indirection
  without removing real duplication of *intent* (each enum is genuinely distinct). The
  prior passes already extracted the structural helpers; the literals are the data.
- **`validateInputContent` 3-arm `type` conditional (schemas.ts:1643-1654)**: a closed
  3-variant discriminated union with a real `else` rejection arm. Converting to a dispatch
  table would be premature for 3 stable arms with an explicit invalid-literal default.
  Keep the conditional.
- **`v01-removal.red.test.ts` / `inspection-types.test-d.ts`**: these pin the public
  surface — they are the make-safe characterization layer (T40) already in place. No
  new characterization tests needed before the single internal edit.

## Outside-in apply sequence

The boundary is already pinned by `inspection-types.test-d.ts` (type-level) and the
runtime validator tests (`schemas.test.ts`, `lifecycle-hash.test.ts`). No new
make-safe step required for the one internal edit.

1. **(Finding 1, auto-applicable)** In `validateDispatchRuntime`, delete the
   `terminalSurfaceLooksValid` local and its `void` line; call
   `validateTerminalSurfaceLease(...)` as a bare statement when
   `terminalSurfaceRaw !== undefined`. Run `schemas.test.ts` + the dispatch-runtime
   cases. Behavior-identical.
2. **(Findings 2 & 3, do NOT apply)** Leave the `computeHash` seam and the empty
   `LifecyclePolicyAcceptedPayload` interface. Both are either documented options or
   public-surface; surface to the team, do not edit in an internal pass.

No consumers to migrate, no expand/contract needed, no new lint introduced.
