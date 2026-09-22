# Dead-Code Analysis Campaign Runbook

This runbook describes how to perform a package-complete, read-only dead-code
analysis of the agent-spaces monorepo with task-scoped Cody sessions. It is based
on the September 2026 `deadcode-analysis` campaign, which completed 35 analysis
tasks and produced 21 reviewed implementation tasks in `deadcode-fix`.

The analysis campaign proves reachability and creates work. It does not remove
code. Implementation belongs in the follow-on fix campaign.

## Desired outcome

At closeout:

- every production source package and shared runtime boundary has an explicit
  analysis owner;
- every analysis task records the exact repository HEAD it examined;
- every apparent dead-code candidate is either retained with a reason or
  represented by one implementation-ready fix task;
- published, serialized, process-discovered, and externally consumed surfaces
  are not declared dead from local import counts alone;
- the analysis campaign is completed;
- accepted fixes are open in an active fix campaign; and
- the repository has no analysis-created source changes or stray reports.

## Operating model

Use two sibling campaigns:

| Campaign | Initial state | Purpose |
| --- | --- | --- |
| `deadcode-analysis` | active | Read-only atlas, package audits, and final reconciliation |
| `deadcode-fix` | draft | Implementation tasks created by the audits |

Use one wrkq task and one fresh Cody task-scoped session for each independently
verifiable analysis scope. Maintain four or five active Cody sessions while
work remains. Do not make ordinary analysis tasks depend on earlier analysis
tasks: they can independently inspect public and dynamic roots at HEAD. The
only fan-in dependency is the final reconciliation task.

Each audit analyzes the repository HEAD visible when it starts and records that
SHA. Do not require every task to use a preselected commit unless the campaign
specifically needs a frozen snapshot. If HEAD changes during an audit, the task
must either continue against its recorded revision or document and reconcile
the material drift.

## Phase 1: Preflight and scope inventory

1. Confirm the project and repository state:

   ```bash
   pwd
   git status --short
   git rev-parse HEAD
   wrkq projects --json
   ```

2. Inventory source packages and runtime groupings under:

   - `contracts/*`
   - `core/*`
   - `drivers/*`
   - `compiler/*`
   - `harness/*`
   - `apps/*`

3. Read package manifests and identify boundaries that do not align neatly with
   directories: bins, package subpaths, barrels, registries, generated bridges,
   prepack behavior, spawned executables, resources, serialized discriminants,
   and consumers in HRC or ACP.

4. Split the work into scopes small enough for one Cody turn. A scope may be a
   package or a cohesive subsystem within a large package. Prefer roughly 30–35
   tasks over a few broad audits when that is what complete coverage requires.

5. Reserve three campaign-wide tasks:

   - a public/package entrypoint atlas;
   - an external/dynamic consumer atlas; and
   - a final reconciliation task.

The two atlas tasks are reusable evidence, not prerequisites for package audits.
They can run in parallel with the package work.

### First-campaign scope map

The first campaign used the following 35-task decomposition. Reuse it as a
starting inventory, then adjust for packages added, removed, or materially
reshaped since the previous run.

| Area | Analysis tasks |
| --- | --- |
| Campaign atlases | Public/package entrypoints; external/dynamic consumers |
| Contracts | Agent scope; ASPC protocol; broker client; broker protocol; HRC join client; runtime contracts |
| Core | Config schemas/contracts; config resolution/store; config materialization/lint; spaces runtime |
| Drivers | Execution; Claude harness; Codex harness; Muse harness; Pi harness; Pi SDK harness |
| Compiler | Runtime/client paths; adapters/harness selection/turn support |
| Harness and broker | Agent-harness runtime; agent-harness executable; ASPC service; ASPC facade; broker Pi SDK bridge; broker core/runtime; broker agent/Claude drivers; broker Codex drivers; broker Pi/Muse/Arris drivers |
| Apps and CLI | CLI kit; turn runner; CLI public registry; CLI run/runtime paths; remaining CLI commands/packaging |
| Fan-in | Final campaign reconciliation |

