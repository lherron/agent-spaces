# 🔧 Refactoring Analysis — spaces-harness-pi-sdk

**Target:** `packages/harness-pi-sdk/src`  ·  **Files read:** 14 source (+5 test for contracts)  ·  **Lines:** ~1430 non-test
**Generated:** 2026-06-14  ·  **Package type:** leaf (harness adapter + in-process session + standalone runner)

## 🧭 Summary
The package is internally well-factored: shared bundle machinery (`hook-runtime`, `manifest-loading`, `sdk-entry`, `bundle-manifest-types`) was deliberately extracted to a single source of truth, and the event-mapping core is pure + heavily tested. The two real structural defects are at the boundary: (1) the adapter re-declares the canonical bundle-manifest type family privately, defeating the single-source-of-truth it was created to enforce; (2) `PiSessionConfig`/`PiSessionStartOptions` advertise extensions/skills/contextFiles/systemPrompt that `PiSession` never consumes — leaky public surface that `register.ts` faithfully wires into a dead end.

## 🚪 Public boundary (assess first)
- **API surface (index.ts):** `PiSdkAdapter`, `piSdkAdapter`, `register`, plus the whole `pi-session/index.ts` re-export wall: `PiSession`, `createPermissionHook`, `loadPiSdkBundle`, a passthrough re-export of 8 `@mariozechner/pi-coding-agent` symbols, and types `PiSessionConfig`, `PiSessionStartOptions`, `PiSessionState`, `PiAgentSessionEvent`, `PiHookEventBusAdapter`, `HookPermissionResponse`, bundle types, and 4 re-exported SDK types. Also exported from `pi-session.ts` (via `export *`): `mapPiEventToUnified`, `createPiEventMappingState`, `PiEventMappingState`.
- **Findings:** The config/start-options type advertise capabilities the implementation drops (T07, below). The `export *` from `@mariozechner/pi-coding-agent` widens this package's API to re-export a third-party surface verbatim (Hyrum risk if pi renames a symbol).
- **Verdict:** 🟡 needs care — the loaders/runtime are sound; the session config contract overstates what is honored.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### 1. Adapter privately re-declares the canonical bundle-manifest type family — [T15] Extract missing abstraction / [T16] collapse premature duplicate
- **Location:** `adapters/pi-sdk-adapter.ts:66-93` (`PiSdkBundleExtensionEntry`, `PiSdkBundleContextEntry`, `PiSdkBundleHookEntry`, `PiSdkBundleManifest`)
- **Mechanism repaired:** A named concept (the `bundle.json` shape) has a designated single source of truth in `pi-session/bundle-manifest-types.ts` — whose doc comment explicitly says "previously existed as near-identical copies in four sites; this is the single source of truth." The adapter, the *producer* of `bundle.json`, reintroduces a fifth private copy, so producer and consumer types can silently drift.
- **Symptom that flagged it:** Two definitions of `PiSdkBundleManifest`; the local one is *stricter* (`schemaVersion: 1`, `harnessId: 'pi-sdk'`, required `contextFiles`/`hooks`) than the canonical one (`schemaVersion: number`, optional `contextFiles?`/`hooks?`).
- **Current → Suggested:** Import the canonical types; keep the literal narrowing locally with `satisfies`/a `const`-asserted literal where the producer wants `schemaVersion: 1` rather than redefining the interfaces. Net: producer object is type-checked against the same shape the loaders read.
- **Direction:** remove (de-dup) + relocate (consume canonical)
- **Preservation:** type/compiler-proof — JSON emitted is unchanged; only the compile-time type backing the literal changes. `composeTarget` already builds the exact superset of fields the canonical type requires.
- **Falsifiable signal:** `tsc` passes after the swap; `bundle.json` byte output in a `composeTarget` golden test is identical.
- **Risk:** Low  ·  **API-impact:** internal-only (these 4 interfaces are NOT exported from the adapter)  ·  **Effort:** S
- **Tests:** existing adapter tests + a `JSON.stringify` shape assertion on `composeTarget` output.
- **Contraindication:** if the producer *intends* a stricter local contract than consumers tolerate, keep it as a `satisfies CanonicalManifest` narrowing rather than a parallel interface — do not just delete and re-add.

