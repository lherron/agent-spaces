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
- **Recent state:** JobFlow MVP shipped (T-01305..T-01314). Phase-12 live validation ran in the prior session; results live in `JOB_FLOW_IMPL.md` §12. Two patches landed during validation:
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

## Phase 0 — Prerequisite engine work: `step.fresh`

**Why:** Cody continuation is keyed by `(scopeRef, laneRef)` and survives across runs within the 24h auto-rotation window. The doc-sweeper's hourly cadence falls inside that window, so without intervention every fire reuses the same conversation. The product owner has stated fresh context is a hard requirement.

**Design:**

- Add `JobFlowStep.fresh?: boolean` to `acp-core` types (`packages/acp-core/src/models/job.ts`).
- Validator (`packages/acp-jobs-store/src/flow-validation.ts`) accepts the field; no other constraints.
- Flow engine (`packages/acp-server/src/jobs/flow-engine.ts` + `dispatch-step.ts`): when a step has `fresh === true`, before dispatching call a new HRC client method to discard the active session's continuation. The cleanest contract is **rotate the session generation**:
  - New HRC HTTP method `POST /v1/sessions/rotate-generation` with body `{sessionRef: {scopeRef, laneRef}}`. Server-side: insert a new row in `sessions` with `generation = current+1`, `prior_host_session_id = old`, `continuation_json = NULL`. Mark the old session inactive.
  - Add `rotateSessionGeneration` to `AcpHrcClient` Pick in `acp-server/src/deps.ts`.
  - Engine path: `if (step.fresh) await deps.hrcClient.rotateSessionGeneration({sessionRef})` immediately before `dispatchStepThroughInputs`.
- Migration-free: `flow_json` is a TEXT blob, the new field rides inside it.

**Tests:**

- Unit: validator accepts `{fresh: true}`; engine calls `rotateSessionGeneration` when set.
- Unit (HRC server): rotate increments generation, nulls continuation, creates parent link.
- E2E: extend `packages/acp-e2e/test/jobflow-mvp.test.ts` with a fresh-session scenario.

**Estimated effort:** ~2 hours (small change, well-scoped).

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

1. **Create the doc-sweeper job, disabled, with `Phase 0` engine work in place:**

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
   - Confirm cody's reply does NOT reference prior-run content (proves `fresh: true` worked). If the reply mentions prior packages from memory, Phase 0 is broken — STOP, fix, re-smoke.

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

## Companion wrkq task (file before starting Phase 0)

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

1. **Phase 0 design choice.** I've proposed `step.fresh: true` triggering an HRC
   `rotateSessionGeneration` call. An alternative is an engine-only hack:
   pre-step that calls `hrcClient.terminate` AND nulls `continuation_json` via
   a direct sqlite write. The HRC API approach is correct; the sqlite hack is
   a stopgap. Pick the API approach unless time-pressured.
2. **JobId injection** for self-disable. Plan uses option (a): hardcode the
   jobId into `<DOCUMENT_PROMPT>` at creation time. Simple. Confirmed by user.
3. **Discord noise from step 1.** Step 1 reply is intentionally terse so the
   step-1 Discord message is just one short ack line. If even that is too
   noisy, future work could add per-step delivery suppression. Not in scope.
4. **HRC db path for `step.fresh` testing.** The dev-flow harness uses an
   in-process fake launcher; engine-level fresh-session work needs HRC server
   changes too, and end-to-end testing of fresh-session via real cody requires
   the launchd ACP. Plan accordingly.

## Files the implementer will touch (Phase 0 + doc-sweeper creation)

- `packages/acp-core/src/models/job.ts` — add `JobFlowStep.fresh?: boolean`.
- `packages/acp-jobs-store/src/flow-validation.ts` — accept the field.
- `packages/acp-server/src/jobs/dispatch-step.ts` (or `flow-engine.ts`) — call rotate when set.
- `packages/acp-server/src/deps.ts` — extend `AcpHrcClient` Pick with `rotateSessionGeneration`.
- `packages/hrc-sdk/src/index.ts` — add the client method.
- `packages/hrc-server/src/handlers/sessions-rotate-generation.ts` — new handler (or extend an existing sessions handler).
- `packages/hrc-server/src/routes.ts` — register route.
- Tests in each of the above where appropriate.
- `acp-spec/spec/orchestration/JOB_FLOW.md` — document the new field.
- No migrations needed (flow_json is a JSON blob).

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
