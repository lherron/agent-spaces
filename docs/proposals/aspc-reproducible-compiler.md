# aspc as a True Compiler: Reproducibility, Output Capture, and Release Verification

- **Status**: proposal (no implementation)
- **Date**: 2026-06-10
- **Author**: clod (study session with Lance)
- **Scope**: `packages/aspc`, `packages/aspc-protocol`, `packages/agent-spaces` (compile path), `packages/config` (materialization), `packages/spaces-runtime-contracts` (hash machinery)

## Motivation

aspc already behaves mostly like a compiler — canonical hashing, content-addressed bundles, derived ids — but it lacks the discipline that makes a compiler trustworthy across releases: closed-over inputs, an enumerable output surface, a determinism contract, and a golden-corpus regression gate. This proposal treats those as first-class.

Goals (Lance's list, extended):

1. Fix determinism gaps in the compile path.
2. Byte-compare/capture the generated/materialized harness directories — the true compiler output including prompts and skills.
3. Byte-verify old vs new compiles on each compiler release.
4. Gold standard agents used only to validate releases and catch regressions.

## Current state (study findings, 2026-06-10)

### The RPC surface

`packages/aspc` (facade) + `packages/aspc-protocol` (types/validators), transport = stdio JSON-RPC NDJSON:

- **`aspc.hello`** — capability handshake (`aspc/0.1`; advertises `compileAndStart`/`cohostedBroker` only when a broker is co-hosted).
- **`aspc.compileRuntimePlan`** — in: `{compileRequest: RuntimeCompileRequest, aspHome?}`; out: `RuntimeCompileResponse` (`CompiledRuntimePlan` + diagnostics).
- **`aspc.compileHarnessInvocation`** — adds `profileSelector` / `dispatchEnv` / `runtime` / `lifecyclePolicy`; out adds `selectedProfile`, `startRequest`, `dispatchRequest`.
- **`aspc.compileAndStart`** — the above, then `broker.start(...)` via the shared `startFromDispatch` seam. The facade also registers raw `broker.*` / `invocation.*` routes.

Every route validates the JSON-RPC envelope (`validateAspcCommand`) then narrows params with a per-method validator before reaching the service.

### Reproducibility machinery already in place

- **Canonical hashing** (`spaces-runtime-contracts/src/hash.ts`): `sha256-canonical-json/v1` — sorted keys, `undefined` omitted, `omit-ephemeral` drops fields matching `/_at|At|_ts|Ts|timestamp$/`. Plan projection omits `/planHash`; profile omits `/profileHash`, `/compatibilityHash`; a hard guard forbids omitting `process.lockedEnv` from hash material.
- **`compileId` is derived, not random**: `stableId('compile', {requestId, operationId, generation, profileHash})`.
- **`createdAt`** is the only wall-clock in the plan and is regex-excluded from every hash.
- **Materialized bundle root is content-addressed**: `bundles/.versions/<fingerprint>` via `computeTargetFingerprint` (artifact content hashes + identity + settings + codexOptions), published under a scope lock with prune (`packages/config/src/orchestration/install.ts:742`). System-prompt artifacts are sha256-content-addressed (`packages/config/src/store/temp-lifecycle.ts:151`); the random `tmp/launch-overlays/<uuid>` dir is removed in `finally` and never enters the plan.
- **`dispatchEnv` is stripped** from compiled placement and all hash material (test-proven: differing dispatchEnv → identical planHash/compileId/profileHash).
- **Two hash altitudes by design**: `planHash` is identity-coupled (requestId/operationId/correlation); `compatibilityHash` is the identity-invariant mechanics hash (command/args/cwd/lockedEnv/pathPrepend/transport/limits/driver/bundle/model/continuation) — invariant to id and prompt-text changes, sensitive to model/PATH changes (test-proven).
- Recompile-stability test exists: identical request twice → same planHash/startRequestHash/compatibilityHash (`packages/agent-spaces/src/__tests__/compile-runtime-plan.test.ts:845`).

### Where reproducibility breaks today

1. **The one true RNG leak: `initialInput.inputId`** — `packages/agent-spaces/src/broker-invocation.ts:279`: `req.initialInputId ?? `input_${randomUUID()}``. The inputId sits inside `startRequest.initialInput`, which is inside profile material → it poisons `startRequestHash`, `initialInputHash`, `profileHash`, and therefore `compileId` and `planHash`. `inputId` does not match the ephemeral-timestamp regex, so nothing filters it. Stability tests pass only because every fixture supplies `identity.initialInputId`. Any wire caller that omits it (with a non-empty prompt) gets a different planHash on every compile of the same request.
2. **Caller-side identity generation**: the `asp run` path (`run-compile.ts`) mints `requestId`/`operationId`/`idempotencyKey` via `randomUUID()` per run — planHash/compileId are per-run there by construction; only `compatibilityHash` is comparable across runs. HRC-supplied identity is what makes top-level hashes reproducible.
3. **Response envelope is never byte-identical**: `createdAt = new Date().toISOString()` at all four plan-builder sites. Hashes stable; raw JSON-RPC responses not.
4. **Host/toolchain coupling**: `adapter.detect()` binary path, PATH-derived `pathPrepend`, absolute `aspHome` paths in artifacts and lockedEnv, and model-alias→catalog resolution all feed hash material. "Reproducible" today means same host, same toolchain, same catalog — `compatibilityHash` exists precisely to detect that drift, but verification tooling must control for it.
5. **Diagnostics are hashed**: the `diagnostics` array (including free-text `prepare_runtime_warning` messages, which can embed environment-dependent paths) sits inside `planMaterial`, so an environment-dependent warning perturbs `planHash`.

## What the original four-item list misses

**A. The output surface is bigger than the bundle dir.** The true compiler output is scattered across four places: the compiled plan JSON, the fingerprinted bundle (`bundles/.versions/<fp>`), the content-addressed system-prompt artifacts, and the **runtime-home writes** (codex `AGENTS.md` + `config.toml`, claude `settings.json`/statusline, written under fingerprint lock in `prepareCodexRuntimeHome` et al.). Nothing records which files the compiler wrote into runtime homes, so the output cannot currently be enumerated, let alone byte-compared. Capture must start with a **written-files ledger**.

**B. The inputs are not closed over.** A compiler is a function of (source, flags, toolchain). aspc reads ambient state mid-compile: harness binary probing (`adapter.detect()`), live `PATH` → `pathPrepend`, the model catalog (aliases resolve to "latest"), `inheritUser`/`inheritProject` settings, and the live spaces-repo. Byte-verification will flake unless these are (a) pinned in fixtures or (b) captured into an explicit **toolchain manifest** that is part of the compile record. This is a prerequisite for items 3 and 4.

**C. The compiler stamp is inside the hash.** `COMPILER_VERSION` is in `planMaterial`, so every release changes every `planHash` by construction — cross-release plan-level byte-compare is self-defeating. A defined **stamp-free plan projection** is needed; the cross-release comparison story becomes: same inputs → same *artifacts*, plan compared via the stamp-free projection.

## Plan

### Phase 0 — Define the compilation contract (design doc, ~half day)

Write down, as a versioned contract:

- **Output =** plan JSON + bundle tree + runtime-home overlay + prompt artifacts, enumerated by a per-compile **output manifest** (sorted relpaths, mode, sha256 — a merkle summary, mtime-free).
- **Hash altitudes**, explicitly: `requestHash` (input identity), `outputManifestHash` (bytes, new), `planHash` (semantic, identity-coupled), `compatibilityHash` (mechanics, identity-invariant), plus a new **stamp-free plan projection** for cross-release comparison.
- **Determinism policy**: the only thing permitted to vary between identical compiles is `createdAt` (and even that becomes injectable). Anything else varying is a defect.

### Phase 1 — Close the determinism gaps

1. **`inputId` RNG leak** (`broker-invocation.ts:279`) — derive the default from `{requestId, operationId, generation, contentHash}` instead of `randomUUID()`. The only true nondeterminism inside the compiler given a fixed request.
2. **Inject a `CompileContext`** (clock + id source) through the four plan builders. `createdAt` comes from context; the verification harness passes a fixed epoch (the `SOURCE_DATE_EPOCH` move).
3. **Diagnostics out of hash material** — hash only `{level, code, profileId}` or drop diagnostics from `planMaterial` entirely; free-text messages embed environment-dependent paths.
4. **Wire-level determinism test**: drive the real stdio facade twice with a request that omits all optional ids; assert byte-identical responses modulo `createdAt`. The current stability test passes only because fixtures supply `initialInputId` — that test gap hid defect #1.

### Phase 2 — Output capture

5. **Written-files ledger**: every compiler write path (bundle compose, prompt artifacts, runtime-home bakes) reports what it wrote. Plumb through `prepare-cli-runtime` so the plan (or a sidecar) carries the full output enumeration.
6. **`aspc manifest`** (CLI + `aspc.captureArtifacts` RPC): given a compile request or plan, produce the canonical output manifest. Normalization rules: exclude `.asp-cache.json` and the `generatedAt` line of the target manifest; ignore mtimes. Same-host byte equality is the v1 bar; cross-host path-prefix-mapping (the `-fdebug-prefix-map` analog for `ASP_HOME`/`$HOME`) is explicitly deferred.
7. **Provenance record** per compile (optional flag): `{requestHash, source fingerprints, toolchain manifest, compiler version, outputManifestHash}` — the SLSA-style "why did this change" answer, stored alongside the artifacts.

### Phase 3 — Release differential gate

8. **`aspc verify-release --baseline <binary> --candidate <binary> --corpus <dir>`**: compile every gold request with both binaries (fixed clock, hermetic home), capture manifests + plans, emit a categorized report: *byte-identical* / *hash-identical-but-byte-diff* / *semantic diff*, with per-file attribution. `--bless` updates committed goldens for intentional changes — golden churn becomes a reviewed diff, like snapshot tests.
9. Wire into the justfile and the Verdaccio dev-publish loop as a pre-publish gate.

### Phase 4 — Gold standard agents

10. **`fixtures/gold/` in-repo**: ~6–10 hermetic agents covering the route matrix (claude-tmux, codex-tmux, codex headless, foreground terminal, embedded pi-sdk) × feature axes (skills, commands, priming, attachments, continuation, lockedEnv, disallowedTools, statusline). Each = request JSON + vendored space sources + committed golden (stamp-free plan projection + output manifest).
11. **Hermeticity kit**: throwaway `ASP_HOME`, stub harness binaries with pinned `--version`, a pinned model-catalog snapshot (aliases resolve against the snapshot — consistent with the no-version-pinning rule; catalog bumps then surface as *explicit* golden diffs), `inheritUser`/`inheritProject` off.

## Semantic diff mechanism

No model involved — the gate must itself be deterministic; an LLM judge inside a reproducibility gate is self-defeating. "Semantic diff" is a structural tree diff over the canonical projections the compiler already produces, plus a rules table that classifies each difference.

### 1. Normalize both sides with the existing canonicalizer

`project()` / `createCanonicalHasher().canonicalize()` already define a normal form: sorted keys, undefined dropped, ephemeral timestamps dropped, self-referencing hash fields omitted. Run baseline and candidate plans through the same stamp-free projection (Phase 0). After this step, two compiles that mean the same thing are *textually* identical JSON — anything left is a real difference. The hard "what counts as semantically equal" question is already answered by the hash-projection policy; the differ reuses it.

### 2. Structural tree diff

Walk both canonical trees and emit entries:

```json
{ "pointer": "/executionProfiles/0/harnessInvocation/startRequest/spec/process/args/3",
  "kind": "changed", "baseline": "--model=gpt-5.2", "candidate": "--model=gpt-5.3" }
```

Plain recursive JSON diff with JSON-pointer addressing — ~150 lines of deterministic code, no dependency needed.

### 3. Classification via hash-altitude membership

Each pointer gets a category derived from which hashes its subtree participates in — this falls out of the projection definitions rather than a hand-maintained list:

- pointer inside `compatibilityHash` material (command/args/cwd/lockedEnv/pathPrepend/driver/model/bundle) → **mechanics change** — the breaking tier; the runtime would behave differently.
- inside `startRequestHash`/`specHash` but not compatibility material (prompt text, labels, ids) → **content change** — expected when prompts/skills were intentionally edited.
- only in the raw envelope, excluded from all projections (`createdAt`, diagnostics) → **ephemeral** — never blocks.

The verdict per gold agent is mechanical: re-run the existing hash functions on both sides and report which of `{outputManifestHash, planHash (stamp-free), compatibilityHash, startRequestHash}` moved, with pointer-level entries as the explanation of *why*. The hashes are the verdict; the tree diff is the attribution.

### 4. File artifacts, by format

For the output-manifest side: byte-compare first; for files that differ, dispatch on type — JSON/TOML (settings.json, config.toml) are parsed and tree-diffed with the same engine; markdown (AGENTS.md, prompts, SKILL.md) gets line diff. Path-based rules classify the file itself (a diff under `skills/` is content; a diff in `settings.json` permissions is mechanics).

### Where a model could fit (optional, non-gating)

An opt-in `--explain` pass may hand the structured diff report to a model to write the human release-note paragraph ("the codex driver now passes `--reasoning-effort` explicitly; six gold agents' argv changed"). That is narration of an already-computed verdict — never consulted for pass/fail. Judging whether a reworded system prompt "means the same thing" is explicitly rejected for the gate: prompt bytes changed = content change, and a human blesses it with `--bless`. FileCheck/snapshot-test discipline: tooling detects and attributes; intent lives in review.

## Verification levels (how it composes)

- **L0** byte: output manifests equal — the gold-corpus gate, cheap, every release.
- **L1** semantic: canonical hash projections equal — catches "bytes moved but meaning didn't" and vice versa.
- **L2** behavioral: the existing pre-hrc matrix — unchanged, stays the runtime layer.

## Sequencing and risk

Phase 1 → 2 → 4 → 3 (the gate needs corpus + capture to exist). Phases 1–2 are pure agent-spaces work. One cross-repo touch: if HRC ever depends on `inputId` being unique per dispatch, the derived default needs review (it remains unique per request identity, so likely fine). The hash-projection contract (`runtime-contract-semantic/v2`) does not change in Phase 1 — `inputId` derivation and diagnostics removal change hash *inputs*, not the algorithm — but diagnostics removal changes existing planHashes once, so it should land in one release with a noted break.
