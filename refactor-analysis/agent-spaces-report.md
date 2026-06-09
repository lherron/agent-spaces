# Refactor analysis — `agent-spaces`

packageType: **general** (a compiler/adapter library; single public entrypoint, one real
external consumer in `hrc-runtime`). Read-only mechanism-grounded pass. Analysis only — no source
edited.

## Summary

This package was just hit by two SOLID/code-smell passes (T-02028, T-02030). It shows. The
low-hanging fruit is gone: the magic broker-timeouts are named constants with per-field doc comments
(`broker-invocation.ts:38-49`), the shotgun-surgery failure-emit triple is centralized
(`emitTurnFailure` in `run-turn-helpers.ts`), the `key ? {provider,key} : undefined` ternary is a
helper (`buildContinuationRef` in `client.ts`), the `as unknown as` plan-bundle cast is a single
`toResolvedBundle` helper, and the two interactive tmux compilers were already de-duplicated into one
`compileTmuxBrokerPlan` driven by a `TmuxBrokerDriverConfig` table. The error-handling is disciplined
(no swallowed catches that hide failures; the two empty `catch {}` blocks on `session.stop()` cleanup
are deliberately defensive and commented). Invariants are encoded via discriminated unions
(`completion: {done:false,...} | {done:true}`, `model: {ok:true,info} | {ok:false,modelId}`).

What's left is a small number of genuine, low-value-but-real findings — mostly thin pass-through
indirection — plus one structural observation about the public surface that is a **contract change**
(M02), not a refactor, and is surfaced for a human decision rather than auto-applied.

**3 auto-applicable (Low/Med + internal-only). 1 deferred (public-surface contract change).**

## Public boundary verdict

`package.json` `exports` exposes **only** `./src/index.ts` (`.` → `dist/index.js`); there is no deep
subpath export. The live external consumer is `hrc-runtime/packages/hrc-server`, which imports from the
bare `agent-spaces` specifier exactly: the value `createAgentSpacesClient`, and the types
`RunTurnNonInteractiveRequest/Response`, `BuildProcessInvocationSpecRequest/Response`,
`ProcessInvocationSpec`, `AgentEvent`. `execute-embedded-sdk.ts` and the whole `testing/` tree are
**not** re-exported and (because there is no subpath export) are unreachable to external consumers —
they are internal/test scaffolding despite shipping `.d.ts`.

Verdict: the boundary is **well-shaped and contract-bound**. Interface segregation is already good
(`RuntimeCompiler` / `SpaceResolver` / `InvocationSpecBuilder` / `TurnExecutor` are split, then
intersected into `AgentSpacesClient`). The deprecated fields (`cpSessionId`, legacy `env`) are
correctly retained for back-compat and resolved through `resolveHostSessionId` / the
locked-vs-dispatch split. **Because there is a real external consumer, any change to the re-exported
type/value set is an expand/contract (M02) event — do it additively, never auto-apply.**

The one boundary nit worth a human's eyes: the published `BuildProcessInvocationSpecRequest` still
admits the legacy non-placement shape (`aspHome`/`spec`/`cwd`, no `placement`), and `client.ts`
carries a ~100-line branch (lines 219-318) to serve it — but the live consumer (`cli-adapter.ts:296`)
**always** sets `placement`. The legacy branch is exercised only by in-repo characterization tests.
See deferred finding D1.

## Findings by mechanism

### F1 — Collapse pass-through arrow + thin wrapper layer in the interactive-broker dispatch table
- **Location:** `src/compile-runtime-plan.ts:580-583` (`INTERACTIVE_BROKER_BUILDERS`) +
  `:1435-1449` (`compileClaudeTmuxBrokerPlan` / `compileCodexTmuxBrokerPlan`).
- **Mechanism:** [T23] remove middle man / collapse pass-throughs.
- **Direction:** INWARD collapse. There are three indirection layers for what is one call:
  the table value is an arrow `(req, placement, options) => compileClaudeTmuxBrokerPlan(req, placement, options)`
  whose only job is to forward all args unchanged; the wrapper it calls is itself a one-liner
  `return compileTmuxBrokerPlan(req, placement, CLAUDE_TMUX_DRIVER_CONFIG, options)`. The arrow adds
  nothing (identical arity/types to the function it wraps) and the named wrappers add only the config
  binding. Map the table directly to the config-bound delegate:
  `'claude-code': (req, p, o) => compileTmuxBrokerPlan(req, p, CLAUDE_TMUX_DRIVER_CONFIG, o)` and drop
  the two `compileClaude/CodexTmuxBrokerPlan` wrappers (or keep the wrappers and reference them bare,
  `'claude-code': compileClaudeTmuxBrokerPlan` — the arrow is removable either way since signatures
  match `InteractiveCompileBuilder`).