The table is an ownership map, not a dependency chain. Adjacent tasks should
cross-check shared boundaries, while the reconciler resolves any overlap and
confirms one canonical owner for every production file.

## Phase 2: Create the campaigns

Create ordinary containers, then convert them to campaigns. Capture the IDs
returned by wrkq and substitute them for `<ANALYSIS_CAMPAIGN>` and
`<FIX_CAMPAIGN>` below.

```bash
wrkq mkdir agent-spaces/deadcode-analysis --kind feature
wrkq campaign convert agent-spaces/deadcode-analysis \
  --state active \
  --labels 'deadcode,analysis,cody' \
  -d 'Read-only Cody dead-code analysis; each task records and analyzes HEAD at task start.'

wrkq mkdir agent-spaces/deadcode-fix --kind feature
wrkq campaign convert agent-spaces/deadcode-fix \
  --state draft \
  --labels 'deadcode,refactor' \
  -d 'Implementation backlog produced by the dead-code analysis campaign.'
```

Add a complete campaign specification with `wrkq campaign edit`. The analysis
specification should state:

- one independent analysis scope and one Cody turn per task;
- read-only operation;
- outside-in reachability analysis;
- distinct production, type-only, test-only, fixture, script, packed, dynamic,
  serialized, and external edges;
- same-turn creation of draft fix tasks;
- coverage-backed zero-finding reports when nothing is actionable; and
- final reconciliation before either campaign changes state.

Use a quoted heredoc whenever Markdown contains backticks or shell syntax:

```bash
wrkq campaign edit <ANALYSIS_CAMPAIGN> --specification - <<'EOF'
## Objective

Examine every agent-spaces source package for dead code using task-scoped Cody
sessions.

## Operating contract

- Analysis is read-only.
- Each task analyzes HEAD at task start and records the exact SHA.
- Missing local imports do not prove public, serialized, or dynamic code dead.
- Every actionable finding creates a draft task in <FIX_CAMPAIGN>.
- Close only after campaign-wide reconciliation.
EOF
```

## Phase 3: Create the analysis tasks

Create every task before dispatch begins. This makes coverage review and
concurrency management straightforward.

Recommended task kinds and priorities:

- `spike`, priority 1: the two atlases;
- `spike`, priority 2: package and subsystem audits; and
- `task`, priority 1: final reconciliation.

Example:

```bash
wrkq touch inbox/runtime-contracts-deadcode \
  --campaign <ANALYSIS_CAMPAIGN> \
  --state open \
  --priority 2 \
  --kind spike \
  --labels 'deadcode,analysis,cody,contracts' \
  --meta '{"model":"cody","fixCampaign":"<FIX_CAMPAIGN>","revisionPolicy":"analyze HEAD at task start and record exact SHA"}' \
  -t 'Audit runtime contracts for dead code' \
  -d 'Read-only dead-code analysis scope for one fresh Cody task session. Findings must become draft tasks in deadcode-fix.' \
  --specification - <<'EOF'
## Objective

Vigorously examine the assigned source scope for dead files, symbols, exports,
dependencies, compatibility layers, impossible branches, pass-through
abstractions, and post-contract-rework residue.

## Revision and evidence inputs

- Analyze repository HEAD visible when this task starts and record the exact SHA
  in opening and final evidence.
- If HEAD changes, continue against the recorded revision where practical or
  document and reconcile material drift.
- The public/package and external/dynamic atlas tasks are reusable evidence, not
  completion prerequisites.

## Exact scope

<List exact directories, files, tests, scripts, manifests, and consumers.>

## Scope notes

<Name public contracts, serialized data, registries, processes, resources, or
other non-obvious roots.>

## Required method

- Read every production source file in scope and the related evidence needed to
  interpret it.
- Enumerate public, package, process, and runtime roots before tracing inward.
- Build production-only and all-reference views.
- Separate type-only, test-only, fixture, script, packed, dynamic, serialized,
  and external edges.
- Treat import graphs and unused-symbol probes as candidate generators, never
  conclusions.
- Pressure-test every candidate and state its contraindication.
- Do not edit source, manifests, baselines, generated files, lockfiles,
  installations, or services.

## Mandatory fix-task handoff

For every actionable finding, create a separate implementation-ready task in
<FIX_CAMPAIGN> with state `draft`. Label it `deadcode`, `refactor`, an area
label, and one disposition label: `private`, `public-contract`,
`compatibility`, or `runtime`.

Each fix task must reference this analysis task and its analysis SHA; name exact
locations, reachability evidence, public impact, preservation mechanism,
contraindication, acceptance criteria, and required validation. Check the fix
campaign before creating a task so findings are not duplicated.

If there are no actionable findings, record a coverage-backed zero-finding
statement. Do not invent a fix task.

## Acceptance criteria

- Every scoped production file is accounted for.
- Public and runtime roots have independent evidence.
- Every candidate is classified as fix, retain, compatibility-only,
  public/external-proof-required, or runtime-uncertain.
- Every finding has a read-back-verified draft fix-task ID.
- The final comment lists coverage, exclusions, retained suspicious code, and
  created or reused fix-task IDs.
- The owning Cody session completes the task only after evidence is durable.
EOF
```

