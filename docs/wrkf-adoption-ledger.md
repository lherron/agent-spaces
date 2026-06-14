# wrkf adoption ledger — `agent-spaces-closeout` (TF / plan §13)

Tracking task: **T-04415** (TF — wrkf adoption experiment). Mechanism: **T-04441** built + installed
`agent-spaces-closeout@1` (extends `wrkq-code-change@1`), a wrkf task workflow that gates the `done`
transition on closeout evidence covering the task's strongest surface.

This ledger is the TF experiment's measurement record: **rework reduction vs adoption overhead** for each
real agent-spaces task routed through the workflow. It is seeded by the first dogfooded task and grows as the
5–10 task measurement tail (filed as a follow-up) lands.

## Workflow lifecycle (for operators)

```
open/intake --author_red(tester:red_test)--> active/red
            --implement(implementer:verify)--> active/verify
            --full_verify(tester:verify_full)--> active/review   [opens blocking obligations: review_signoff, closeout_evidence]
            --sign_off(reviewer:installed_binary+review_signoff+closeout_claim, --run-checks)--> closed/done
                                                                 [effect: set_task_state=completed]
```
Separation of duty enforced: `red_test` actor ≠ `verify` actor; `verify` actor ≠ `verify_full` actor.
The `closeout_evidence_coverage` check must pass (exit 0) for the `sign_off` → `done` outcome to fire.

## Attached tasks (`wrkf task attach agent-spaces-closeout@1`)

| Task | Title (abbrev) | Instance | Attached | Routed through? |
|---|---|---|---|---|
| T-04409 | agent-spaces pkg test timeout-flake | `wfi_t04409_1781473874687048000` | 2026-06-14 | ✅ dogfooded → `done` (see below) |
| T-04413 | TA actuator/credential split (hrc-infra design) | `wfi_t04413_1781473874666605000` | 2026-06-14 | pending — design task, not completable in-repo yet |
| T-04414 | TB skill lifecycle telemetry (frontier build) | `wfi_t04414_1781473874676951000` | 2026-06-14 | pending — frontier build, daedalus-gated |
| T-04438 | exercised catalog-adoption proof + manifest reconcile | `wfi_t04438_1781473874696692000` | 2026-06-14 | pending — candidate next dogfood |

## Measurement records (rework vs overhead)

Columns: **adoption overhead** = wall/operator cost added purely by routing through wrkf (evidence-exec +
transitions + role binding) over and above doing the bare task. **rework avoided** = defects/false-closes the
gate caught that would otherwise escape (the value side).

### T-04409 — agent-spaces package test timeout-flake (first dogfood)

- Routed: intake → red → verify → review → done, **fully through the gate** (`wfi_t04409_…687048000`).
- Code fix: larry, commit `1a0231d` (per-test 60000ms budget on 6 heavy agent-spaces subprocess suites; no skips/weakening).
- **Three genuinely distinct agents** (real role separation, not puppeted):
  - implementer `verify` = **larry** (ev_006976, exit 0, 260 pass/0 fail)
  - tester `red_test` = **clod** (ev_006975, exit 1, deterministic forced-tight-timeout repro of the budget-exhaustion mode) + `verify_full` = **clod** (ev_006977, exit 0)
  - reviewer `installed_binary` + `review_signoff` = **smokey** (ev_006982 exit 0, ev_006983 approved)
- closeout: `closeout_claim`=logic, `changed_files` floor=logic (`packages/*/src/**`); coverage check passed (logic ⇒ verify/verify_full green).
- Terminal: `sign_off --run-checks` → outcome `done`; effect `eff_004691` `set_task_state=completed` **delivered** → wrkq T-04409 = `completed`.

**Measurement — overhead vs rework (T-04409):**
- **Adoption overhead** (cost added purely by routing through wrkf, over and above the bare fix):
  - 1 role-bind ×3 + 4 transitions + ~10 evidence records.
  - **+2 extra agent turns** beyond the implementer: a coordinator tester pass (clod) and a dispatched independent reviewer (smokey). For a one-class fix this is heavy.
  - Friction encountered (adoption cost, real data):
    1. `wrkf obligation satisfy` takes the **obligation ID** (`obl_000489`), not its kind — first attempt failed.
    2. A **hidden separation-of-duty** rule (`verify_full` actor ≠ `review_signoff` actor) is NOT listed in the transition's `separationOfDuty` block; it only surfaced as a `WRKF_TRANSITION_BLOCKED` at `sign_off`, forcing a reviewer re-bind + re-dispatch (clod→smokey).
    3. `wrkf evidence exec` exits nonzero for a red command (correct, but surfaces as `Error: command exited 1 after recording evidence …` — the row IS recorded).
    4. Workers needed exact copy-paste `wrkf` command blocks; the CLI is not yet ergonomic for ad-hoc role-actor evidence. (See Scope B: closeout-client hardening.)
- **Rework avoided / value** (the gate's payoff): the gate **actively blocked** self-review (SoD), **enforced `data.exitCode==0`** real-command coverage (fabrication impossible), and **enforced surface-appropriate evidence** (logic ⇒ unit suite green). On a low-risk timeout bump the value is modest; on a higher-surface change (contract/runtime) the same machinery would block a false-close — which is the experiment's hypothesis to confirm over the 5–10 task tail.

<!-- LEDGER-ROW T-04409 done -->

## Adoption-overhead findings (qualitative, for the adopt-as-default decision)

<!-- filled at closeout -->

## Honest residual (do NOT mark TF done)

Per the §13 refusal, TF is **not done** until 5–10 live agent-spaces tasks route through the workflow over
time, and catalog N=2 graduation needs a 2nd project. Those are time/volume-bound and cannot be faked in one
pass. The follow-up task tracks that tail.
