
Status: completed on 2026-05-09. Detailed command results are recorded in
`docs/acp-workflow-verification.md`.

Checkpoint 1 — invariant extraction — completed
- Create tests/conformance/acp-workflow/README.md or equivalent.
- Extract the spec into a concise invariant list grouped by:
  - WorkflowDefinition publishing/pinning,
  - Task state model,
  - transitionId kernel semantics,
  - evidence,
  - obligations/waiting,
  - role binding authorization and SoD,
  - idempotency/version/context hash,
  - EffectIntent outbox,
  - ParticipantContext,
  - SupervisorContext,
  - WorkflowControlAction,
  - WorkflowPatchProposal and immutable workflow evolution.
- Each invariant must map to at least one test or explicitly be marked out-of-scope with rationale.

Checkpoint 2 — workflow fixtures — completed
- Add at least three WorkflowDefinition fixtures:
  1. basic@1 — minimal durable generic task workflow.
  2. code_defect_fastlane@1 or code_feature_tdd@1 — code workflow with implementer/tester SoD, evidence, handoff effect, and closed success.
  3. external_dependency_or_approval@1 — workflow with waiting + blocking obligation for human approval, external vendor response, deployment window, or child-task join.
- Include at least one scenario outside the current scenario list, such as:
  - procurement/legal approval,
  - support escalation requiring customer response,
  - research/evaluation campaign with inconclusive outcome,
  - incident mitigation with postmortem obligation,
  - child-task fanout/join.
- Each fixture must be immutable once published in tests and referenced by id/version/hash.

Checkpoint 3 — conformance tests before implementation — completed
- Write failing tests for:
  - Task creation pins workflow id/version/hash and never stores mutable latest.
  - Durable generic tasks use basic@1, not preset-less lifecycle mutation.
  - WorkState is { status, phase?, outcome? } with status open|active|waiting|closed.
  - completed/cancelled/failed are closure outcomes, not statuses.
  - ApplyTransition uses transitionId, not toPhase.
  - Transition rejects invalid from-state.
  - Transition rejects missing evidence.
  - Transition rejects actor self-asserting unbound role.
  - SoD rejects same actor for implementer/tester when required.
  - Idempotency semantics: replay same payload, conflict different payload, reject missing key.
  - Version/context hash conflict semantics.
  - waiting status requires or is caused by open blocking Obligation/Wait.
  - Obligation resolution enables valid resume when workflow defines it.
  - EffectIntent outbox records handoff/wake/launch-child/emit-event without immediate side-effect coupling.
  - ParticipantContext golden JSON includes legal command templates and unavailable transition rejection reasons.
  - SupervisorContext golden JSON includes allowed control actions, suggestions, obligations, evidence, participant runs, anomalies, and exact command templates.
  - Supervisor action applies one checked action at a time.
  - WorkflowPatchProposal records anomaly-driven workflow improvement without mutating active WorkflowDefinition.
- Run the tests and confirm they fail for the expected reasons before implementation, unless the repo already satisfies some invariants.

Checkpoint 4 — implement until conformance passes — completed
- Implement the smallest kernel and runtime surfaces that satisfy the conformance suite.
- Implemented the new conformance kernel in `packages/acp-core/src/workflow`.
- Compatibility note: existing CLI/server/wrkq preset APIs are not migrated by
  this patch. The conformance kernel is the new workflow model under test and
  does not store `workflowPreset`, `presetVersion`, or `lifecycleState` as its
  durable workflow truth.

Checkpoint 5 — scenario tests — completed
- Add end-to-end tests for at least three scenarios:
  1. Happy-path code workflow: create Task -> participant implementer evidence -> transition -> handoff effect -> tester evidence -> closed success.
  2. Missing evidence recovery: transition rejected -> supervisor relaunches/request evidence or creates obligation -> eventual legal transition or waiting state.
  3. External dependency/approval workflow: Task enters waiting with blocking obligation -> obligation satisfied/waived -> resume/close.
- Add one scenario outside current code workflows, selected from the fixture set above.
- Scenario tests must verify the audit ledger: Task state, TransitionEvents, EvidenceArtifacts, Obligations, EffectIntents, and patch proposals/anomalies if applicable.

Checkpoint 6 — agent-facing context verification — completed
- Golden-test ParticipantContext for at least two states:
  - active work available,
  - blocked by missing evidence/obligation.