### Choosing task boundaries

A good task has one coherent reachability boundary. Examples include:

- one small published contract package;
- config schemas versus config resolution/materialization;
- one harness driver;
- compiler runtime paths versus compiler adapters and selection;
- broker core versus groups of concrete drivers;
- CLI registry/public surface versus CLI run paths versus remaining commands;
  and
- one executable application.

Avoid a task called “audit the monorepo” and avoid artificial dependencies
between read-only audits. Shared files may be examined by more than one task,
but reconciliation must name one canonical coverage owner and treat other reads
as deliberate boundary review.

## Fix-task format

Every positive finding becomes its own task unless several symbols share one
removal mechanism and validation boundary.

```bash
wrkq touch inbox/<finding-slug> \
  --campaign <FIX_CAMPAIGN> \
  --state draft \
  --priority 2 \
  --kind task \
  --labels 'deadcode,refactor,<area>,<disposition>' \
  -t '<Imperative removal title>' \
  -d 'Discovered by <ANALYSIS_TASK> at <ANALYSIS_SHA>.' \
  --specification - <<'EOF'
## Origin

- Analysis task: <ANALYSIS_TASK>
- Analysis SHA: <ANALYSIS_SHA>

## Exact scope

<Exact files, symbols, branches, exports, or dependencies.>

## Reachability evidence

<Why the code is not reached in production, public, packed, dynamic,
serialized, external, or process-driven paths.>

## Public impact and preservation

<State whether this is private. For public or external surfaces, require
downstream proof or an Expand/Contract sequence.>

## Contraindication

<The strongest reason the candidate might still be live and how it was ruled
out or must be preserved.>

## Acceptance criteria

- <Precise behavior-preserving change.>
- <Surfaces that must remain unchanged.>
- <Required tests, typechecks, boundary checks, pack checks, or real smoke.>
EOF
```

Read the new task back immediately:

```bash
wrkq cat <FIX_TASK> --json --one
wrkq find --campaign <FIX_CAMPAIGN> --state all --limit 100 --json
```

## Phase 4: Dispatch Cody sessions

Assign and dispatch one fresh task-scoped Cody session per analysis task. Use
the full destination handle so the task owns an isolated runtime:

```bash
wrkq set <TASK_ID> --assignee cody --as agent:cody

wrkc say <TASK_ID> \
  --to cody@agent-spaces:<TASK_ID> \
  --as agent:cody \
  --wait \
  --timeout 5m \
  --record - <<'EOF'
Execute <TASK_ID> exactly as specified.

Own this read-only Cody analysis task. Analyze HEAD at task start and record its
SHA. Trace public, package, runtime, process, dynamic, resource, serialized,
external, and test roots before declaring code dead. Create and read back every
warranted draft task in the fix campaign. Add durable evidence and complete the
task only after all acceptance criteria are satisfied. Do not edit source or
dispatch downstream implementation.
EOF
```

