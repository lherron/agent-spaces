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
- [Native agent-harness release worker e2e](runbooks/e2e-harness-agent-harness.md) — Verify release-worker identity and headless/interactive lifecycle through the standard broker protocol.
- [Closeout evidence](closeout-evidence.md) — Choose evidence appropriate to the changed or claimed surface.
- [Agent enablement changelog](agent-enablement-changelog.md) — Record control-loop changes and follow the retro cadence.
- [Hook timings](hook-timings.md) — Measure and interpret repository hook latency.

## Designs and proposals

Read each page's status and implementation-scope notes before treating a proposed
command or lifecycle as available. Current harness behavior is described in the
[harness architecture](harness-architecture.md) and active architecture records.

- [Praesidium agent harness](proposals/agent-harness.md) — Accepted direct Pi resource-loader design, amended by the native release worker.
- [Agent resource parity verifier](proposals/agent-resource-parity-verifier.md) — Compare direct-loader and compatibility-compiler prompts and skills.
- [Codex desktop driver](proposals/codex-desktop-driver.md) — Approved desktop participation design and verification boundaries.
- [Agent-authored runtime resources](proposals/agent-authored-runtime-resources.md) — Desired-state resource plans; distinguishes ASP compilation from ACP lifecycle intent.
- [Agent scaffolding](proposals/agent-scaffolding.md) — Approved, unimplemented agent-creation command design.
- [aspd Rust front door](proposals/aspd-rust-front-door.md) — Draft plan for the aspd Rust front door, campaign P-00890, for Daedalus review.

## Historical and supporting material

- Harness scenario helpers — Archived optional package design, preserved byte-for-byte as attachment `ATT-00422` on completed task T-12632 (Archived optional harness scenario helper design). Retrieve with `wrkq attach get ATT-00422`; only the standalone protocol hardening prerequisite shipped, under T-06393.
- Producer-owned harness selection — Completed ASP v2 cutover design, preserved byte-for-byte as attachment `ATT-00425` on completed task T-08699 (Define the public v2 harness-selection contract). Retrieve with `wrkq attach get ATT-00425`; use the [compiler catalog](../compiler/agent-spaces/src/harness-selection/catalog.ts) and [public selection types](../contracts/spaces-runtime-contracts/src/harness-selection.ts) for current vocabulary and defaults.
- Native release worker — Completed owner-approved worker design, preserved byte-for-byte as attachment `ATT-00423` on completed task T-08680 (Native agent-harness release worker). Retrieve with `wrkq attach get ATT-00423`; use the [active runtime-boundary invariant](../architecture/records/invariants/agent-spaces.agent-harness-runtime-boundary.yaml) and [native worker e2e runbook](runbooks/e2e-harness-agent-harness.md) for current guidance.
- HRC-operated agent-harness interactive TUI — Superseded interactive rationale, preserved byte-for-byte as attachment `ATT-00424` on completed task T-08680 (Native agent-harness release worker). Retrieve with `wrkq attach get ATT-00424`; its private wire contract is retired. Use the [active runtime-boundary invariant](../architecture/records/invariants/agent-spaces.agent-harness-runtime-boundary.yaml).
- [Harness broker proposal](harness-broker-proposal/README.md) — Historical May 2026 package boundaries and migration rationale, with routes to current guidance.
- Claude Agent SDK smoke runbook — Historical pre-v2 evidence for the retired SDK selection path, preserved byte-for-byte as attachment `ATT-00419` on completed task T-12629 (Archived pre-v2 harness smoke runbooks). Retrieve with `wrkq attach get ATT-00419`; use the [harness architecture](harness-architecture.md) and [broker matrix guidance](../harness/harness-broker/AGENTS.md) for current acceptance.
- Codex smoke runbook — Historical pre-v2 evidence for the earlier Codex integration, preserved byte-for-byte as attachment `ATT-00420` on completed task T-12629 (Archived pre-v2 harness smoke runbooks). Retrieve with `wrkq attach get ATT-00420`; use the [harness architecture](harness-architecture.md) and [broker matrix guidance](../harness/harness-broker/AGENTS.md) for current acceptance.
- Pi SDK smoke runbook — Historical pre-v2 evidence for the retired Pi SDK selection path, preserved byte-for-byte as attachment `ATT-00421` on completed task T-12629 (Archived pre-v2 harness smoke runbooks). Retrieve with `wrkq attach get ATT-00421`; use the [harness architecture](harness-architecture.md) and [broker matrix guidance](../harness/harness-broker/AGENTS.md) for current acceptance.
- [P0 hash epoch](p0-hash-epoch.md) — August 2026 migration baseline for compiler byte-compatibility comparisons.
- Real Codex app-server May 2026 smoke — preserved byte-for-byte as attachment `ATT-00336` on completed task T-01554 (tool-call payload projection). Retrieve with `wrkq attach get ATT-00336`; use the [broker matrix guidance](../harness/harness-broker/AGENTS.md) for current acceptance.
- [HTML proposal assets](html/assets/README.md) — Reusable styling and contract-viewer assets for standalone proposal pages.
- [Architecture overview](ARCHITECTURE.md) — Earlier package overview with current ownership and path notes.