- Golden-test SupervisorContext for at least three states:
  - clean happy path,
  - participant failure/missing evidence,
  - no legal transition/anomaly.
- Contexts must be structured and command-oriented. They must not require agents to infer legal moves from prose.
- Command templates must include taskId, transitionId/action kind, expectedVersion or contextHash, run/actor identity where available, and idempotency prefix/key guidance.

Checkpoint 7 — docs and developer ergonomics — completed
- Document how to run the conformance suite.
- Document how to add a new WorkflowDefinition fixture.
- Document how to add a supervisor recovery scenario.
- Document any intentional deviations from cp-final-workflow-ecosystem-proposal.md and whether they are temporary.
- Legacy references to `lifecycleState`, `workflowPreset`, and `presetVersion`
  remain in non-migrated compatibility helpers and tests. Public task workflow
  routes no longer expose the legacy route surface or `toPhase` mutation.

Verification commands:
- `bun test tests/conformance/acp-workflow` passed.
- `bun run --filter acp-core typecheck` passed.
- `bun run --filter acp-core build` passed.
- `bun run --filter acp-core test` passed.
- `bun run lint` passed with one existing warning in
  `packages/gateway-discord/src/session-events-manager.ts`.
- `bun run typecheck` passed.
- `bun run build` passed.
- `bun run test` was run, but unrelated 5s timeout tests fired under the
  broad package graph. The timed-out tests passed when rerun directly, and
  their packages passed when rerun package-scoped.
- `bun scripts/validate-scenarios.ts` passed with final line
  `>>> OVERALL: SCENARIO-VALIDATION PASS`.
- `bun test tests/conformance/acp-workflow/flow-presets-scenarios.test.ts`
  passed with 16 tests / 492 assertions.
- If generated code is used, run generation and verify no unexpected diff remains.
- If DB/schema migrations exist, run migration tests or at least schema validation.
- If tests require services unavailable in this environment, document exact commands and failure causes, and add local unit coverage where possible.

2026-05-09 durable runtime migration checkpoint — completed
- Files changed:
  - `packages/acp-core/src/workflow/index.ts`
  - `packages/acp-core/src/workflow/definitions.ts`
  - `packages/acp-core/src/index.ts`
  - `packages/acp-state-store/src/open-store.ts`
  - `packages/acp-state-store/src/repos/workflow-runtime-repo.ts`
  - `packages/acp-state-store/src/index.ts`
  - `packages/acp-server/src/workflow-runtime.ts`
  - `packages/acp-server/src/integration/workflow-effect-reconciler.ts`
  - `packages/acp-server/src/handlers/shared.ts`
  - `packages/acp-server/src/handlers/tasks-create.ts`
  - `packages/acp-server/src/handlers/tasks-evidence.ts`
  - `packages/acp-server/src/handlers/tasks-get.ts`
  - `packages/acp-server/src/handlers/tasks-promote.ts`
  - `packages/acp-server/src/handlers/tasks-transition.ts`
  - `packages/acp-server/src/handlers/tasks-transitions.ts`
  - `packages/acp-server/src/handlers/workflow-tasks.ts`
  - `packages/acp-server/src/routing/exact-routes.ts`
  - `packages/acp-server/src/routing/param-routes.ts`
  - `packages/acp-server/README.md`
  - `packages/acp-server/test/workflow-tasks.test.ts`
  - `packages/acp-server/test/launch-role-scoped.test.ts`
  - `packages/acp-cli/src/cli.ts`
  - `packages/acp-cli/src/http-client.ts`
  - `packages/acp-cli/src/commands/task-create.ts`
  - `packages/acp-cli/src/commands/task-show.ts`
  - `packages/acp-cli/src/commands/task-transition.ts`
  - `packages/acp-cli/src/commands/workflow-action.ts`
  - `packages/acp-cli/src/commands/workflow-supervise.ts`
  - `packages/acp-cli/src/commands/workflow-supervisor-context.ts`
  - `packages/acp-cli/src/output/task-render.ts`
  - `packages/acp-cli/src/__tests__/smoke.test.ts`
  - `packages/acp-cli/test/commands/task-workflow.test.ts`
  - `packages/acp-cli/test/integration.test.ts`
  - `tests/conformance/acp-workflow/flow-presets-scenarios.test.ts`
  - `scripts/validate-scenarios.ts`
  - `scenarios/flow-presets/README.md`
  - `scenarios/flow-presets/hotfix-implementer-tester/runbook.md`
  - `scenarios/flow-presets/support-escalation-customer-response/runbook.md`
  - `scenarios/flow-presets/procurement-legal-approval/runbook.md`
  - `scenarios/flow-presets/procurement-legal-approval/scenario.json`
