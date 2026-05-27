# Impl plan: match code to the de-redaction + lockedEnv/dispatchEnv spec

**Status:** draft for cody review. No code edited. Maps the two landed spec commits
(`6802e90` de-redaction, `dc9257f` lockedEnv/dispatchEnv) to concrete code changes.
**Spec authority:** `FINAL_DATATYPES.md`, `FINAL_CONTRACTS.md`, `AGENT_RUNTIME_CONTRACT_PLANE_SPEC.md` (this branch, HEAD).
**Author:** clod. Reviewer: cody.

---

## 0. Shape of the change (two themes, one diff)

1. **Delete the redaction/secret-digest subsystem** from code (it was never on the data path).
2. **Land the four-channel env model.** Compiled spec carries only ASP-declared, non-secret,
   **hashed** `lockedEnv`. Per-invocation `dispatchEnv` (HRC-supplied, **not** hashed, **not** in
   the spec) rides an outer `InvocationDispatchRequest { startRequest, dispatchEnv? }` envelope.
   The broker composes spawn env as a **validated disjoint union**:
   `ambientAllowlist ⊎ credentials ⊎ lockedEnv ⊎ dispatchEnv` (collisions = errors, not precedence).

Authoritative new types (from `FINAL_DATATYPES.md`):
- `CompiledRuntimePlan.lockedEnv = { lockedEnvKeys: string[] }` (was `secrets {envKeys,secretEnvKeys,secretDigests}`) — L647
- `HarnessProcessSpec.lockedEnv?: Record<string,string>` (was `env`) — L877; same rename on Terminal/EmbeddedSdk/Command profiles (L703/726/777)
- `InvocationDispatchRequest { startRequest, dispatchEnv?: Record<string,string> }` — L1070
- `BrokerExecutionProfile.harnessInvocation = { startRequest, specHash, startRequestHash, initialInputHash? }` (the 4 redacted fields are gone) — L743
- Projection DTOs `CompiledRuntimePlanProjection` / `RuntimeExecutionProfileProjection` / `HarnessInvocationSpecProjection` / `InvocationStartRequestProjection`, version `RuntimeContractHashProjection='runtime-contract-semantic/v2'` — L1935
- **Hash flip:** `lockedEnv` (keys **and** values) is the canonical object **included** in `spec/start/profile/plan/compatibilityHash`; `dispatchEnv` is in **no** hash. — DATATYPES L246, CONTRACTS §5.2

---

## Phase 1 — Contracts + protocol types (blocks everything else)

### 1a. `packages/spaces-runtime-contracts/src/`
- **`redaction.ts`** — **DELETE the file.** Remove `export * from './redaction'` in `index.ts:20`.
- **`hash.ts`** — delete `SecretDigest` (L8), `SecretRef` (L14), `secretDigest()` (L153); change
  `HashMaterialPolicy` (L20) `{omitFields, secretMode, timestampMode}` → `{hashProjection: RuntimeContractHashProjection, omitPaths: string[], timestampMode}`; delete `secretMode` from `DEFAULT_POLICY` (L39). Add `RuntimeContractHashProjection = 'runtime-contract-semantic/v2'` (keep `HashAlgorithm='sha256-canonical-json/v1'` separate). **Ensure no omit-path strips `/process/lockedEnv`** — lockedEnv must be hashed.
