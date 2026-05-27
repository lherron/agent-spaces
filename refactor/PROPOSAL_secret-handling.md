# Proposal: secret handling in the runtime-contract plane

**Status:** for offline review. No spec or impl files changed yet (except: 3 plan docs renamed `HISTORICAL_`, and `refactor/REDLINE_remove-redaction.md` drafted). Everything gated on your approval.
**Authors:** clod + cody.

---

## TL;DR
Two findings, one decision, two changes.

The redaction / secret-digest subsystem is security theater and comes out of the **spec** first. But the *real* fix is upstream: `asp run` should stop projecting the operator's entire shell environment into the compiled spec. The harness should **inherit** ambient vars + credentials from the broker's launch environment; ASP should carry only the small space/agent-**declared** config overlay. Once secrets no longer enter the contract plane at all, redaction becomes **moot** rather than "fixed."

---

## What we found

1. **`asp run --debug` redacts every field.** Root cause: the redactor (`redaction.ts` `collectSecretValues`) collects *all* env values — no secret-key filter — then string-replaces any occurrence anywhere. Every env entry redacts itself; paths/IDs/`schemaVersion`/`WRKQ_ACTOR` get scrubbed because they contain `$HOME`/`$USER`/`"1"`. Unreadable, and not a real control.

2. **Redaction was never on the data path.** The `BrokerExecutionProfile` carries the **raw** `startRequest` (real `process.env`, live keys) *and* `redactedSpec`/`redactedStartRequest` side-by-side (`compile-runtime-plan.ts:396-403`). HRC forwards the raw start request **unchanged** to the broker (`FINAL_CONTRACTS §13.1`), which spawns codex from the raw env (`process-runner.ts` → `buildProcessEnv`). The redacted artifacts were decorative copies for persistence/display only. **Deleting them loses zero protection.**

3. **The deeper root — ASP projects the whole shell.** `compilerPlacementEnv` (`execution/src/run/space-launch.ts:69`) blanket-snapshots the operator's entire `process.env` (~100 vars incl. every API key, AWS creds, GitHub PAT) into the spec, minus a 2-key denylist. This also **defeats the broker's own curation**: `buildProcessEnv` (`harness-broker/src/runtime/env.ts`) already starts from a clean slate and inherits only a `SAFE_INHERITED_ENV` allowlist (`HOME/PATH/SHELL/TMPDIR/TEMP/TMP/USER/USERNAME`), then overlays `specEnv`. ASP shoving the whole shell into `specEnv` nullifies that allowlist. The blanket projection persists only because the allowlist **excludes secrets** — so `specEnv` is currently the *only* channel smuggling `OPENAI_API_KEY` to the harness.

## Topology (confirmed against spec + code)
**ASP ↔ HRC** (HRC calls `compileRuntimePlan`, ASP returns the plan — request/response only) and **HRC ↔ broker** (HRC owns the broker process, forwards `startRequest` unchanged). **No ASP ↔ broker edge.** The only ASP-side broker contact is `pre-hrc-broker-contract-harness.ts`, a test harness that *simulates* HRC (real HRC cutover is deferred). So "redaction belongs to the persisting plane (HRC), not the compiler (ASP)" holds by construction.

## Decision (Lance)
Stop building bespoke secret management into the tooling — there are better off-the-shelf solutions. Remove the redaction theater from the **spec** first; fix impl after.

---

## Proposed change — Part A: spec (the redline)
Detail in `refactor/REDLINE_remove-redaction.md` (~70 edits across the 3 normative specs). Summary:

- **Delete** the redaction/digest type surface: `RedactedValue`, `RedactedArtifact`, `RedactionState` (incl. `'contains-secret-digests'`), `SecretDigest`, `SecretRef`, the redacted DTOs/hashes/columns, `HashMaterialPolicy.secretMode`, `BrokerObservabilityContract.{env,redaction}`, `src/redaction.ts`, redaction invariants/tests/acceptance.
- **Keep hashes**, but redefine hash material as a **named canonical projection by explicit PATH omission** (`hashProjection: 'runtime-contract-semantic/v2'`, orthogonal to the unchanged `sha256-canonical-json/v1` algorithm). Path omission — never key-name matching, never value scanning. This is the line that kills "redact everything" at the spec level.
- **Drop** all reuse-soundness / `environmentRevision` machinery (keys read directly, not via env passthrough). Pure-passthrough env just falls out of the compatibility hash.
- **Rename** the leftover digest-flavored bits: `keyHash → continuationId`, `subject_redacted_json → subject_display_json`, `redactedDetails → details`.
- **Hard rule:** secrets never in argv/cwd/driver-config/initial-input/labels/correlation if hashed/persisted/displayed.
- Fold in the earlier DDL drift fixes (`capability_resolution_json`, `projection_status`, `projection_error`) while editing.

*cody's consistency pass is in progress (cross-doc dangling refs, hash-projection soundness, projection DTO naming).*

## Proposed change — Part B: env minimization (the real fix; impl phase)
This is what actually matters for secret hygiene, and it makes Part A's residual concerns disappear:

- **ASP:** gut `compilerPlacementEnv` — stop snapshotting `process.env`. Pass only the space/agent-**declared** overlay (e.g. `PI_CODING_AGENT_DIR`, `ASP_HOME`, model/routing flags) — config, not credentials.
- **Broker:** launched with the credentials the harness needs (from a secret store / launchd plist / HRC's env), passed through an extended `SAFE_INHERITED_ENV` allowlist; the harness **inherits** them.
- **Net:** the spec carries ~1–3 non-secret config vars. No operator shell, no credentials in the contract plane at all.
- **Sharpened spec hard-rule** (fold into Part A): *"ASP MUST NOT project the operator/ambient environment into the spec. The harness inherits ambient vars + credentials from the broker's launch environment (curated allowlist + external secret source). ASP carries only space/agent-declared config."*

---

## What this does NOT do
- Does **not** build a bespoke secret store / key manager — credentials live where they already do (Consul KV / launchd / external store); the broker is launched with them.
- Does not touch the legacy non-broker `asp run` path beyond the env-assembly fix.
- No impl changes in Part A; no changes at all until you approve. Spec first, impl second, both gated on review.

## Sequencing
1. ✅ Plan docs renamed `HISTORICAL_`.
2. ✅ Redline drafted + reconciled (`REDLINE_remove-redaction.md`); cody consistency pass underway.
3. ⏳ **You approve direction (Parts A + B)** → I apply spec edits → cody reviews the real git diff → you sign off → commit.
4. ⏳ Impl phase (after spec lands): `compilerPlacementEnv` minimization + broker-launch credentials; then fix/delete `redaction.ts`.

## Open decisions for you
- **A** — approve removing the redaction/digest subsystem from the spec (projection-based hashing replaces it)?
- **B** — approve env minimization as the real fix, and fold the sharpened hard-rule into the spec now?
- **D3** — `runtime_artifacts.redaction_state`: drop (recommended) vs rename to `projection_policy`?