- Commands run:
  - `bun scripts/validate-scenarios.ts` — pass, final line
    `>>> OVERALL: SCENARIO-VALIDATION PASS`.
  - `bun test tests/conformance/acp-workflow/flow-presets-scenarios.test.ts` —
    pass, 16 tests / 492 assertions.
  - `bun test tests/conformance/acp-workflow` — pass, 31 tests / 566 assertions.
  - `bun test tests/conformance/acp-workflow/workflow-kernel.conformance.test.ts` —
    pass, 15 tests / 74 assertions.
  - `bun test packages/acp-cli/test/commands/task-workflow.test.ts` — pass,
    9 tests / 29 assertions.
  - `bun run --filter acp-core test` — pass, 48 tests / 151 assertions.
  - `bun run --filter acp-state-store test` — pass, 4 tests / 19 assertions.
  - `bun test packages/acp-server/test/workflow-tasks.test.ts` — pass,
    4 tests / 32 assertions.
  - `bun run --filter acp-server test` — pass, 376 tests / 1498 assertions.
  - `bun run --filter acp-cli test` — pass, 130 tests / 491 assertions.
  - `bun run --filter acp-e2e test` — pass, 14 tests / 121 assertions.
  - `bun run --filter acp-core typecheck` — pass.
  - `bun run --filter acp-state-store typecheck` — pass.
  - `bun run --filter acp-server typecheck` — pass.
  - `bun run --filter acp-cli typecheck` — pass.
  - `bun run --filter acp-core build` — pass.
  - `bun run --filter acp-state-store build` — pass.
  - `bun run --filter acp-server build` — pass.
  - `bun run --filter acp-cli build` — pass.
  - `bun run typecheck` — pass.
  - `bun run build` — pass.
  - `bun run lint` — pass with one pre-existing warning in
    `packages/gateway-discord/src/session-events-manager.ts`.
  - `bun run test` — did not complete cleanly in this session because unrelated
    5s timeout tests fired under the broad package graph. The workflow
    conformance suite ran first and passed with 31 tests / 566 assertions.
  - `bun run --filter hrc-server test` — pass on rerun, 289 tests /
    1099 assertions.
  - `bun test packages/cli/src/__tests__/m6-agent-cli.test.ts -t "--host-session-id sets AGENT_HOST_SESSION_ID alongside scope/lane"` —
    pass on rerun.
  - `bun run --filter @lherron/agent-spaces test` — pass on rerun, 121 tests /
    287 assertions.
  - `hrcchat show 1649` — Clod reported `SCENARIO-VALIDATION PASS` for
    `bun scripts/validate-scenarios.ts`, covering all three scenario folders,
    three happy paths, and 12 negative checks.
  - `hrcchat show 1650` — Clod reported `SCENARIO-VALIDATION PASS` for
    `bun test tests/conformance/acp-workflow/flow-presets-scenarios.test.ts`
    with 16 tests / 492 assertions.
  - `hrcchat show 1653` — Clod reported the stricter live-supervisor case was
    not covered by the kernel-level scenario runners.
  - `hrcchat show 1654` — Rex reported `PASS` for the stricter supervisor-agent
    path: `agent:rex` compiled supervisor context and satisfied
    `customer_response_pending` through the durable ACP HTTP action surface on an
    isolated SQLite-backed source server.
  - Manual CLI smoke on a temporary source ACP server at `127.0.0.1:18479` —
    pass. `acp workflow supervisor-context` returned one allowed
    `satisfy_obligation` action, `acp workflow action` satisfied `obl_0009`,
    and readback showed `T-CODY-SUPP1 v4 obligation=satisfied actor=agent:rex`.
  - `asp run supervisor --dry-run` — pass. The new `supervisor` agent
    prompt/profile assembled successfully.
  - Manual installed-CLI smoke on a temporary source ACP server at
    `127.0.0.1:18481` — pass. `acp supervise` created `T-D9904DF5` and
    supervisor run `supv_0002`; `acp workflow supervise` resumed it and
    preserved inherited `launchRuns`; `acp workflow action` launched owner
    participant `cody`; `acp task show` reported 3 supervisor runs,
    1 participant run, and 1 effect.