- **`compiler-plan.ts`** — `CompiledRuntimePlan`: delete `redactedPlanHash` (L88); replace `secrets {envKeys,secretEnvKeys,secretDigests}` (L118-122) with `lockedEnv { lockedEnvKeys: string[] }`. `CompileDiagnostic.redactedDetails` → `details` (L133).
- **`execution-profile.ts`** — `RuntimeExecutionProfileBase`: delete `redactedProfile` (L48). `harnessInvocation` (L102-111): keep only `startRequest, specHash, startRequestHash, initialInputHash?` (drop `redactedSpecHash`, `redactedStartRequestHash`, `redactedSpec`, `redactedStartRequest`). Rename `process.env`→`lockedEnv` (Terminal L64, EmbeddedSdk `session.env` L85, Command `command.env` L138). Drop the `RedactedHarnessInvocationSpec`/`RedactedInvocationStartRequest` re-exports (L25-31).
- **`continuation.ts`** — `keyHash` → `continuationId` on `HrcContinuationRef` (L7) and `BrokerContinuationRef` (L14).
- **`observability.ts`** — `BrokerObservabilityContract`: delete `env` (L26) and `redaction` (L28); keep `correlation`, `driverConfig?`.
- **`persistence.ts`** — `CompiledRuntimePlanRecord`: drop `redactedPlanHash`/`redactedPlanJson` (L35-36) → `planProjectionJson`. `BrokerInvocationRecord`: drop `redactedSpecHash`/`redactedStartRequestHash`/`redactedSpecJson`/`redactedStartRequestJson` (L80-85) → `specProjectionJson?`/`startRequestProjectionJson?`. `RuntimeArtifactRecord`: drop `redactionState` (L120). **Add** the 4 projection DTOs (DATATYPES §17 L1935-1957). Confirm `RuntimeOperationRecord.capabilityResolutionJson?` and `BrokerInvocationEventRecord.projectionStatus`/`projectionError` present.
- **`permissions.ts`** — `BrokerPermissionDecisionRecord.subjectRedactedJson` → `subjectDisplayJson` (L55).
- **`ids.ts`** — delete `RedactedPlanHash`/`RedactedSpecHash`/`RedactedStartRequestHash` (L13-32); rename `ArtifactHash` → `ContentHash` (persistence already uses `ContentHash`).
- **`runtime-state.ts`** — `BrokerRuntimeState.compile`: drop `redactedSpecHash`/`redactedStartRequestHash` (L77-86).
- **`test/redaction.test.ts`** — **DELETE.** Update `test/hash.test.ts` (drop digest/secretMode; assert lockedEnv inclusion).
- **NEW helper:** add a `project(source, kind)` canonical-projection helper (or extend `hash.ts`) producing the projection DTOs, used by the compiler/test-harness/HRC at persist boundaries.

### 1b. `packages/harness-broker-protocol/src/`
- **`redaction.ts`** — **DELETE the file.** Remove its export in `index.ts:10`.
- **`invocation.ts`** — remove `RedactedValue` import (L2) and `RedactedHarnessInvocationSpec` (L16-20). `HarnessProcessSpec.env` (L32) → `lockedEnv?`.
- **`commands.ts`** — remove `RedactedValue` import (L11) and `RedactedInvocationStartRequest` (L81-84). **Add `InvocationDispatchRequest { startRequest: InvocationStartRequest, dispatchEnv?: Record<string,string> }`** here (re-exported by contracts) and make `invocation.start` carry the dispatch envelope (CONTRACTS §11 L732).
- **`events.ts`** — `PermissionRequestedPayload.subjectRedacted` (L210) → `subjectDisplay`.
- **`schemas.ts`** — `validateEnv` now validates `lockedEnv`; **add** `dispatchEnv` validation (disjoint from ambient/credential/reserved classes, must not shadow lockedEnv key) and an `InvocationDispatchRequest` schema; remove redacted schemas. Update `test/schemas.test.ts`.

- **`boundary-checks.ts`** (cody nit) — still greps `process.env`; update to `process.lockedEnv`. Add shared structural validators/constants for env-key format + dispatch-shadowing (reused by broker dispatch validation).

> **Q1 — CONFIRMED w/ shape (cody):** `InvocationDispatchRequest` lives in `harness-broker-protocol` (protocol owns the JSON-RPC command DTOs); **type-only re-export** from `spaces-runtime-contracts`. Add `validateInvocationDispatchRequest`; **keep** `validateInvocationStartRequest` (startRequest stays the hashed/verbatim payload). Thread the envelope through `BrokerCommand`, `BrokerClient` (new dispatch method alongside `startInvocationFromRequest`), `Broker.start`, and the `harness-broker run-once`/`validate-start-request` CLI — CLI either accepts an envelope or deliberately wraps a bare start request with empty `dispatchEnv` for dev/backcompat. Add a `BrokerErrorCode` for dispatch-validation failures.

---

## Phase 2 — Broker spawn-env composition + redaction removal (`packages/harness-broker`)