- **Preservation:** Pure call-graph flattening; the same function runs with the same args, so every
  spec/profile/plan hash is byte-identical. No observable behavior change.
- **Risk:** Low. **apiImpact:** internal-only (module-private table + module-private wrappers).
- **Tests:** `run-compile-byte-parity.test.ts`, `compiler-broker-profile.test.ts` and the
  interactive-broker compile tests should pass unchanged; they assert on plan/profile/spec hashes,
  which are unaffected.
- **Contraindication checked:** the arrows are NOT adapting types or partially applying — they forward
  all three params verbatim, so no contraindication ("wrapper exists to narrow/adapt") applies.

### F2 — `buildTmuxLaunchSpec(prepared)` invoked twice (test-then-use)
- **Location:** `src/compile-runtime-plan.ts:1561-1563`.
- **Mechanism:** [T15] extract missing abstraction (here: bind the computed value once) — a
  compute-twice smell.
- **Direction:** Hoist to a local. `...(buildTmuxLaunchSpec(prepared) !== undefined ? { launch: buildTmuxLaunchSpec(prepared) } : {})`
  calls the builder twice. Bind once: `const launch = buildTmuxLaunchSpec(prepared)` then
  `...(launch !== undefined ? { launch } : {})`.
- **Preservation:** `buildTmuxLaunchSpec` is pure (reads only `prepared.systemPrompt`/`expandedPrompt`,
  allocates a fresh object); calling it once and reusing yields an identical value. Plan/spec hashes
  unchanged. (Note: this matches the established `...(continuation ? {continuation} : {})` style used
  everywhere else in this file, where the value is already bound to a local first.)
- **Risk:** Low. **apiImpact:** internal-only.
- **Tests:** covered by the tmux-broker compile/byte-parity tests; no assertion change.
- **Contraindication checked:** not load-bearing duplication — there is no side effect or
  intentional re-evaluation; it is an accidental double call.

### F3 — Two structurally identical `AgentSpacesClientOptions` definitions
- **Location:** `src/client.ts:117-120` and `src/placement-api.ts:24-27` (identical shape:
  `{ aspHome?; registryPath? }`). `index.ts:42` re-exports the **placement-api** copy.
- **Mechanism:** [T15] extract missing abstraction / collapse duplicated intent (single source of
  truth for a public type).
- **Direction:** Make `placement-api.ts` the canonical definition and have `client.ts` import it
  (`import type { AgentSpacesClientOptions } from './placement-api.js'`) for `createAgentSpacesClient`'s
  parameter, deleting the local `interface`. The exported public identity stays the placement-api one
  (what `index.ts` already re-exports), so the public surface is byte-identical.
- **Preservation:** Structural typing means the two are already interchangeable; collapsing to one
  declaration changes no runtime behavior and no emitted `.d.ts` for the public export. (Direction
  matters: import INTO client.ts, not the reverse — `placement-api.ts` is the file `index.ts` already
  re-exports from, and it has no import from `client.ts`, so no cycle is introduced. client.ts already
  depends on placement-api transitively via prepare-cli-runtime, so a direct type import adds no new
  coupling.)
- **Risk:** Low. **apiImpact:** internal-only (the exported symbol and its shape are unchanged; only
  the second internal declaration is removed).
- **Tests:** `m5-public-api-cutover.test.ts` pins the public export set — should pass unchanged. A
  typecheck is the real gate.
- **Contraindication checked:** these are NOT diverging-on-purpose copies (defense-in-depth) — they are
  the same two-optional-field bag with the same JSDoc intent; no reason for two.

## Deferred findings (surfaced — human decides; NOT auto-applied)

### D1 — Legacy non-placement branch of `buildProcessInvocationSpec` is dead-for-consumers but live-for-contract
- **Location:** `src/client.ts:219-318` (the `withAspHome(...)` branch taken when `req.placement` is
  absent); the matching admissibility lives in the published type `BuildProcessInvocationSpecRequest`
  (`types.ts:188-215`, where `spec`/`aspHome`/`cwd` are required and `placement` optional).
- **Mechanism:** [M02] expand/contract on a public contract + [T16] de-abstract a path whose variation
  no longer materializes.
