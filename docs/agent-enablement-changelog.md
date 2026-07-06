# Agent Enablement Changelog

Append-only ledger of reusable agent-enablement lessons for agent-spaces. One row per
substantial task, routing the primary lesson to exactly one carrier.

## Retro Cadence

After closing a **substantial** agent-spaces task, the coordinator appends exactly one
row to the Ledger below, routing the task's primary reusable lesson to exactly one
carrier. Keep it terse and structural — a lesson, not a status summary.

- **Substantial** = a task that changes code behavior, public/process docs, checks,
  tools, skills, runtime behavior, or project operating rules. Typo-only edits do not
  need a row.
- **Carriers** (choose exactly one): `doc` · `rule` · `skill` · `tool` · `check` · `TACIT`.
  Composite carriers are invalid — pick the place where the lesson is actually enforced
  (regression tests are `check`; typed/parse-boundary code is `tool`; prose-only is `doc`).
- **landing** must be concrete: a file path, check/script/test name, skill name, command,
  or — for `TACIT` — a short reason plus a revisit condition.
- Append new rows at the bottom. Do not sort or rewrite history (typo fixes only).

## Ledger

| date | task | lesson | carrier | landing |
| --- | --- | --- | --- | --- |
| 2026-06-14 | T-04388 | Repo-split and enablement invariants need machine-enforced verify gates, not review vigilance — install the check suite and mirror it in CI | check | `just check` → scripts/check-{boundaries,runtime-contract-harness-boundaries,manifest-edges,suppressions,doc-reachability,public-surface,rule-authoring}.ts |
| 2026-06-14 | T-04396 | CLI subprocess-wrapper tests flaked under options-overload; stabilize the wrappers and pin a regression test | check | packages/cli/src/__tests__/m6-agent-cli.test.ts |
| 2026-06-14 | T-04412 | Detaching `just verify` or running soak loops backgrounded (`just verify &`) in a shared worktree corrupts the box and yields phantom load-flake failures for other agents | rule | Coordinator operating convention — never run `just verify`/soak detached in a shared worktree |
| 2026-06-14 | T-04408 | Dispatch env ingress must be a typed parse-boundary (parse-don't-validate), not ad-hoc string env reads | tool | packages/harness-broker/src/runtime/env.ts |
| 2026-07-06 | T-05861 | Linked worktree installs must not mutate operator wrappers or downstream consumers; infer safe defaults from Git worktree context and prove the side-effect policy | check | scripts/install-policy.test.ts; scripts/publish-local-verdaccio.test.ts; linked-worktree `just install` smoke |