### 2a. Env composition — `src/runtime/env.ts` (the core new behavior)
Rewrite `buildProcessEnv` (currently L17-37: `SAFE_INHERITED_ENV` + `specEnv` last-write-wins) into a **validated disjoint union** of four channels:
1. **ambientAllowlist** — rename/extend `SAFE_INHERITED_ENV`. Per the agreed model: `HOME PATH SHELL TMPDIR TEMP TMP USER USERNAME TERM LANG LC_* TZ`. (NODE_*/SSH_AUTH_SOCK/proxy/XDG_* are **not** plain ambient.)
2. **credentials** — a driver-provided map, **empty for the codex driver**. Codex auth is **file-based and stays exactly as today**: the runtime-home / materialization preparation step writes or symlinks `auth.json` into `CODEX_HOME`, the broker spawns codex with `CODEX_HOME` (a lockedEnv path, not a secret value), codex reads auth from disk. **No env-key allowlist, no required-key enforcement, no typed credential error, no change to the `auth.json` flow** (`execution/run-codex.ts:220`, `codex-adapter.ts:977` stay as-is). `buildProcessEnv` accepts a credentials map only for spec fidelity / future drivers; codex passes `{}`. The compiled spec stays credential-free because the credential lives on disk, never in the DTO — consistent with the hard rule.
3. **lockedEnv** — from `spec.process.lockedEnv`.
4. **dispatchEnv** — from the `InvocationDispatchRequest` envelope.

Collisions across channels are **errors, not precedence**. `dispatchEnv` additionally must not shadow any `lockedEnv` key (validate at dispatch). Keep the existing `ENV_KEY_PATTERN` key-format check.

### 2b. Wire-up
- **`src/runtime/process-runner.ts`** (spawn, L37) — call the 4-channel `buildProcessEnv`.
- **`src/invocation-manager.ts`** — accept `InvocationDispatchRequest`; thread `dispatchEnv` to env composition; init from `spec.process.lockedEnv` (L395 was `buildEnvSecrets(spec.process.env)`).
- **`harness-broker-client`** (Phase 1/2, cody nit — first-class, not a sub-bullet) — `invocation.start` API now sends `InvocationDispatchRequest`; its "exact start request" tests **invert** to "exact dispatch envelope with verbatim startRequest." Update `test/permission-handler.test.ts`.

### 2c. Redaction removal — **with care to preserve non-redaction safety**
- **`src/security/redaction.ts`** — `finalizeEventPayload` does **three** things: (a) secret-scrubbing [DELETE], (b) `safeStartedPayload`/ready/disposed payload normalization [KEEP], (c) oversized-payload truncation against `maxEventBytes` [KEEP]. **Do not delete (b)/(c).** Proposal: split into `src/runtime/event-normalize.ts` (keep b+c), delete the scrubbing + `buildEnvSecrets`/`scrubString`/`redactPayload`/`redactPermissionSubject` + the deprecated stubs.
- **`src/invocation-manager.ts`** — drop `envSecrets` field (L68) and the scrub call (L303-308 keeps the normalize/truncate path via the new module).
- **`src/drivers/codex-app-server/permissions.ts`** (L108) — replace `redactPermissionSubject(request.params)` with a **bounded display-subject builder** (emit `subjectDisplay`; raw payload not persisted) per CONTRACTS §7.9. Not a scrubber — a positive projection of the safe fields.
- **`test/security/redaction.test.ts`** — DELETE; replace with an event-normalize/size-bound test. Update `test/drivers/codex-app-server/permissions.test.ts` to assert bounded display subject.

