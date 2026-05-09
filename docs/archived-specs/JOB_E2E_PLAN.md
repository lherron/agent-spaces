# Doc-Sweeper JobFlow — End-to-End Implementation Plan

Hand-off document for a fresh implementation session. This plan is **complete and self-contained**: it carries forward all context from the prior validation+patch session so the implementer does not need to re-derive anything.

## Goal

A scheduled JobFlow that documents one undocumented package per hour for ~24 hours.
Self-disables when no undocumented packages remain. Each run starts in fresh agent
context (no continuity reuse across runs).

## Context: where we are

- **Working directory:** `/Users/lherron/praesidium/agent-spaces`
- **Production ACP server (launchd):** `http://127.0.0.1:18470` — uses real HRC launcher.
- **Dev-flow validation server:** `http://127.0.0.1:18475` (only for engine validation; doc-sweeper does NOT use this).
- **Today:** 2026-04-28.
- **Recent state:** JobFlow MVP shipped (T-01305..T-01314). `step.fresh` engine work shipped (T-01315) — the Phase 0 prerequisite is done. JobFlow OS exec + exit-status branching shipped (T-01316..T-01321), gated on `ACP_JOB_FLOW_EXEC_ENABLED=1`; doc-sweeper does NOT need this for the MVP flow but it is available if a later refactor wants deterministic scan/self-disable steps. Phase-12 live validation ran in the prior session; results live in `JOB_FLOW_IMPL.md` §12. Two patches landed during validation:
  - `cli.ts:592` argv routing fix (was causing acp-server launchd flap; 2092 prior loops).
  - `scheduler.ts` auto-resume of in-flight flow JobRuns + `parseDurationMs` for `--timeout 5s` style suffixes.
  - New launcher `packages/acp-server/src/dev-flow-launcher.ts` (gated on `ACP_DEV_FLOW_LAUNCHER=1`).

## Hard requirements from product owner

1. Hourly cron, one package documented per fire, ~24 fires total.
2. Self-disable when no more packages need docs.
3. **Fresh context every run.** No carryover of cody continuation between fires.
4. Agent: `cody` (codex). Project: `agent-spaces`. Taskless scope.
5. Discord delivery to the agent-spaces channel via existing binding (verify).
6. Pre-pre-flight smoke (validate every instruction is executable) before pre-flight smoke (full single flow run) before go-live.

## Phase 1 — Discord routing verification

Before doing anything else, the implementer must confirm:

```bash
acp bindings list --json | jq '.bindings[] | select(.scopeRef | startswith("agent:cody:project:agent-spaces"))'
```

Expected: at least one binding routing the cody/agent-spaces scope to a Discord channel. If none exists for `agent:cody:project:agent-spaces:role:doc-sweeper`, either:
- bind that exact scope to the agent-spaces channel (`acp bindings set ...`), or
- pick a closer existing binding (e.g. `agent:cody:project:agent-spaces`) and use that as the doc-sweeper scope.

Whichever path: both step replies (document + report) will auto-deliver to Discord since the gateway forwards every assistant `message_end` for bound scopes. Step 1 prompt is intentionally terse to keep step-1 Discord noise minimal.

## Phase 2 — Pre-pre-flight smoke (instruction executability)

Each smoke is a single one-shot turn against the production ACP server scoped to
`agent:cody:project:agent-spaces:role:doc-sweeper`. Use:

```bash
acp message send --scope-ref 'agent:cody:project:agent-spaces:role:doc-sweeper' --content '<prompt>'
```

(or whatever the equivalent send path is — implementer should confirm the exact
CLI shape; the goal is one-shot dispatch and assistant reply capture.)

**Smokes (run in order, fix and retry on any failure):**