### 2. `PiSessionConfig`/`PiSessionStartOptions` advertise unconsumed capabilities — [T07] Align interface to actual usage
- **Location:** `pi-session/types.ts:35-61` (config: `extensions`, `skills`, `contextFiles`, `systemPrompt`, `additionalExtensionPaths`; start-options: `skills`, `extensions`, `contextFiles`); wired-but-dropped in `register.ts:19-23`; never read in `pi-session.ts` (verified — `config.` accesses are only ownerId/cwd/model/provider/thinkingLevel/persistSessions/sessionPath/sessionId/agentDir/globalAgentDir/hookEventBus/onEvent).
- **Mechanism repaired:** The public type promises inputs the implementation silently discards. `start()` builds `sessionOptions` for `createAgentSession` from cwd/thinkingLevel/auth/model only — extensions/skills/contextFiles never reach the SDK. Callers (register.ts) build the forwarding ceremony for fields that evaporate.
- **Symptom that flagged it:** `register.ts` conditionally spreads `extensions`/`skills`/`contextFiles` into the config; grep shows zero reads of those fields in `pi-session.ts`.
- **Current → Suggested:** Decide intent. If the in-process `PiSession` is meant to accept these (the bundle/runner path already does extensions/skills/contextFiles), wire them into `sessionOptions` — that is a **redesign** (adds behavior). If not, **contract** the type: remove the dead fields via Expand/Contract (deprecate → drop), and remove the dead forwarding in `register.ts`.
- **Direction:** remove (if dead) | add (if intended) — flag as REDESIGN either way because both change the observable config contract.
- **Preservation:** NOT behavior-preserving — wiring them changes what the SDK receives; removing them narrows a public type. Must route through Expand/Contract (M02).
- **Falsifiable signal:** a test that constructs `PiSession` with `extensions:[fn]` and asserts the SDK received them currently FAILS (proving the drop).
- **Risk:** High  ·  **API-impact:** public-surface  ·  **Effort:** M (decision + wiring or deprecation cycle)
- **Tests:** characterization test pinning current "dropped" behavior first, then a redesign test.
- **Contraindication:** these fields may be a forward-declared option the bundle path fills elsewhere; confirm no other consumer reads them before deleting.

### 3. `export *` from `@mariozechner/pi-coding-agent` widens this package's API to a third party — [T07] narrow the leaky / [T16]
- **Location:** `pi-session/index.ts:4-13` (re-exports `AuthStorage`, `ModelRegistry`, `createCodingTools`, `createEventBus`, `createExtensionRuntime`, `discoverAndLoadExtensions`, `loadSkills`, `SettingsManager`) and `:22-27` (4 SDK types).
- **Mechanism repaired:** Re-exporting a vendor's runtime surface verbatim makes `spaces-harness-pi-sdk`'s public API a mirror of pi's; a pi rename/removal becomes a breaking change here (Hyrum's Law on a surface this package doesn't own).
- **Symptom that flagged it:** index re-exports 8 vendor *values* (not just types) that consumers could import from pi directly.
- **Current → Suggested:** Audit which of these are actually imported by sibling packages from `spaces-harness-pi-sdk` vs directly from pi. Re-export only what sibling packages genuinely depend on through this seam; drop the rest via Expand/Contract.
- **Direction:** remove / narrow
- **Preservation:** NOT preserving for removed symbols — narrows public surface. Expand/Contract required.
- **Falsifiable signal:** `grep` across the monorepo for `from 'spaces-harness-pi-sdk'` importing each symbol; unused ones are safe-after-deprecation.
- **Risk:** Med  ·  **API-impact:** public-surface  ·  **Effort:** M (cross-package usage audit)
- **Contraindication:** if this package is the *intended* single import facade for pi (so consumers never depend on `@mariozechner/...` directly), the re-export is deliberate — keep it and document the facade role instead.