> **Q2 — RESOLVED (Lance, via spec amendment):** credentials work *exactly* as today. The runtime-home/materialization prep step writes/symlinks `auth.json` to disk, broker runs codex, codex reads from disk. PLANE_SPEC §7.5.1 amended to bless on-disk file credentials (materialized by broker/driver *or* runtime-home prep) as a valid credential source outside the DTO. No credential env channel, no allowlist, no typed credential error, no `OPENAI_API_KEY` requirement. The credentials lane is empty for codex. (Overrides cody's "ASP must stop propagating auth.json" concern — the auth file is a disk side-effect, not part of the compiled spec DTO, so it does not violate the credential-free-spec rule.)
> **Q3 — CONFIRMED (cody):** keep event-size bounding + started/ready/disposed normalization (rehomed to `runtime/event-normalize.ts`); delete only env/token scrubbing; permission subject becomes a positive bounded `subjectDisplay` projection, not a renamed scrub.

---

## Phase 3 — ASP compiler: env classification, projections, de-redaction (`packages/agent-spaces`)

### 3a. `src/compile-runtime-plan.ts`
- Delete `SECRET_ENV_KEY` regex (L31), `digestEnv()` secret classification + `secretDigest()` (L211-237), the `redactArtifact` calls building redactedSpec/redactedStartRequest/redactedProfile (~L350-368).
- `CompiledRuntimePlan.secrets` (L487-491) → `lockedEnv { lockedEnvKeys }` where `lockedEnvKeys = sorted(Object.keys(lockedEnv))`.
- `BrokerExecutionProfile.harnessInvocation` emits only `startRequest, specHash, startRequestHash, initialInputHash?`.
- Hashes computed over `lockedEnv`-inclusive canonical projections (no env omit-path).
- Emit projection DTOs via the new `project()` helper where artifacts are produced.

### 3b. `src/broker-invocation.ts`
- `spec.process.env` (L247) → `spec.process.lockedEnv`, fed **only** the declared config (not the full snapshot).

### 3c. `src/prepare-cli-runtime.ts` — **the real fix** (needs cody sign-off on the split)
Today (L256-286) one `env` object bundles everything. Classify each source:

| Source (current) | Vars | Proposed channel |
|---|---|---|
| `adapterEnv` (L240) | CODEX_HOME etc. | **lockedEnv** (launch shape) |
| explicit (L262) | `ASP_HOME` | **lockedEnv** |
| `agentchatEnv` (L249-254) | `AGENTCHAT_ID`, `ASP_PROJECT` | **lockedEnv** (declared identity/config) |
| `brainEnv` (L265-273) | agent brain config | **lockedEnv** (config) — audit for any secret/ambient |
| `toolRuntime.env` (L275-286) | **incl. `PATH`** (`agent-tools.ts:104-111`) + `ASP_AGENT_*`/tool metadata | **SPLIT** — see ⚠️ below |
| `correlationEnv` (L245) | `AGENT_SCOPE_REF`, `AGENT_LANE_REF`, `AGENT_HOST_SESSION_ID` | **dispatchEnv** (per-invocation handles; §6.9) |
| `req.env` (L261) | request delta | **explicit fields** — see ⚠️ below |

Net rule (CONTRACTS §6.9): anything affecting launch shape/reuse = `lockedEnv` (hashed); per-invocation handles/correlation = `dispatchEnv`. **No** `process.env` snapshot enters the spec.

⚠️ **toolRuntime.env (cody correction):** it writes `PATH`, which is ambient-baseline/reserved — `lockedEnv.PATH` violates the disjoint-class rule. **Split it:** non-reserved `ASP_AGENT_*` / tool metadata → `lockedEnv`; the PATH-prepend needs either a **typed driver/process config field** (e.g. `pathPrepend`/tool-bin) or a product decision that tools read `ASP_AGENT_TOOLS_BIN` instead of relying on `PATH`. (Not the skipped absolute-binary issue — this is the spec's reserved-key collision rule.)

⚠️ **req.env (cody correction):** **cannot** be split by key-name heuristics (recreates the old ambiguity). Add explicit request fields (`lockedEnv`/`dispatchEnv`) **or** define legacy `env` as locked-only and reject reserved/credential/per-invocation keys.

> **Q4 — CONFIRMED w/ the two ⚠️ corrections (cody):** correlation→dispatchEnv ✅; pre-HRC `asp run`/test-harness synthesizes the `InvocationDispatchRequest` envelope (correct simulation of HRC) ✅.

### 3d. Test harness — `src/testing/pre-hrc-broker-contract-*.ts`
- `pre-hrc-broker-contract-artifacts.ts`: delete `envForRedaction` (L30-34) + all `*.redacted.json` `redactArtifact` artifacts (L100-105) + `redacted-by-default` summary (L140); emit **projection** artifacts instead.
- `pre-hrc-broker-contract-assertions.ts`: drop `redactForComparison`/`matchesRawOrRedacted` (L27-40); the harness now simulates HRC sending `InvocationDispatchRequest` with `dispatchEnv` and asserts the disjoint-union spawn env.
- Update `pre-hrc-broker-contract-{types,harness,event-ledger,helpers}.ts` and tests `compile-runtime-plan.test.ts`, `compiler-broker-profile.test.ts`, `pre-hrc-broker-contract-verifier.test.ts`.

---

## Phase 4 — Execution + CLI env minimization (`packages/execution`, `packages/cli`)

- **`packages/execution/src/run/space-launch.ts` (L69-74)** and **`src/run.ts` (L113-118)** — gut `compilerPlacementEnv` (the 2-key denylist over `process.env`). Placement should carry only declared config, not a `process.env` snapshot. Callers: `space-launch.ts:170`, `run.ts:394,403`.
- **`packages/cli/src/commands/run.ts`** — `--debug` dump: remove `redactArtifact` from `printableCompileResponse` (L276,304) and `printCompilerDebugDump` (L324); drop `requestEnv` (L251-254). Spec is now credential-free, so the dump prints directly.
- **`packages/cli/src/__tests__/run-compiler-debug.test.ts`** — premise flips: there is no secret in the spec to hide. Replace the `not.toContain(SECRET_VALUE)` assertion (L120) with: lockedEnv present, no ambient/credential keys in the compiled spec.
- **`packages/agent-spaces/src/client.ts` + `run-placement-turn.ts`** (cody nit) — audit: still construct/apply env surfaces, and tests assert correlation vars in `spec.env` today. Must move correlation → dispatchEnv and stop projecting ambient env, in lockstep with `prepare-cli-runtime.ts`.

---

## Phase 5 — Real e2e smoke (`scripts/`)
- **`scripts/smoke-runtime-contract-broker-real-codex.ts`** — real Codex uses the **existing `CODEX_HOME`/`auth.json` flow**; the credentials env lane is **empty** for codex (no broker env-credential channel). This is the **honest e2e gate** (not `bun run test`): a real installed binary launching codex via the broker, with `CODEX_HOME` from `lockedEnv`, `auth.json` on disk (as today), `lockedEnv` from the spec, and `dispatchEnv` from the envelope.

---

## Cross-repo follow-up (hrc-runtime — NOT this repo, must coordinate)
The contract types here enable, but do not implement, the HRC side:
1. HRC sends `InvocationDispatchRequest` (not bare `InvocationStartRequest`); forwards `startRequest` verbatim; **supplies `dispatchEnv`** per invocation (correlation/handoff handles).
2. HRC persistence: SQLite DDL + migrations for `plan_projection_json`/`spec_projection_json`/`start_request_projection_json`, `subject_display_json`, drop `redaction_state`, add `projection_error`/`capability_resolution_json`; continuation `key_hash`→`continuation_id`.
3. HRC computes/persists projections at the persist boundary using the new `project()` helper.

→ File as an `hrc-runtime` task and coordinate with cody@hrc-runtime; gate it behind Phase 1 (types) landing here.

---

## Dependency order & dispatch shape (for agent-tasker, post-approval)
1. **Phase 1** (contracts+protocol types) — foundational, blocks all. → larry/curly
2. **Phase 2** (broker env + de-redaction) — depends on 1. → curly
3. **Phase 3** (ASP compiler env split + projections) — depends on 1. → larry
4. **Phase 4** (execution/CLI minimization) — depends on 1,3. → curly
5. **Phase 5** (real-codex smoke) — depends on 2,3,4. → smokey
- Each task: implement → `just build`/`check:manifests` → commit → verify HEAD moved. Phase 5 = honest real-binary smoke before any "done".

## Review status (all resolved)
- **Q1** ✅ CONFIRMED w/ shape — dispatch envelope in protocol pkg, type-only re-export, validators, client/CLI threading, dispatch `BrokerErrorCode`.
- **Q2** ✅ RESOLVED (Lance) — credentials work exactly as today (auth.json on disk); no credential env channel, allowlist, or typed credential error.
- **Q3** ✅ CONFIRMED — rehome event-normalize + size-bound; delete only scrubbing; positive `subjectDisplay`.
- **Q4** ✅ CONFIRMED w/ two corrections — toolRuntime `PATH` reserved-key split (typed field or `ASP_AGENT_TOOLS_BIN`); `req.env` explicit fields not key-heuristics; correlation→dispatchEnv; pre-HRC harness synthesizes the envelope.
- **Q5** ✅ — stage all shared contract/protocol surface here first (dispatch type+validator, client API, dispatch error code, projection helper/DTO exports, `boundary-checks` → `process.lockedEnv`, shared env-key/shadowing validators). HRC DDL/migrations + event-projection impl stay cross-repo.

**Two items needing a final shape decision before/at dispatch (both cody-flagged, in-repo contract surface):**
- **toolRuntime PATH:** typed `process`/driver config field for PATH-prepend (e.g. `pathPrepend`) vs. product decision that tools use `ASP_AGENT_TOOLS_BIN`. → propose the typed field; confirm with cody at Phase-1 task framing.
- **req.env shape:** explicit `lockedEnv`/`dispatchEnv` request fields vs. locked-only-with-rejection. → propose explicit fields; confirm with cody at Phase-1 task framing.