`--record` preserves the dispatch on the task. `--wait --timeout 5m` provides a
bounded delivery wait and avoids rapid goal-turn churn. A timeout means the
session is still working unless task or envelope evidence says otherwise.

### Concurrency loop

1. Start four tasks.
2. Add a fifth when the first four are healthy and scopes do not contend for
   writes. These audits are read-only, so package overlap is primarily a
   coverage concern rather than a filesystem conflict.
3. Monitor the active task IDs for five minutes:

   ```bash
   wrkq monitor wait <TASK_1> <TASK_2> <TASK_3> <TASK_4> <TASK_5> \
     --until all-terminal \
     --timeout 5m \
     --output json
   ```

4. On timeout, read task state and evidence. Do not treat the timeout as task
   failure.
5. Acknowledge reply-required completion mail using the envelope's exact
   `replyTo`:

   ```bash
   wrkc say <ENVELOPE_ID> \
     --to cody@agent-spaces:<TASK_ID> \
     --as agent:cody \
     --fyi - <<'EOF'
   Acknowledged. The audit evidence and fix-task handoff are recorded for
   campaign reconciliation.
   EOF
   ```

6. Read the completed task, verify its final comment and fix-task readbacks,
   then refill the free slot with the next open analysis task.
7. Continue until only reconciliation remains.

Useful state summaries:

```bash
wrkq find --campaign <ANALYSIS_CAMPAIGN> --state all --limit 100 --json \
  | jq -r 'group_by(.state)[] | "\(.[0].state) \(length)"'

wrkq find --campaign <FIX_CAMPAIGN> --state all --limit 100 --json \
  | jq -r 'group_by(.state)[] | "\(.[0].state) \(length)"'

wrkc inbox
```

## Evidence standard for each audit

A credible dead-code report must include all of the following:

1. **Revision:** start SHA, final SHA, and drift disposition.
2. **Coverage:** count or enumerate every production file in scope and name
   directly relevant tests, fixtures, scripts, resources, and consumers.
3. **Roots:** package exports, bins, barrels, registries, dynamic imports,
   process spawning, resource lookup, generated bridges, serialized values, and
   downstream HRC/ACP uses as applicable.
4. **Reference classes:** production, type-only, test-only, fixture, script,
   packed, dynamic, serialized, and external.
5. **Candidate disposition:** fix, retain, compatibility-only,
   public/external-proof-required, or runtime-uncertain.
6. **Contraindication:** the strongest evidence that could make each candidate
   live.
7. **Handoff:** created or reused fix-task IDs, or a coverage-backed statement
   that no fix is warranted.
8. **Validation:** relevant typecheck, focused tests, boundary checks,
   public-surface checks, manifest checks, pack checks, or real CLI smoke.
9. **Mutation check:** confirmation that the audit did not modify the repo or
   operational state.

Static tools can find candidates; they cannot establish deadness by themselves.
In particular, a public export with no local importer is
`public/external-proof-required`, not dead.

## Phase 5: Reconcile the campaign

Do not dispatch reconciliation until every other analysis task is terminal.
Verify the prerequisite count first:

```bash
wrkq find --campaign <ANALYSIS_CAMPAIGN> --state all --limit 100 --json \
  | jq -r 'group_by(.state)[] | "\(.[0].state) \(length) \([.[].id] | join(","))"'
```

The reconciliation task must:

- read every atlas and package audit record;
- prove every production scope has a canonical owner;
- verify recorded HEADs and resolve material drift;
- reconcile local findings with public/package and external/dynamic atlases;
- read every fix task in full;
- verify origin, SHA, exact scope, reachability evidence, public impact,
  preservation mechanism, contraindication, acceptance criteria, labels, state,
  and campaign membership;