- Pass status:
  - Kernel now supports snapshot hydrate/export.
  - Built-in immutable workflow definitions are materialized in package code:
    `basic@1`, `code_defect_fastlane@1`, and `code_feature_tdd@1`.
  - `acp-state-store` now initializes durable workflow tables for definitions,
    tasks, evidence, obligations, events, effects, supervisor runs,
    participant runs, anomalies, patch proposals, idempotency records, context
    hashes, and runtime sequence.
  - `/v1/tasks` now creates durable workflow tasks using `workflow` and
    `idempotencyKey`; `/v1/tasks/:taskId/transitions` now applies
    `transitionId` workflow mutations; `/v1/tasks/:taskId/actions`,
    `/v1/workflow-supervisor-runs`, `/participant-context`, and
    `/supervisor-context` are registered.
  - Server no longer registers the old task evidence, promote, legacy transition
    list, or `toPhase` transition routes.
  - Dead server handler files for the old task create/get/evidence/promote/
    transition/transition-list routes were removed.
  - CLI task create/show/transition plus workflow supervise,
    supervisor-context/action, and the top-level `acp supervise` alias now
    target the new workflow task surface.
  - Workflow `EffectIntent` delivery now reconciles handoff and wake intents into
    the CoordinationSubstrate handoff/wake rows with idempotent delivery marking.
  - Supervisor `launch_participant_run` records participant runs and emits a wake
    effect for the role-scoped participant session.
  - Legacy CLI task promote/evidence/transition-list command implementations and
    their tests were removed as breaking changes. Remaining compatibility methods
    in the HTTP client fail explicitly instead of calling removed routes.
- Deviations/caveats:
  - Legacy wrkq task model and old ACP core preset validators still exist for
    non-migrated tests and helpers; they are no longer registered as the server
    task workflow route surface.
  - Workflow wake delivery is validated through server/store tests and existing
    coordination rows. A live HRC participant process launch from a workflow wake
    was not run in this checkpoint.
  - The stricter supervisor-agent scenario passes against the current checkout's
    source server and isolated durable DBs. The already-running shared dev ACP on
    `127.0.0.1:18470` was stale during validation and still served the old
    `roleMap` route shape until restarted/upgraded.
  - External scenario execution by `hrcchat dm clod@agent-spaces` was completed
    on 2026-05-10. Clod validated both the independent scenario harness and the
    repo-native conformance test; both returned `SCENARIO-VALIDATION PASS`.
    Clod also identified that those runners were kernel-level only; Rex then
    validated the stricter `agent:rex` supervisor-action path over the ACP HTTP
    surface.

Checkpoint E — evidence provenance + obligation lifecycle — completed
- E1 (T-01392): Standalone evidence attach with 3-source provenance
  (role-bound, supervisor, participant run) and idempotency. Commit: 6618e91.
  - Tests:
    - `tests/conformance/acp-workflow/evidence-provenance.test.ts` — 2 tests, 8 expect()
    - `packages/acp-server/test/evidence-attach.test.ts` — 5 tests, 26 expect()
    - `packages/acp-cli/test/commands/evidence-add.test.ts` — 1 test, 7 expect()
  - Scenario: `scenarios/flow-presets/evidence-provenance-attach/`
- E2 (T-01393): Obligation waive/cancel lifecycle with widened status enum
  (`open|satisfied|waived|cancelled|expired`), waiverRefs, and cancel/waive
  semantic distinction. Commit: 45ad646.
  - Tests:
    - `tests/conformance/acp-workflow/obligation-lifecycle.conformance.test.ts` — 1 test, 5 expect()
    - `packages/acp-server/test/workflow-task-obligations.test.ts` — 2 tests, 12 expect()
    - `packages/acp-cli/test/commands/task-obligation-waive-cancel.test.ts` — 2 tests, 12 expect()
  - Scenario: `scenarios/flow-presets/obligation-waive-cancel-lifecycle/`