| # | Prompt | Pass criteria |
|---|---|---|
| S0 | `List ./packages/ (top level only) and reply with the count and the first 5 names.` | Reply contains a number and 5 package names from `~/praesidium/agent-spaces/packages/`. |
| S1 | `Append "<ISO ts> | smoke-pre-pre-1" to ~/praesidium/agent-spaces/RUN_HISTORY.md (create if missing). Confirm the line you wrote.` | File now exists; line is present. |
| S2 | `Write ~/praesidium/agent-spaces/docs/refactor_smoke_test.md with one paragraph describing the wrkq package. Confirm.` | File exists, ~1 paragraph. Implementer deletes after. |
| S3 | `Reply with the literal text "pre-pre-flight smoke ping".` | Discord channel receives that exact text. **This is the executability check for "send to Discord".** No separate command needed — assistant text auto-delivers via the gateway. |
| S4 | `Run "acp job list --json" and tell me the count.` | Reply contains a number that matches `acp job list --json | jq '.jobs | length'` from your shell. Confirms agent has the `acp` CLI on PATH. |
| S5 | Pre-create a throwaway disabled job (e.g. cron `0 4 * * 1`, no flow), then: `Run "acp job patch --job <throwaway-id> --enabled" and confirm it succeeded.` | `acp job show --job <id>` reports `disabled: false`. Confirms self-disable capability. Implementer cleans up the throwaway. |

**If any smoke fails:**
- S0/S1/S2: cody can't navigate or write — investigate scope/agent root resolution.
- S3: Discord binding wrong — re-do Phase 1.
- S4/S5: `acp` CLI not on cody's PATH inside its session — fix agent-root resolver or include CLI install in the agent root.

**Update prompts based on findings.** If, e.g., S5 reveals cody needs an explicit `--server` flag or auth token, embed that into the document/report prompts.

## Phase 3 — Pre-flight smoke (full single flow run)

1. **Create the doc-sweeper job, disabled** (`step.fresh` is already implemented in T-01315):

```bash
curl -sS -X POST http://127.0.0.1:18470/v1/admin/jobs \
  -H 'content-type: application/json' \
  -d @- <<'EOF'
{
  "agentId": "cody",
  "projectId": "agent-spaces",
  "scopeRef": "agent:cody:project:agent-spaces:role:doc-sweeper",
  "laneRef": "main",
  "schedule": { "cron": "0 * * * *" },
  "input": { "content": "(unused — flow takes over)" },
  "disabled": true,
  "flow": {
    "sequence": [
      {
        "id": "document",
        "fresh": true,
        "input": "<DOCUMENT_PROMPT>",
        "expect": {
          "outcome": "succeeded",
          "resultBlock": "WORK_RESULT",
          "require": ["package", "doc_path", "status"]
        }
      },
      {
        "id": "report",
        "input": "<REPORT_PROMPT>",
        "expect": {
          "outcome": "succeeded",
          "resultBlock": "CLOSEOUT_RESULT",
          "require": ["delivered_to_discord", "history_appended"]
        }
      }
    ],
    "onFailure": [
      {
        "id": "notify_failure",
        "input": "<NOTIFY_FAILURE_PROMPT>",
        "expect": { "outcome": "succeeded" }
      }
    ]
  }
}
EOF
```

   Capture the returned `jobId` and substitute it into `<DOCUMENT_PROMPT>` for the self-disable command (option (a) — JobId injection at creation time).

2. **Run once manually:**

   ```bash
   acp job run --job <jobId> --wait
   ```

3. **Inspect:**
   - `docs/refactor_<picked>.md` exists; content covers purpose / surface / structure / deps / tests / recommendations and reads grounded.
   - `RUN_HISTORY.md` has both `started` and a terminal row for this run.
   - Discord channel has 2 messages: terse step-1 ack + step-2 summary.
   - `JobRun.status = succeeded`; both steps have parsed `result` objects matching the contract.

4. **Re-run a second manual fire:**
   - Confirm step `document` picked a **different** package (no duplicate).
   - Confirm cody's reply does NOT reference prior-run content (proves `fresh: true` worked). If the reply mentions prior packages from memory, the `step.fresh` engine path (T-01315) is regressing — STOP, file a defect, do not go-live.