- merge, relate, re-scope, or reject duplicate and vague findings;
- require downstream proof or Expand/Contract for public removals;
- create missing fix tasks if reconciliation discovers a real gap;
- promote accepted fix tasks from `draft` to `open` only after the full review;
- activate the fix campaign after promotion succeeds; and
- complete the analysis campaign only after all evidence is durable.

Dispatch it alone with the same task-scoped pattern:

```bash
wrkq set <RECONCILIATION_TASK> --assignee cody --as agent:cody

wrkc say <RECONCILIATION_TASK> \
  --to cody@agent-spaces:<RECONCILIATION_TASK> \
  --as agent:cody \
  --wait \
  --timeout 5m \
  --record - <<'EOF'
Execute the reconciliation task exactly as specified. Read every analysis
record and the entire fix backlog. Verify coverage, revision evidence, public
and external preservation, task quality, and duplicates. Promote only accepted
fixes, activate the fix campaign, and close the analysis campaign only after
durable readback. Do not edit source or dispatch implementation.
EOF
```

Monitor it with `--until all-terminal`, even though it is a single task. In the
current CLI, `--until terminal` selects envelope semantics.

## Phase 6: Final verification

Independently verify the reconciler's result:

```bash
wrkq cat <RECONCILIATION_TASK> --json --one

wrkq find --campaign <ANALYSIS_CAMPAIGN> --state all --limit 100 --json \
  | jq -r 'group_by(.state)[] | "\(.[0].state) \(length)"'

wrkq find --campaign <FIX_CAMPAIGN> --state all --limit 100 --json \
  | jq -r 'group_by(.state)[] | "\(.[0].state) \(length)"'

wrkq log <ANALYSIS_CAMPAIGN> --limit 10
git status --short
git rev-parse HEAD
```

Expected end state:

- all analysis tasks are `completed` or have an explicitly accepted terminal
  disposition;
- the analysis campaign has a `campaign_state_changed` event to `completed`;
- the fix campaign is active;
- every accepted fix is `open`;
- no fix remains an accidental draft;
- no analysis-created repository mutation remains; and
- final campaign evidence gives the task and fix counts.

## Artifact hygiene

Do not leave analysis reports as untracked repository files. Write them directly
to the owning task artifact directory:

```text
/Users/lherron/praesidium/var/wrkq-artifacts/<TASK_ID>/<descriptive-name>.md
```

If a report was accidentally written into the checkout:

1. move only that exact untracked file into its task artifact directory;
2. calculate its SHA-256;
3. add a task comment with the final path and hash;
4. verify the old path no longer appears in `git status`; and
5. preserve unrelated tracked and untracked work.

This matters because canonical installation and publication require a clean
main checkout.

## Lessons from the first campaign

- Analysis-only tasks do not need predecessor dependencies. Requiring them
  serializes independent evidence collection without improving correctness.
- Per-task HEAD capture is more flexible than pinning all tasks to one commit.
  In the first run, every task happened to analyze
  `631e7b246aaede313ee6e0aacd71e766f26ae07c`, but that was an observed result,
  not a dispatch requirement.
- Four to five Cody sessions kept throughput high without making supervision
  noisy. Refill completed slots rather than launching the entire campaign at
  once.
- Five-minute `wrkc --wait` and `wrkq monitor wait` intervals reduce needless
  polling. A timeout is a prompt to inspect, not a failure verdict.
- Use exact task-scoped handles and exact reply targets. A final assistant
  message does not discharge wrkc mail.
- Read the fix campaign before creating each finding. The first campaign ended
  with 21 canonical fixes and no duplicates after reconciliation.
- Public-surface and manifest checks are supporting evidence, not proof that an
  unreferenced public API is removable.
- Do not dispatch fixes from the analysis campaign. Reconciliation decides
  which drafts become an active implementation backlog.

## First-campaign reference result

The September 2026 run closed with:

- 35/35 completed analysis tasks;
- 21 accepted, open fix tasks;
- `deadcode-analysis` completed;
- `deadcode-fix` active;
- no analysis-time source, manifest, generated, lockfile, installation, or
  service mutation; and
- all analysis reports moved out of the checkout into task artifact storage.
