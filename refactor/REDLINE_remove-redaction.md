# Redline: remove the redaction / secret-digest subsystem from the spec

**Status:** proposed redlines — NO spec files edited yet. cody consistency pass complete (no technical objections). Awaiting Lance sign-off.
**Decision (Lance):** stop building bespoke secret management into the tooling. The redaction/secret-digest model is security theater; remove it from the SPEC first, fix impl after.
**Scope:** the 3 normative specs — `FINAL_DATATYPES.md`, `FINAL_CONTRACTS.md`, `AGENT_RUNTIME_CONTRACT_PLANE_SPEC.md`. The 3 plan docs are now `HISTORICAL_`-prefixed and are not edited.
**Authors:** clod + cody (audit), redline draft by 3 doc-scoped agents, reconciled by clod.

---

## 1. Locked design

### Principle (canonical home: PLANE_SPEC architecture; referenced from CONTRACTS §5; one-line note in DATATYPES §4)
> The contract plane may hold raw execution material in memory because HRC must launch the harness. It defines **no** generic secret classification, redaction transforms, or digest-substituted values. Durable/storage/display planes persist only explicit projections that omit fields designated as live execution material. Confidentiality is enforced by not storing/displaying those fields — or via runtime env injection / an external secret store — **not** by contract-DTO redaction.

### Delete (types/fields/columns)
`RedactedValue`, `RedactedArtifact`, `RedactionState` (incl. `'contains-secret-digests'`), `RedactionDigestCarrier`, `SecretDigest`, `SecretRef`, `RedactedHarnessInvocationSpec`, `RedactedInvocationStartRequest`; `redactedSpec`/`redactedStartRequest`/`redactedProfile`; `redactedSpecHash`/`redactedStartRequestHash`/`redactedPlanHash` + the `Redacted*Hash` id-aliases; `CompiledRuntimePlan.secrets.{secretEnvKeys,secretDigests}`; `HashMaterialPolicy.secretMode`; `BrokerObservabilityContract.{env,redaction}`; `src/redaction.ts` from the package contract; FINAL_CONTRACTS hash rules 7+8 and §5.3; `redacted_*` DDL columns; redaction invariants/acceptance/tests; "broker emits redacted events/status".

### Rename
- `CompileDiagnostic.redactedDetails` → `details`
- `subject_redacted_json` / `subjectRedactedJson` → `subject_display_json` / `subjectDisplayJson` (bounded display subject — KEEP this; raw native payloads not persisted by default)
- `continuation.keyHash` → `continuationId` (opaque identity, **no** security claim) — both `HrcContinuationRef` and `BrokerContinuationRef`
- `runtime_artifacts.redaction_state` → **drop** (see decision D3)
- `artifactHash` → `contentHash` (aligns with existing `content_hash` column)

### New hashing rule (replaces the secret-digest model)
- Keep `specHash`/`profileHash`/`planHash`/`compatibilityHash` + `contentHash`. They are **closure/dedup/route/reuse/test** tools, **not** confidentiality controls.
- Hash material = a **named canonical projection** selected by **explicit PATH omission**, versioned `hashProjection: 'runtime-contract-semantic/v2'`. Path omission — never key-name matching, never value scanning. Canonicalization survives; `secretMode` is deleted.
- Projections:
  - `specHash` = `HarnessInvocationSpec` with `/process/env` omitted
  - `startRequestHash` = `InvocationStartRequest` with `/spec/process/env` omitted (initialInput **included**)
  - `profileHash` / `planHash` = minus self-hash fields, ephemeral timestamps, and `/process/env`
  - `compatibilityHash` = command, args, cwd, transport, driver config/model/reasoning, bundle identity/lock, policy, resource limits, continuation provider/kind/non-secret identity, **+ the sorted env KEY SET only (names, never values)**