- **Why deferred (a human must decide):** The **only** live external caller
  (`hrc-runtime .../cli-adapter.ts:296`) ALWAYS sets `placement`, routing to
  `preparePlacementCliRuntime` (client.ts:214-217). The ~100-line legacy branch — including its own
  `validateSpec`, provider/model resolution, adapter detect, `buildRunArgs`, and a separate
  `ProcessInvocationSpec` assembly that partially duplicates `toProcessInvocationSpec` — is reached
  only by in-repo characterization tests. Removing it would shrink `client.ts` meaningfully and delete
  a second, drift-prone copy of the spec-assembly logic. BUT the published request type still permits
  the placement-less shape, so deleting the branch is a **breaking contract change** requiring an
  expand/contract migration (deprecate the legacy fields → confirm no external caller → narrow the
  type → remove). This is a redesign decision, not a behavior-preserving refactor, and it touches the
  external `hrc-runtime` contract. Leave it to the user.
- **Risk:** High (contract change; behavior removal). **apiImpact:** public-surface.
- **If pursued:** characterization tests on the legacy branch
  (`client-process-invocation.characterization.test.ts`) would need to be deleted or rewritten, and the
  `hrc-runtime` consumer-contract test (`agent-spaces-consumer-contracts.test.ts`) re-run to confirm
  nothing depends on the placement-less path.

## Deliberately left alone (pressure-tested, NOT findings)

- **`run-placement-turn.ts` vs `client.ts runTurnNonInteractive` session-setup overlap.** Both build an
  agent-sdk/pi-sdk session and wire `mapUnifiedEvents`. They look duplicative but the placement path
  resolves env via `prepareAgentBrainRuntime`/`prepareAgentToolRuntime` + correlation channels and
  materializes a system prompt, while the legacy path applies a flat `req.env` overlay and no system
  prompt. The shared event-mapping/permission/normalize helpers are *already* extracted into
  `session-events.ts`. Folding the two turn bodies into one would parameterize across two genuinely
  different env/prompt models — a redesign with hash/behavior risk, not a clean dedup. Out of scope.
- **`deriveHandleParts` try/catch shorthand fallback (`broker-invocation.ts:51-104`).** Nesting is deep
  but the `catch` does real recovery (shorthand-handle parsing) and emits a single diagnostic line on a
  genuine parse failure — this is reachable, documented error handling, not a swallowed catch. Leave.
- **`mapUnifiedEvents` type switch (`session-events.ts:88-182`).** A growing-by-feature `switch` is a
  T19 candidate, but each arm is small, the event union is owned upstream
  (`spaces-execution`/UnifiedSessionEvent), and a dispatch table here would just relocate the same
  arms while losing exhaustiveness narrowing. No net structural win; leave.
- **The four near-identical plan-builder tails** (`compileBrokerPlan`, `compileForegroundPlan`,
  `compileEmbeddedSdkPlan`, `compileTmuxBrokerPlan` each assemble `planMaterial` → `projectionHash` →
  `plan`). Tempting T15 extraction, but the bodies differ in `harness.{family,runtime,provider}`,
  `model`, `artifacts`, and which validator runs; a shared builder would need so many parameters
  (parameter-clump) that it would obscure the per-profile hash inputs the byte-parity tests pin. The
  shared sub-helpers (`toResolvedBundle`, `toCompiledPlacement`, `projectionHash`, `stableId`,
  `disallowedToolsUnsupportedDiagnostic`) are already extracted — that's the right granularity. Leave.
- **`FRONTEND_PROVIDER_MAP` (placement-api) vs `FRONTEND_DEFS` provider (client-support).** Two
  frontend→provider lookups, but one is the public placement-API helper surface (string-keyed,
  returns) and the other is the internal catalog-backed `FrontendDef` (throws via `CodedError`). They
  serve different callers with different error contracts; unifying would couple the public helper to the
  catalog. Leave.
- **Magic numbers / dup intent across the package** — re-verified as already addressed by the prior
  passes (named broker constants, `resolveRunId`/`resolveHostSessionId`, `buildContinuationRef`,
  `emitTurnFailure`). No stale magic-number findings to file.

## Outside-in apply sequence (for the apply phase)

1. **[T40] make-safe first.** The byte-parity and public-API tests are the characterization net:
   `run-compile-byte-parity.test.ts`, `m5-public-api-cutover.test.ts`, `compiler-broker-profile.test.ts`,
   `client.test.ts`. Run them green before touching anything. (No new characterization tests needed —
   coverage already pins hashes and the export set.)
2. **F3** (collapse duplicate `AgentSpacesClientOptions`) — pure type move; gated by `tsc`/biome and the
   public-API test.
3. **F1** (flatten the interactive-broker dispatch indirection) — gated by the compile byte-parity tests.
4. **F2** (bind `buildTmuxLaunchSpec` once) — gated by the tmux-broker compile tests.
5. Re-run the full suite + biome. None of F1-F3 should change a single hash assertion; if one does, that
   is a real regression, stop.
6. **D1 is NOT in this sequence** — it is a contract decision for the user, requiring an
   expand/contract migration coordinated with `hrc-runtime`.