### 4. Runner duplicates `ExtensionFactory` type and raw pi-lifecycle event literals — [T15] Extract missing abstraction
- **Location:** `pi-sdk/pi-sdk/runner.ts:37` (`type ExtensionFactory = (pi: ExtensionApi) => void | Promise<void>`) and `:145-182` (raw `'session_start'`, `'turn_start'`, `'turn_end'`, `'tool_call'`, `'tool_result'`, `'session_shutdown'`).
- **Mechanism repaired:** `hook-runtime.ts` already centralizes these lifecycle names in the module-private `PI_LIFECYCLE_EVENT` const (`:29-34`) precisely to avoid scattered string literals; the runner's verbose extension re-hardcodes the same six strings, and `permission-hook.ts:20` repeats `'tool_call'` too. The concept "pi lifecycle event name" is named once but used un-named in three more places.
- **Symptom that flagged it:** identical lifecycle strings appear in `hook-runtime.ts`, `runner.ts`, and `permission-hook.ts`; the comment on `event-types.ts` and `PI_LIFECYCLE_EVENT` both state the centralization intent.
- **Current → Suggested:** Export `PI_LIFECYCLE_EVENT` from `hook-runtime.ts` (or a small shared module) and reference it from the runner's verbose extension and from `permission-hook.ts`. Export a single `ExtensionApiFactory`/`ExtensionFactory` alias rather than re-declaring it in the runner.
- **Direction:** relocate (export the existing const) + remove (the runner's parallel type)
- **Preservation:** type/compiler-proof — the literal values are identical, so runtime `pi.on(...)` registration is unchanged; this is a pure name substitution.
- **Falsifiable signal:** `tsc` passes; the runner's `pi.on` arguments resolve to the same string constants (assert `PI_LIFECYCLE_EVENT.TOOL_CALL === 'tool_call'`).
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** S
- **Tests:** existing runner/parseArgs tests; no behavior assertion changes.
- **Contraindication:** the verbose extension also listens to `turn_start`/`turn_end` which are NOT in `HOOK_RUNTIME_EVENT`; only `PI_LIFECYCLE_EVENT` covers all six, so map against that const, not the hook-event one.

### 5. Two near-identical manifest-load-and-validate paths (`loadBundleManifest` vs adapter `loadTargetBundle`) — [T15]/[T23]
- **Location:** `adapters/pi-sdk-adapter.ts:630-671` (`loadTargetBundle`) vs `pi-session/hook-runtime.ts:58-72` (`loadBundleManifest`).
- **Mechanism repaired:** Both read `bundle.json`, JSON-parse, and validate `harnessId === 'pi-sdk'`; the adapter version additionally maps to a `ComposedTargetBundle`. The validation intent (parse + assert harness) is duplicated with subtly different error messages and the adapter version omits the `schemaVersion` check the runtime path enforces.
- **Symptom that flagged it:** two `harnessId !== 'pi-sdk'` guards with different error strings; only `loadBundleManifest` checks `schemaVersion`.
- **Current → Suggested:** Have `loadTargetBundle` call `loadBundleManifest` for the parse+validate step, then map the result to `ComposedTargetBundle`. Unifies validation (closes the missing schemaVersion check in the adapter) and removes a divergent error-message copy.
- **Direction:** remove (collapse duplicate validation) + relocate (reuse shared loader)
- **Preservation:** observational-equivalence with a CAVEAT — error *message text* changes and the adapter would start enforcing `schemaVersion`. The latter is a behavior change (stricter). Treat the schemaVersion tightening as redesign; the message change is low-risk if no test asserts exact text.
- **Falsifiable signal:** test `loadTargetBundle` on a bundle with wrong `schemaVersion` — currently passes, would throw after unification.
- **Risk:** Med  ·  **API-impact:** internal-only (method is public on the adapter but error semantics are internal contract)  ·  **Effort:** S-M
- **Contraindication:** the adapter may intentionally be lenient on schemaVersion to load forward-compatible bundles; confirm before tightening — if so, only share the parse+harness check, not the version check.

### 6. `PiSessionState` carries `'error'` as a terminal-ish state with no recovery edges — [T10] Reify implicit state machine
- **Location:** `pi-session/pi-session.ts:71,93-96,131,136,146,155,160,179` + `types.ts:16`.
- **Mechanism repaired:** State transitions are managed by scattered `this.state = ...` assignments and guard strings (`Cannot start session in state: ${this.state}`, `Cannot send prompt in state: ${this.state}`). `'error'` is set on start failure but never has a defined transition out; `start()` only guards `!== 'idle'`, so an errored session can never restart (correct) but a streaming/running session hitting an error in `sendPrompt` resets to `'running'` (the catch rethrows but `finally` sets `running`), never to `'error'`. The legal transitions live only in the throw-guards.
- **Symptom that flagged it:** 5-value union mutated at 8 sites; inconsistent error handling (start→error, sendPrompt→stays running on throw).
- **Current → Suggested:** This is borderline — the machine is small. A light touch: document the transition table and make the `sendPrompt` failure path consistent (either error-state or explicitly running by design). Do NOT over-engineer into a state-machine class; the current shape is readable.
- **Direction:** isolate (centralize transition guards) — low priority
- **Preservation:** char-test — pin current observable transitions before touching; the sendPrompt-stays-running behavior may be intentional (transient prompt failure shouldn't kill the session).
- **Falsifiable signal:** test: prompt throws → `getState()` returns `'running'` (current) — any change here is observable.
- **Risk:** Med  ·  **API-impact:** internal-only (`getState()` is public; values are observable)  ·  **Effort:** M
- **Contraindication:** the divergent error handling (start kills, prompt survives) is plausibly deliberate; do not unify into a single rule without confirming intent. Likely leave alone.

### 7. `materializeSpace` is a long arrow-shaped method mixing concerns — [T03]/[T22]
- **Location:** `adapters/pi-sdk-adapter.ts:261-351` (~90 lines: rm/mkdir, manifest-pi cast, bundle extensions, copy skills, copy hooks, resolve instruction).
- **Mechanism repaired:** Low cohesion + nesting in one method; the per-resource blocks (extensions / skills / hooks / context) are independent and already mirror the well-factored `composeTarget` which delegates to `mergeArtifact*` privates. `materializeSpace` does not follow that established pattern.
- **Symptom that flagged it:** four sequential copy-and-collect blocks inline; the sibling method `composeTarget` already extracted the analogous blocks.
- **Current → Suggested:** Extract `materializeExtensions`, `materializeSkills`, `materializeHooks`, `materializeContext` privates mirroring `mergeArtifact*`, accumulating into `files`/`warnings`. Pure mechanical extraction.
- **Direction:** relocate (extract by affinity)
- **Preservation:** observational-equivalence — same FS operations in same order; extraction only.
- **Falsifiable signal:** `materializeSpace` integration test produces identical `files`/`warnings` arrays.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** S-M
- **Contraindication:** none significant; keep the outer try/catch cleanup (`rm` on failure) at the top level so partial-extraction cleanup semantics are preserved.

### 8. `manifestWithPi` inline structural cast for `pi.build` options — [T12] make illegal states / [T07]
- **Location:** `adapters/pi-sdk-adapter.ts:275-288`.
- **Mechanism repaired:** `input.manifest` is cast inline to `typeof input.manifest & { pi?: { build?: {...} } }` to read build options — the `pi.build` shape is an implicit, untyped extension of `ProjectManifest`. Same `format/target/external` triple already exists as the named `ExtensionBuildOptions` in `pi-bundle.ts`.
- **Symptom that flagged it:** an ad-hoc intersection cast re-spelling the `ExtensionBuildOptions` fields.
- **Current → Suggested:** Name the manifest extension once (e.g. `interface PiManifestExtension { pi?: { build?: ExtensionBuildOptions } }`) and reuse `ExtensionBuildOptions` for the inner shape so producer and `bundleExtension` consumer share one type.
- **Direction:** isolate (name the implicit shape) + remove (the duplicated field triple)
- **Preservation:** type/compiler-proof — runtime read of `manifest.pi.build.*` is unchanged.
- **Falsifiable signal:** `tsc` passes; a manifest with `pi.build` flows the same values into `bundleExtension`.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** S
- **Contraindication:** if `ProjectManifest` already (or should) declare `pi` upstream in `spaces-config`, prefer adding it there over a local cast — but that is a cross-package change, so keep local for the internal-only pass.

## 🪶 Deliberately left alone (where-NOT)
- **`hook-runtime.ts` / `manifest-loading.ts` / `sdk-entry.ts` shared between bundle.ts and runner.ts** — this is the *correct* extracted-abstraction; the doc comments document the de-dup intent and both consumers stay in lock-step. Do not "inline" it.
- **`runHookScript` `shell: true`** — a security-relevant choice (hook scripts are operator-trusted bundle content); not a refactoring target, and the centralization already means a fix lands once.
- **`mapPiEventToUnified` held-latest state machine (`pi-session.ts:354-643`)** — dense but heavily tested (pi-session.test.ts), with extensive explanatory comments on the agent-vs-turn terminal semantics. The conditional-on-`agentActive` is a real reachable distinction (T17 contra), not a premature switch. Leave the logic; only the lifecycle-name literals (finding 4) are touchable.
- **`fileExists`/`isFile`/`isDirectory`/`copyDirIfPresent`/`dirHasEntries` helpers** — small, cohesive, well-named FS predicates; not over-abstraction.
- **Duplicate `'pi-sdk'` literal vs `PI_SDK_HARNESS_ID`** — minor; the adapter uses `as const` `id = 'pi-sdk'` which is the source of truth for the adapter identity. Coincidental, low value to unify across the package boundary.

## 🔭 If applying: outside-in sequence
1. **Finding 1** (de-dup manifest types in adapter) — Low risk, internal, unblocks type-coherence; do first.
2. **Finding 8** (name `pi.build` shape) — Low, internal, complements #1.
3. **Finding 4** (export + reuse `PI_LIFECYCLE_EVENT`, drop runner's `ExtensionFactory`) — Low, internal.
4. **Finding 7** (extract `materialize*` privates) — Low, internal, mechanical.
5. **Finding 5** (share validation; SCOPE to parse+harness only, leave schemaVersion tightening out) — Med.
6. **Finding 6** — likely leave alone; only document.
7. **Findings 2 & 3** — public-surface; route through Expand/Contract; require a product decision (wire vs deprecate). Do NOT auto-apply.

## ✅ Safety checklist
- [ ] Run `bun test` for harness-pi-sdk before and after (pi-session.test, pi-session.getMetadata.test, pi-sdk-adapter.test, runner.test).
- [ ] For finding 1: assert `JSON.stringify(bundleManifest)` byte-identical via golden test before swapping types.
- [ ] For finding 4: assert each `PI_LIFECYCLE_EVENT.*` value equals the prior literal; watch for a biome `noConstantCondition`/style finding when replacing literals with the const.
- [ ] For finding 5: do NOT introduce the schemaVersion check into `loadTargetBundle` in the safe pass — that is stricter behavior (redesign).
- [ ] Preserve the exact field set on `composeTarget`/`loadTargetBundle` return objects — no `{...spread}` of extra props.
- [ ] Findings 2 and 3 are public-surface; do not touch without Expand/Contract + cross-package usage audit.
