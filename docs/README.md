# Documentation catalog

The [architecture records guide](../architecture/README.md) explains how to
read and verify the repository's active architecture records.

## Contracts and decisions

| Document | Kind | Code | Grader |
| --- | --- | --- | --- |
| [Architecture record authority](../architecture/adr/0001-adopt-durable-architecture-records.md) | decisions | | |
| [Active invariants](../architecture/INVARIANTS.md) | record | | |
| [Accepted risks](../architecture/RISKS.md) | record | | |
| [Check authoring ledger](../architecture/contracts/check-authoring.md) | record | | |
| [Harness broker context usage](../architecture/contracts/harness-broker-context-usage.yaml) | record | | |
| [Harness broker evidence authority](../architecture/contracts/harness-broker-evidence-authority.md) | spec | `harness/harness-broker/src/drivers/**`, `harness/harness-broker-pi-sdk/src/**` | `scripts/pre-hrc-broker-matrix-e2e.ts`, `harness/harness-broker/test/drivers/**/*.test.ts` |
| [Scope and environment conformance](../architecture/contracts/scope-env-conformance.md) | spec | `contracts/agent-scope/src/**`, `core/config/src/runtime/agent-session-env.ts`, `crates/raspd/src/compile/scope.rs` | `contracts/agent-scope/conformance/conformance.test.ts`, `core/config/src/runtime/agent-session-env-conformance.test.ts`, `compiler/agent-spaces/src/__tests__/locked-env-conformance.test.ts` |
| [Identity, scope, and environment](identity-scope-and-env-contract.md) | spec | `contracts/agent-scope/src/**`, `core/config/src/runtime/agent-session-env.ts` | `contracts/agent-scope/conformance/conformance.test.ts`, `core/config/src/runtime/agent-session-env-conformance.test.ts` |
| [Runtime resource ownership and provenance](runtime-resources.md) | spec | `core/config/src/resources/compiler.ts`, `apps/cli/src/commands/resources/index.ts` | `core/config/src/__tests__/resources-plan.red.test.ts`, `apps/cli/src/__tests__/resources-cli.test.ts` |
| [Harness architecture](harness-architecture.md) | spec | `compiler/agent-spaces/src/harness-selection/**`, `harness/aspc/src/**` | `compiler/agent-spaces/src/harness-selection/resolve.test.ts`, `harness/aspc/test/compile-only-contract.test.ts` |
| [Spaces composition model](spaces-composition-model.md) | spec | `core/config/src/resolver/**`, `core/config/src/core/config/targets-toml.ts` | `core/config/src/core/config/targets-toml.compose-mode.test.ts`, `core/config/src/orchestration/materialize-refs.test.ts` |

## Operating and development guides

| Document | Kind | Code | Grader |
| --- | --- | --- | --- |
| [Architecture brief](architecture-brief.md) | guide | | |
| [Materialization and install](materialization-install-flow.md) | guide | | |
| [aspd compile and release hosting](aspd.md) | guide | | |
| [Standalone ASP releases](standalone-asp-releases.md) | guide | | |
| [Codex Desktop self-join](codex-desktop-join.md) | guide | | |
| [Claude Desktop self-join](claude-desktop-join.md) | guide | | |
| [Agent hygiene lint policy](agent-hygiene/lint-rules.md) | guide | | |
| [Native agent-harness worker e2e](runbooks/e2e-harness-agent-harness.md) | guide | | |
| [Closeout evidence](closeout-evidence.md) | guide | | |
| [Git hook timing telemetry](hook-timings.md) | guide | | |

## Co-located guides

| Document | Kind | Code | Grader |
| --- | --- | --- | --- |
| [ASP package smoke](../apps/cli/AGENTS.md) | guide | | |
| [Architecture records](../architecture/README.md) | guide | | |
| [aspd kernel conformance](../conformance/aspd/README.md) | guide | | |
| [Scope and environment fixture adoption](../contracts/agent-scope/conformance/README.md) | guide | | |
| [Agent prompt rent](agent-hygiene/README.md) | guide | | |
| [HTML contract viewer assets](html/assets/README.md) | guide | | |
| [Pi harness instructions](../drivers/harness-pi/AGENTS.md) | guide | | |
| [Harness broker smoke](../harness/harness-broker/AGENTS.md) | guide | | |