5. **Failure path drill:** temporarily edit the prompt to force a result-block parse failure (e.g. require a field cody won't emit), trigger once, confirm `onFailure` notify_failure ran, JobRun ends in `failed`, `RUN_HISTORY.md` has the failure row, Discord got the failure message. Then revert the prompt.

## Phase 4 — Go-live

1. `acp job patch --job <jobId> --enabled`.
2. First fire: next UTC top-of-hour after enable.
3. Watch the first 3 hourly fires:
   - `acp job-run list --job <jobId>` shows new rows on schedule.
   - `acp job-run show --job-run <last> --steps --results` looks healthy.
   - Discord has the expected pair of messages per fire.
4. After 24 fires (or when packages run out, whichever first), confirm self-disable kicked in:
   - `acp job show --job <id>` reports `disabled: true`.
   - `RUN_HISTORY.md` last entry has `status: all_documented`.

If self-disable fails to trigger (e.g. Phase-1 validation showed `acp job patch` not available to cody), the manual fallback is to `acp job patch --job <id> --disabled` from the operator shell.

## Final prompts (copy verbatim into the job spec, after substituting `<JOB_ID>`)

### `<DOCUMENT_PROMPT>` for step `document`

```
Hourly automated doc-sweep. Working directory: ~/praesidium/agent-spaces.

1. Read RUN_HISTORY.md (create the file if it does not exist). Look for entries
   from the last 60 minutes that are marked "started" without a matching
   terminal row (a "documented", "all_documented", "skip_concurrent", or
   "failed" line for the same package within 60 minutes after). If you find
   one, this run overlaps with a still-in-progress run — stop immediately and
   emit ONLY the result block:

   WORK_RESULT
   {"package":"-","doc_path":"-","status":"skip_concurrent","files_examined":0,"recommendations":0}

2. Otherwise: list ./packages/ (top-level entries) and list ./docs/refactor_*.md.
   Compute the set of packages whose name has no corresponding
   docs/refactor_<name>.md file.

3. If that set is empty, every package is documented. Self-disable this job by
   running:

   acp job patch --job <JOB_ID> --disabled

   Confirm via "acp job show --job <JOB_ID>" that disabled=true. Then emit
   ONLY the result block:

   WORK_RESULT
   {"package":"-","doc_path":"-","status":"all_documented","files_examined":0,"recommendations":0}

4. Otherwise pick exactly ONE package from the undocumented set. Append a line
   to RUN_HISTORY.md with the format:

   <ISO timestamp> | <package> | started

   Then read the package thoroughly and write
   docs/refactor_<package>.md covering:
   - Purpose (one paragraph)
   - Public surface (exported symbols, HTTP routes, CLI commands as applicable)
   - Internal structure (key files and their responsibilities)
   - Dependencies (production + test)
   - Test coverage (count, gaps)
   - Recommended refactors and reductions: dead code, oversized files,
     duplicated logic, unclear boundaries, unused exports. Each
     recommendation must reference specific files/symbols you read. No
     speculative features.

5. Reply with one short sentence confirming what you did (e.g. "Documented
   foo at docs/refactor_foo.md.") and end your reply with EXACTLY this block
   (substitute real values):

   WORK_RESULT
   {"package":"<name>","doc_path":"docs/refactor_<name>.md","status":"documented","files_examined":<integer>,"recommendations":<integer>}
```

### `<REPORT_PROMPT>` for step `report`

```
The previous step's WORK_RESULT block describes what was just done. Read
docs/refactor_<package>.md (the doc_path from WORK_RESULT) and write a
Discord-friendly summary as your reply. This reply text is auto-delivered
to the agent-spaces Discord channel by the gateway — there is no separate
send command.

Format:
   📦 **<package>** — see docs/refactor_<package>.md
   Files examined: <n>
   Top recommendations:
   - <rec 1>
   - <rec 2>
   - <rec 3>

If status is "all_documented" or "skip_concurrent" the document step did no
real work; reply with one short sentence covering that and skip the bullets.

After the summary, append exactly one line to RUN_HISTORY.md:

   <ISO timestamp> | <package> | <status> | <doc_path>

End your reply with EXACTLY this block (substitute real values):

   CLOSEOUT_RESULT
   {"delivered_to_discord":true,"history_appended":true,"run_status":"<status from prior step>"}
```

### `<NOTIFY_FAILURE_PROMPT>` for step `notify_failure` (onFailure)

```
The doc-sweep sequence failed. Append one line to RUN_HISTORY.md:

   <ISO timestamp> | failed | <error_code or "unknown">

Reply text is auto-delivered to Discord — keep it brief, e.g.:

   ⚠️ doc-sweep run failed: <one-line reason>

End your reply with EXACTLY this block:

   CLOSEOUT_RESULT
   {"delivered_to_discord":true,"history_appended":true,"run_status":"failed"}
```

## Companion wrkq task (file before going live)

Title: `JobFlow scheduler concurrency policy`
Slug: `inbox/scheduler-concurrency-policy`

Body:

> **Problem.** `tickJobsScheduler` does not enforce per-job concurrency. If a
> JobRun is in-flight when the next cron tick fires, a second JobRun is created
> in parallel. Mitigations today live in user prompts (RUN_HISTORY.md soft-mutex
> for the doc-sweeper), which is fragile.
>
> **Proposal.** Add `Job.schedule.concurrency: "allow" | "skip_if_running" | "queue"`,
> default `allow` to preserve current behavior. Implement `skip_if_running` by
> checking for an existing JobRun with `status IN ('claimed','dispatched','running')`
> for the same `jobId` before claiming. `queue` deferred.
>
> **Acceptance.**
> - Unit: `skip_if_running` with one in-flight JobRun → tick produces 0 new runs.
> - Unit: `skip_if_running` with no in-flight JobRun → 1 new run.
> - Doc the contract in `acp-spec/spec/orchestration/JOB_FLOW.md`.
> - Manual validation against the dev-flow harness on port 18475.

## Open items the implementer should confirm at start

1. **JobId injection** for self-disable. Plan uses option (a): hardcode the
   jobId into `<DOCUMENT_PROMPT>` at creation time. Simple. Confirmed by user.
2. **Discord noise from step 1.** Step 1 reply is intentionally terse so the
   step-1 Discord message is just one short ack line. If even that is too
   noisy, future work could add per-step delivery suppression. Not in scope.
3. **Continuation semantics within a job (already implemented).**
   `step.fresh: true` rotates the cody continuation only for that step (via
   HRC `clearContext({dropContinuation: true})` immediately before
   `/v1/inputs` dispatch). Subsequent agent steps in the same JobRun
   dispatch against the same `(scopeRef, laneRef)` and naturally inherit the
   continuation built by the prior agent step — so step 2 of the doc-sweeper
   already sees cody's WORK_RESULT block from step 1 without any
   prompt-side gymnastics. Practical implication: put `fresh: true` on the
   first step only; later steps in the same fire stay in the same
   conversation. Across hourly fires, the first step's `fresh: true`
   guarantees the clean slate the product owner requires.

4. **Optional: refactor scan/self-disable as exec steps.** Now that JobFlow
   supports `kind: "exec"` with exit-status branching (T-01316..T-01321),
   the deterministic parts of `<DOCUMENT_PROMPT>` (RUN_HISTORY soft-mutex,
   package listing, self-disable) could be hoisted out of the agent turn into
   exec steps that branch on exit code. This trims the agent prompt and makes
   self-disable verifiable from `result_json`. The only data-flow gap is at
   the exec→agent boundary: exec stdout lives in `result_json` rather than
   HRC continuation, so a downstream agent step would have to read job-run
   state or re-list packages itself (agent→agent boundaries are unaffected
   per item #3). Recommendation: keep the agent-only flow for the MVP
   doc-sweeper; revisit after first 24h of fires.

## Files the implementer will touch (doc-sweeper creation only — `step.fresh` engine is already in main)

- The engine work for `step.fresh` is already in main (T-01315). No core/jobs-store/server/HRC source edits needed for this plan.
- Job spec lives in the curl payload in §Phase 3 — no source files to add for the doc-sweeper itself.
- If pursuing the optional exec-step refactor (Open item #3), add a small `scripts/doc-sweeper-scan.ts` or similar pure-node script that the exec step invokes. No source edits beyond that script and the job spec. Note: prod ACP launchd plist must export `ACP_JOB_FLOW_EXEC_ENABLED=1` for exec steps to dispatch.

## How to verify success at the end

After 24 hourly fires (or earlier if packages run out):
- `RUN_HISTORY.md` has 24 (or fewer if packages run out) terminal rows + 1 `all_documented` row when self-disable fires.
- `docs/` contains `refactor_<pkg>.md` for every previously-undocumented package.
- `acp job show --job <id>` reports `disabled: true` (auto-disabled by the agent).
- Discord channel has roughly 2 messages per fire.
- `acp job-run list --job <id> --json | jq '.jobRuns[].status'` shows mostly `succeeded`. A few `failed` rows are acceptable if cody had a transient issue (the failures will have been reported to Discord by `notify_failure`).

## What to hand back to the operator at the end

A short summary message:
- Number of packages newly documented.
- Total runs (succeeded / failed / skip_concurrent).
- Any package that consistently failed (signal of bad prompt or weird package).
- Confirmation that the job is now disabled.
- Pointer to `RUN_HISTORY.md` for the audit trail.
