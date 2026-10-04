# Documentation index

Start with the current references and operating guides below. Proposals record
design decisions and their stated implementation scope; historical pages preserve
evidence rather than define current acceptance. [Architecture records](../architecture/README.md)
own the normative contracts.

## Current references

- [Architecture brief](architecture-brief.md) — ASP ownership, core concepts, and package boundaries.
- [Spaces composition model](spaces-composition-model.md) — Space manifests, target composition, and deterministic resolution.
- [Materialization and install flow](materialization-install-flow.md) — How declared composition becomes a runnable harness home.
- [Harness architecture](harness-architecture.md) — Current four-harness selection vocabulary and producer boundary.
- [CLI surface](cli-surface.md) — Command groups and their responsibilities.
- [CLI reference](cli-reference.md) — Command syntax and option reference.
- [Identity, scope, and environment contract](identity-scope-and-env-contract.md) — Cross-repository identity vocabulary and launched-process environment.
- [Environment contract](env-contract.md) — Environment layers and variable ownership.

## Operating and validation guides

- [aspd](aspd.md) — Namespaced compile service, release selection, and activation readback.
- [Standalone ASP releases](standalone-asp-releases.md) — Build, install, and inspect immutable release artifacts.
- [Codex Desktop self-join](codex-desktop-join.md) — Desktop registration, address discovery, and mail delivery operation.
- [Agent hygiene](agent-hygiene/README.md) — Price resident prompt context with token-rent before remediation.
- [Agent-hygiene lint rules](agent-hygiene/lint-rules.md) — Advisory W4xx rules, severities, and cache-admission scope.
- [Dead-code analysis runbook](deadcode-analysis-runbook.md) — Coordinate package-complete read-only analysis and follow-on fixes.
- [Native agent-harness release worker e2e](runbooks/e2e-harness-agent-harness.md) — Verify release-worker identity and lifecycle, with the stated interactive availability limitation.
- [Real Codex app-server e2e](runbooks/e2e-harness-codex-app-server.md) — Exercise broker turns and tools against Codex; records its May 2026 validation baseline.
- [Closeout evidence](closeout-evidence.md) — Choose evidence appropriate to the changed or claimed surface.
- [Agent enablement changelog](agent-enablement-changelog.md) — Record control-loop changes and follow the retro cadence.
- [Hook timings](hook-timings.md) — Measure and interpret repository hook latency.

## Designs and proposals

Read each page's status and implementation-scope notes before treating a proposed
command or lifecycle as available. Current harness behavior is described in the
[harness architecture](harness-architecture.md) and active architecture records.

- [Producer-owned harness selection](proposals/producer-owned-harness-selection.md) — Approved design for lowering caller intent to execution recipes.
- [Praesidium agent harness](proposals/agent-harness.md) — Accepted direct Pi resource-loader design, amended by the native release worker.
- [Native release worker](proposals/agent-harness-native-release-worker.md) — Owner-approved immutable worker identity and headless/interactive topology.
- [Agent resource parity verifier](proposals/agent-resource-parity-verifier.md) — Compare direct-loader and compatibility-compiler prompts and skills.
- [Codex desktop driver](proposals/codex-desktop-driver.md) — Approved desktop participation design and verification boundaries.
- [Agent-authored runtime resources](proposals/agent-authored-runtime-resources.md) — Desired-state resource plans; distinguishes ASP compilation from ACP lifecycle intent.
- [Agent scaffolding](proposals/agent-scaffolding.md) — Approved, unimplemented agent-creation command design.
- [Harness scenario helpers](proposals/harness-scenario-helpers.md) — Approved, unimplemented deterministic scenario package design.

## Historical and supporting material

- [HRC-operated agent-harness interactive TUI](proposals/agent-harness-hrc-interactive.md) — Superseded interactive design rationale; its private wire contract is retired.
- [Harness broker proposal](harness-broker-proposal/README.md) — Historical May 2026 package boundaries and migration rationale, with routes to current guidance.
- [Claude Agent SDK smoke runbook](agent-sdk-smoke-test-runbook.md) — Historical pre-v2 integration evidence for the retired SDK selection path.
- [Codex smoke runbook](codex-smoke-test-runbook.md) — Historical pre-v2 integration evidence, superseded by current selection and acceptance contracts.
- [Pi SDK smoke runbook](pi-sdk-smoke-test-runbook.md) — Historical pre-v2 integration evidence for the retired Pi SDK selection path.
- [P0 hash epoch](p0-hash-epoch.md) — August 2026 migration baseline for compiler byte-compatibility comparisons.
- [HTML proposal assets](html/assets/README.md) — Reusable styling and contract-viewer assets for standalone proposal pages.
- [Architecture overview](ARCHITECTURE.md) — Earlier package overview with current ownership and path notes.