- **Hard rule:** secrets must NEVER be placed in argv, cwd, driver config, initial input, labels, or correlation if those are hashed/persisted/displayed. Secret launch material arrives only via process env, runtime env injection, or an external secret store/reference outside this contract plane.
- **No** reuse-soundness / `environmentRevision` rule. Premise is unsound: real key management has the harness/broker read keys directly, not via env passthrough. Pure-passthrough env vars are simply absent from the compatibility hash; no reuse-invalidation language.
- **Guardrail (cody):** if a future route uses an env *value* as non-secret runtime *mechanics*, that value MUST be elevated into explicit driver config/policy, or the route opts out of reuse. This is a guardrail against hiding mechanics in env — NOT an `environmentRevision` subsystem.
- `hashProjection: 'runtime-contract-semantic/v2'` is the **projection policy** and is orthogonal to the canonicalization **algorithm** `HashAlgorithm = 'sha256-canonical-json/v1'` (unchanged). Keep the two version strings separate.

### Keep
Canonical hash helper; `contentHash` for persisted bytes; explicit public/projection DTOs (debug/audit/public-api); bounded permission display subject; raw `startRequest` in the in-memory profile (HRC needs it to launch).

---

## 2. Reconciled decisions (resolved by clod; flag if you disagree)

- **D1 — replacement field/column naming:** standardize on `projection`. `redacted_plan_json`→`plan_projection_json`, `redacted_spec_json`→`spec_projection_json`, `redacted_start_request_json`→`start_request_projection_json`, `redactedPlanHash`→ (deleted; `planHash` remains). Record fields: `planProjectionJson`/`specProjectionJson`/`startRequestProjectionJson`. **Projection DTOs are persist/display-boundary types — `CompiledRuntimePlanProjection`, `RuntimeExecutionProfileProjection`, `HarnessInvocationSpecProjection`, `InvocationStartRequestProjection` — and are NOT embedded in the live `BrokerExecutionProfile`** (cody catch #1: the live profile carries raw `startRequest` + hashes only; projections are computed where artifacts are persisted/displayed). Version-string type: `RuntimeContractHashProjection = 'runtime-contract-semantic/v2'`. **(default applied)**
- **D2 — `CompiledRuntimePlan.secrets`:** rename container `secrets` → `env`, keep only `envKeys: string[]` (the key set `compatibilityHash` needs). Drops the "secret classification" framing entirely. **(default applied)**
- **D3 — `runtime_artifacts.redaction_state`:** **drop** the column (artifacts are uniformly projections; no per-artifact policy variance to record). **(confirmed — cody found no reader in HRC/ACP; DROP)**
- **D4 — persist a projection JSON, or hashes+metadata only?** Keep a stored **projection JSON** (env omitted by path) — it's the safe, debuggable artifact and the principle supports persisting projections. **(default applied)**
- **D5 — env in per-object hashes:** per-object hashes (`spec/start/profile/plan`) omit `/process/env` **entirely**; `compatibilityHash` separately carries the **sorted env key names** as a derived field, never values. This avoids the "key presence vs value content" ambiguity agent-3 flagged. **(default applied)**
- **D6 — DDL drift fold-in:** while editing, make `capability_resolution_json` (on **`runtime_operations`**, NOT `broker_invocations` — `broker_invocations.capabilities_json` is the invocation capability snapshot and stays), `projection_status`, `projection_error` present and consistent across all 3 docs' DDL (`projection_error` is in the DATATYPES record but missing from the CONTRACTS + PLANE_SPEC DDL). **(default applied; table placement per cody #4)**

---

## 3. Per-doc redlines

### 3a. FINAL_DATATYPES.md
| Section / line | Kind | Current | Proposed |
|---|---|---|---|
| §0 pkg map L15 | REPLACE | "redaction/hash helpers" | "hash helpers" |
| §2 L117/122/124 | DELETE | `RedactedPlanHash`/`RedactedSpecHash`/`RedactedStartRequestHash` aliases | (remove) |
| §4 L212 | RENAME | "Hashing and redaction types" | "Hashing and canonicalization types" |
| §4 L224-234 | DELETE | `SecretDigest`, `SecretRef` | (remove) |
| §4 L236-240 | REPLACE | `HashMaterialPolicy{omitFields,secretMode,timestampMode}` | `{hashProjection:'runtime-contract-semantic/v2', omitPaths, timestampMode}` |
| §4 L247-265 | DELETE | redaction.ts comment, `RedactionState`, `RedactedValue`, `RedactedArtifact` | (remove) |
| §4 (after types) | INSERT | — | principle note + hashing-rule reference |
| §4/§17 (new) | INSERT | — | define persist/display projection DTOs: `CompiledRuntimePlanProjection`, `RuntimeExecutionProfileProjection`, `HarnessInvocationSpecProjection`, `InvocationStartRequestProjection` + `RuntimeContractHashProjection='runtime-contract-semantic/v2'`. **NOT embedded in the live profile** (cody #1) |
| §7 obs L518/520 | DELETE | `env`, `redaction:'broker-redaction-required'` | (remove; keep `correlation`,`driverConfig?`) |
| §7 cont. L533/540 | RENAME | `keyHash` (both refs) | `continuationId` |
| §8 L623 | DELETE | `redactedPlanHash` | (remove; keep `planHash`) |
| §8 L653-657 | REPLACE | `secrets{envKeys,secretEnvKeys,secretDigests}` | `env{envKeys}` (D2) |
| §8 L668 | RENAME | `redactedDetails?` | `details?` |
| §9 L694 | DELETE | `redactedProfile` | (remove) |
| §9 L748-757 | REPLACE | harnessInvocation w/ 4 redacted fields | keep `startRequest,specHash,startRequestHash,initialInputHash?` only |
| §10 L871-875 | DELETE | `RedactedHarnessInvocationSpec` | (remove) |
| §10 L1075-1078 | DELETE | `RedactedInvocationStartRequest` | (remove) |
| §15 L1733-1742 | REPLACE | compile{} w/ 2 redacted hashes | drop the redacted hashes |
| §17 L1937-1938 | REPLACE | `redactedPlanHash`,`redactedPlanJson` | `planProjectionJson` (D1/D4) |
| §17 L1981-1987 | REPLACE | spec/start redacted hashes+json | `specProjectionJson`,`startRequestProjectionJson`; keep canonical hashes |
| §17 L2003-2004 | KEEP/FOLD | `projectionStatus`,`projectionError` | confirm DDL parity (D6) |
| §17 L2022 | DROP | `redactionState: RedactionState` | (drop — D3) |
| §6/§11 L427/L1399 | KEEP | `subjectRedactedJson`/`subjectRedacted` | rename to `*Display*` (bounded display subject — KEEP) |

### 3b. FINAL_CONTRACTS.md
| Section / line | Kind | Current | Proposed |
|---|---|---|---|
| §0 after L36 | INSERT | — | "Confidentiality posture" principle paragraph |
| §2 L58/62/70/73 | REPLACE | ownership-matrix redaction rows | projection-omission language; broker "emits normalized events/status (no redaction)" |
| §3.1 L97 | DELETE | `src/redaction.ts` | (remove) |
| §3.1 L104 | REPLACE | "...redaction helpers, hash helpers..." | "...hash helpers, projection DTOs/helpers..." |
| §3.4 L153 | REPLACE | allowlist "redacted persistence" | "projection persistence" |
| §5 L177 | RENAME | "Hashing, redaction, and canonicalization" | "Hashing, projection, and canonicalization" |
| §5.1 L189 (rule 7) | DELETE | "secret values represented by digests" | (remove) |
| §5.1 L190 (rule 8) | DELETE | "redacted artifacts use placeholders" | replace w/ new rule 7: named canonical projection by path omission |
| §5.2 L194-204 | REPLACE | hash table w/ 4 redacted* rows + digest language | projection-based table; drop redacted rows; `artifactHash`→`contentHash`; add "not confidentiality controls" note |
| §5.3 L208-210 | DELETE | "ASP MUST classify env keys public/secret/redacted; secret digests..." | replace w/ "Confidentiality by projection" + hard rule + no-reuse-rule note |
| §6.3 L266 | DELETE | "- redacted artifacts;" | (remove) |
| §6.5 L292 | REPLACE | "...redactedSpec, redactedStartRequest..." | "profile includes complete InvocationStartRequest, specHash, startRequestHash, policy, continuation refs, expected capabilities, compatibilityHash, observability contract; HRC persists projections separately" — **cody #1: no projection DTO in the live profile** |
| §6.8 L318 | REPLACE | "Diagnostics MUST be structured and redacted." | "...MUST omit live-execution fields (/process/env, secret material)." |
| §7.4 L397 | REPLACE | "HRC persists redacted plan/profile diagnostics." | "...persists plan/profile projections and diagnostics." |
| §7.9 L496 | REPLACE | "permission subject is redacted before persistence" | "broker/driver emits bounded display subject (subject_display_json); raw payloads not persisted by default" |
| §7.12 L555 | REPLACE | "redacted plan/profile/spec/start artifacts" | "plan/profile/spec/start-request projections (live-execution fields omitted)" |
| §8.1 L624 | DELETE | "- redaction of event/status payloads;" | (remove) |
| §8.12 L818 | DELETE | "- redaction for native payloads." | (remove) |
| §11.1 L897-898 | RENAME | `redacted_plan_hash`,`redacted_plan_json` | `plan_projection_json` (+ keep `plan_hash`) |
| §11.1 L942/944 | DELETE | `redacted_spec_hash`,`redacted_start_request_hash` | (remove) |
| §11.1 L946/947 | RENAME | `redacted_spec_json`,`redacted_start_request_json` | `spec_projection_json`,`start_request_projection_json` |
| §11.1 L963 | KEEP/INSERT | `projection_status` present | add `projection_error TEXT` (D6) |
| §11.1 L975 | DROP | `redaction_state` | (drop — D3) |
| §11.1 L987 | RENAME | `subject_redacted_json` | `subject_display_json` |
| §13.1 L1066 | REPLACE | "HRC persists redacted plan..." | "...persists plan projection..." |
| §14.1 L1136 | DELETE | "Redacted plan/spec/start contain no raw secrets." | replace w/ projection-hash determinism + path-omission tests |
| §14.5 L1179 | REPLACE | "Permission subject is redacted." | bounded display subject test |
| §15 L1203/1212 | REPLACE | acceptance "redacted" criteria | projection / bounded-subject criteria + new projection acceptance criterion |

### 3c. AGENT_RUNTIME_CONTRACT_PLANE_SPEC.md
| Section / line | Kind | Current | Proposed |
|---|---|---|---|
| §3 diagram L126-128 | REPLACE | "redaction, hashes, diagnostics" | "canonical projections, hashes, diagnostics" |
| §3.1 matrix L176 | REPLACE | "Redaction/hashes for compiled artifacts ... emits redacted events/status" | projections+hashes; persist projections; "emits normalized events/status (no redaction transform)" |
| §3.1 after L176 | INSERT | — | the PRINCIPLE block (canonical home) |
| §4 INV-14.4 L223 | REPLACE | "persist the redacted plan/profile hashes" | "persist plan/profile hashes **and** plan/profile projections" — cody #6: hashes stay semantic closure hashes; projection JSON is a separate persist artifact |
| §5 Artifact L307-309 | REPLACE | "owns redacted/hash/file-backed artifacts" | "owns projection/hash/file-backed artifacts; persisted = explicit projections" |
| §6 pkg list L350 | DELETE | `src/redaction.ts` | (remove) |
| §7.2 L448 | DELETE | `redactedPlanHash` | (remove) |
| §7.2 L481-484 | REPLACE | `secrets{envKeys,secretEnvKeys}` | `env{envKeys}` (D2) |
| §7.3 L512 | DELETE | `redactedProfile` | (remove) |
| §7.4 L533 | DELETE | `redactedSpec: RedactedHarnessInvocationSpec` | (remove) |
| §7.5 L552-573 | REPLACE | hashing section w/ "raw secrets"/`redactedPlanHash` | wholesale rewrite to NEW HASHING RULE (keep "MUST NOT reconstruct from hashes") |
| §7.6 L584 | RENAME | `redactedDetails?` | `details?` |
| §9.5 L766 | REPLACE | "persists CompiledRuntimePlan redacted artifact" | "persists CompiledRuntimePlan projection" |
| §11.2 L962 | RENAME | `subjectRedactedJson` | `subjectDisplayJson` |
| §11.3 L979 | REPLACE | "Permission subject is redacted before persistence." | bounded display subject |
| §13 L1028-1039 | RENAME | `keyHash` (both refs) | `continuationId` |
| §13 L1060 | REPLACE | "persists redacted/hash continuation" | "persists opaque continuationId (identity only); omits raw keys" |
| §14.1 L1076-1077 | DELETE+RENAME | `redacted_plan_hash`,`redacted_plan_json` | delete `redacted_plan_hash` (keep `plan_hash`); rename `redacted_plan_json`→`plan_projection_json` — **cody #2** (no `projection_hash`) |
| §14.1 L1126 | RENAME+ADD | `redacted_spec_json` | rename→`spec_projection_json`; **ADD `start_request_projection_json`** — cody #3, parity w/ CONTRACTS |
| §14.1 L1158 | DROP | `redaction_state` | (drop — D3) |
| §14.1 L1120 | KEEP | `capabilities_json` | **KEEP** (invocation capability snapshot) — cody #4 |
| §14.1 runtime_operations | ADD | (no capability_resolution_json) | add `capability_resolution_json TEXT` — D6 on the correct table (cody #4) |
| §14.1 permission_decisions | ADD | (table absent in PLANE_SPEC) | **ADD the table w/ `subject_display_json`** for column parity w/ CONTRACTS §11.1 — cody #5 |
| §14.4 L1193-1207 | REPLACE | "persist enough redacted compiler state" + redacted bullets | projection/metadata bullets; fold in projection_status/projection_error/capability_resolution_json |
| §16.3 L1312 | REPLACE | allowlist "redacted persistence" | (remove that entry) |
| §18.3 L1448-1459 | REPLACE | `BrokerObservabilityContract` w/ `env`+`redaction` | correlation + non-secret driverConfig only |
| §19 L1507/1523 | REPLACE | "redaction/hash helpers"; "Redacted plan contains no raw secrets" | "projection/hash helpers"; projection-hash determinism |
| §20.1 L1630 | REPLACE | "Redacted plan excludes raw secrets" | projection-hash determinism |
| §20.5 L1673 | REPLACE | "Permission subject is redacted" | bounded display subject |
| §21 L1697/1706 | REPLACE | acceptance "redacted" criteria | projection / bounded-subject criteria |

---

## 4. Cross-doc consistency map (must move together)
- Type deletions in **DATATYPES §4** are the source of truth; every `Redacted*`/`SecretDigest`/`SecretRef`/`secretMode` reference in CONTRACTS §5 and PLANE_SPEC §7.5 must go in the same change or the docs dangle.
- `continuation.keyHash`→`continuationId`: DATATYPES §7 + PLANE_SPEC §13 (+ any prose calling it a "hash").
- `subject_*redacted*`→`subject_display_*`: DATATYPES §6/§11 + CONTRACTS §7.9/§11.1/§14.5 + PLANE_SPEC §11.2/§11.3/§20.5.
- DDL renames/drops: CONTRACTS §11.1 and PLANE_SPEC §14.1 must match column-for-column (incl. D6 fold-ins).
- The PRINCIPLE block has ONE canonical home (PLANE_SPEC §3.1); CONTRACTS §0 and DATATYPES §4 carry a short pointer, not a duplicate.

## 5. Resolved by cody consistency pass (#3282)
- **D3:** **DROP** `runtime_artifacts.redaction_state` — cody found no reader/migration in HRC/ACP (only specs, the doomed contract type, and local redaction tests). A projection policy, if ever needed, lives inside the projection JSON or the artifact-kind enum, not a column. ✅
- **Projection DTO names (coined):** `CompiledRuntimePlanProjection`, `RuntimeExecutionProfileProjection`, `HarnessInvocationSpecProjection`, `InvocationStartRequestProjection`; record fields `planProjectionJson`/`specProjectionJson`/`startRequestProjectionJson`; version type `RuntimeContractHashProjection = 'runtime-contract-semantic/v2'`. Permission keeps `subjectDisplayJson` (record) / `subjectDisplay` (event) — a bounded display subject, **not** a `Projection`. ✅
- **`hashProjection` version:** `runtime-contract-semantic/v2` confirmed; orthogonal to `HashAlgorithm='sha256-canonical-json/v1'`. ✅
- **cody conditional sign-off:** "after those fixes the redline is internally coherent and ready for Lance approval." All fixes applied above (cody #1–#6).
