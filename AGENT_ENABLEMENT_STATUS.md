# agent-spaces Agent Enablement Status

<!-- GENERATED: agent-enablement status; do not edit by hand. -->

Generated from `agent-enablement.json`. This markdown is a projection, not authority.

Rubric: rubric.md@d793717
Catalog: not-recorded
AE assessment: 2026-07-05 (agent-enablement/assessments/agent-spaces/assessment.json)
PM floor: 2026-07-02 (etag 4)

## Profile Summary
Required: 18
Frontier: 5
Deferred: 2
Open deltas: delta:add-asp-cli-surface-drift-gate, delta:legibility-cli-surface-registry, delta:legibility-refresh-pm-floor-anchor, delta:legibility-wrkq-adoption-probe, delta:measure-closeout-workflow-adoption-tail, delta:repair-runtime-contract-diagnostic-conformance, delta:route-actuator-split-cross-repo
Failing/open axes: S4, TA.actuatorSplit, TB.lifecycleHealth, TD.selfDescribingSurfaceConformance, TF.workflowAdoption

## PM Floor Axes
- F0: PARTIAL
- P0: PRESENT
- S1: PRESENT
- S3: PRESENT
- S6: PRESENT
- S7: PRESENT

## PM Observations
- validate-justfile: PRESENT (P0) - justfile: recipes present default, info, test, lint, verify
- validate-gitignore: PRESENT (F0) - .gitignore: checked 7 required entries; all present
- validate-readme: PRESENT (F0) - README.md: H1 title, description, quick start/getting started/install, usage/examples
- validate-runtime: PRESENT (F0) - Bun lockfile present
- validate-agent-spaces: PARTIAL (F0) - asp-targets.toml present; .gitignore present; gaps: asp-lock.json not ignored
- validate-agent-md: PRESENT (S3) - AGENTS.md present; CLAUDE.md present
- validate-githooks: PRESENT (P0, S6) - lefthook.yml: pre-commit, pre-push
- validate-gitleaks: PRESENT (F0) - gitleaks hook configured; gitleaks local config/ignore present
- validate-linting: PRESENT (S6) - justfile: lint recipe present; lint config present; hook runs lint yes
- validate-typechecking: PRESENT (S1, S6) - justfile: typecheck recipe present; tsconfig present; hook evidence present
- validate-tests: PRESENT (S6, S7) - justfile: test recipe present; package test present; Go tests not found

## Escalations
- F0: floor-gap / open (T-05447)

## Depth Axes
- F0: PRESENT.DORMANT.satisfied.dormant
- P0: PRESENT.EXERCISED.satisfied.exercised
- S1: PRESENT.EXERCISED.satisfied.exercised
- S1.authorityChannelSplit: PRESENT.EXERCISED.satisfied.exercised
- S2: PRESENT.EXERCISED.satisfied.exercised
- S3: PRESENT.EXERCISED.satisfied.exercised
- S3.affordanceGating: PRESENT.EXERCISED.satisfied.exercised
- S4: PARTIAL.EXERCISED.open_delta
- S5: PRESENT.EXERCISED.satisfied.exercised
- S6: PRESENT.EXERCISED.satisfied.exercised
- S7: PRESENT.EXERCISED.satisfied.exercised
- S7.contractHashClosure: PRESENT.EXERCISED.satisfied.exercised
- S8: PRESENT.EXERCISED.satisfied.exercised
- TA: PRESENT.EXERCISED.satisfied.exercised
- TA.actuatorSplit: ABSENT.DORMANT.open_delta
- TB: PRESENT.EXERCISED.satisfied.exercised
- TB.lifecycleHealth: ABSENT.DORMANT.deferred
- TC: PRESENT.EXERCISED.satisfied.exercised
- TD: PRESENT.EXERCISED.satisfied.exercised
- TD.selfDescribingSurfaceConformance: PARTIAL.EXERCISED.open_delta
- TE: PRESENT.EXERCISED.satisfied.exercised
- TE.claimScopedEvidenceRouting: PRESENT.DORMANT.satisfied.dormant
- TE.crossHarnessConformanceMatrix: PRESENT.DORMANT.satisfied.dormant
- TF: PRESENT.EXERCISED.satisfied.exercised
- TF.workflowAdoption: PARTIAL.DORMANT.open_delta