Checkpoint G — participant runtime create/resume — completed
- T-01394: Participant run launch, resume, complete, and fail via
  `POST /v1/workflow-participant-runs` and lifecycle endpoints. User-direct
  surface; kernel rejects unbound/mismatched actors. Commit: 11b072d.
  - Tests:
    - `tests/conformance/acp-workflow/participant-runtime.conformance.test.ts` — 3 tests, 27 expect()
    - `packages/acp-server/test/workflow-participant-runs.test.ts` — 4 tests, 24 expect()
    - `packages/acp-cli/test/commands/task-run.test.ts` — 3 tests, 5 expect()
  - CLI: `acp task run --task <id> --role <role> --agent <agent>` and
    `acp task run-complete --run <id> --outcome <outcome>` — fully wired into
    CLI dispatch as of T-01400 (Stream B).
  - Scenario: `scenarios/flow-presets/participant-supervisor-evidence-authority/`

Checkpoint H — supervisor actions + auth hardening — completed
- T-01396: New action types (attach_evidence, apply_transition, escalate,
  pause_supervision, unpause_supervision). Capabilities derive from persisted
  supervisor run record; request-body capability claims are ignored. Starting
  a supervisor run is a hard prerequisite for any control action.
  Commits: 3259ff2, 55b5390.
  - Tests:
    - `tests/conformance/acp-workflow/supervisor-actions.conformance.test.ts` — 4 tests, 30 expect()
    - `packages/acp-server/test/workflow-supervisor-actions.test.ts` — 4 tests, 23 expect()
  - CLI: `acp workflow action --task <id> --supervisor-run <id> --action '<json>' --idempotency-key <key>`
  - Scenario: `scenarios/flow-presets/participant-supervisor-evidence-authority/`

Checkpoint I — patch proposal read API — completed
- T-01395: List and show workflow patch proposals via read-only GET endpoints.
  Commit: 2edff99.
  - Tests:
    - `packages/acp-server/test/workflow-patch-proposals-read.test.ts` — 3 tests, 29 expect()
    - `packages/acp-cli/test/commands/workflow-patch-list-show.test.ts` — 4 tests, 18 expect()
  - CLI: `acp workflow patch list --task <id>`, `acp workflow patch show <proposalId>`

Checkpoint J — docs sweep for new surfaces — completed
- T-01397: Documentation-only sweep covering E, G, H, I surfaces.
  - Updated `packages/acp-server/README.md` with all new endpoints
    (evidence, obligations, participant runs, supervisor actions + auth
    hardening, patch proposals, context compilation).
  - Updated `packages/acp-cli/README.md` with all new CLI commands
    (`task evidence add`, `task obligation waive/cancel`, `task run`,
    `workflow action` action types, `workflow patch list/show`).
  - Updated `docs/acp-workflow-verification.md` with per-checkpoint
    verification recipes (curl + CLI examples), scenario runbook links,
    and an end-to-end defect-fastlane narrative.
  - Updated `acp-workflow-checkpoints-validation.md` (this file) with
    E, G, H, I, J completion evidence.
  - Self-reference: this checkpoint is complete when the above docs are
    committed and `bun run lint` passes.

Checkpoint K — CLI surface gaps + canonical runbook alignment (T-01398) — completed
- T-01398 Stream A (T-01399, commit 166c94c): Kernel capability gates enforced
  for waive_obligation, pause_supervision, and evidence attachment. Null-guard
  on apply_transition evidenceRefs returns `missing_evidence`. Cross-task
  evidence provenance validated as `authority_not_granted`. Collapsed
  `evidence_attach_unauthorized` into `authority_not_granted`.
- T-01398 Stream B (T-01400, commit 7a57186): `acp workflow publish` endpoint
  and CLI command. `acp task run` and `acp task run-complete` fully wired into
  CLI dispatch. Flag normalization: `--bind`, `--as`/`--actor`, `--task-id`,
  `--supervisor`/`--supervisor-autonomy`/`--supervisor-capability`,
  `--summary`, `--from-run`, `--expected-version` optional (auto-fetches),
  `cancel --reason` optional (server validates).
- T-01398 Stream C (T-01401): Runbooks + docs alignment. All three flow-presets
  runbooks now use the canonical CLI surface verbatim (no flag adaptation).
  scenario.json expectedRejection codes reconciled to Stream A kernel codes.
  `docs/acp-workflow-verification.md` updated with new commands and removed
  stale "not wired" notes. This file updated with completion evidence.
- All checkpoints E1/E2/E3 (evidence-provenance-attach,
  obligation-waive-cancel-lifecycle, participant-supervisor-evidence-authority)
  are now manually verifiable end-to-end via their runbooks against the
  installed CLI without flag adaptation.
