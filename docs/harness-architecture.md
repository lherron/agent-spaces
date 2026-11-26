---
id: agent-spaces/harness-architecture
title: Harness Architecture
kind: reference
authority: descriptive
status: active
visibility: internal
provenance: authored
---

# Harness Architecture

The normative law is the active
`agent-spaces.producer-owned-harness-selection` architecture record. This
reference describes the current v2 producer boundary. Older proposals, smoke
runbooks, and immutable v1 release artifacts are historical evidence; they do
not extend this contract.

## Selection boundary

The public harness vocabulary is closed:

```text
agent-harness | claude | claude-hrcpty | codex | codex-hrcpty | antigravity-hrcpty | muse
```

`agent-harness` is the default. A request separately supplies an optional
`modelProvider`, `model`, `reasoningEffort`, and boolean `presentation`; the
default presentation is `true`. A provider never selects a harness and a
model never selects a provider. `presentation: false` is an explicit user
value, not an omitted value or a prohibition on an implementation-required
terminal.

`claude-agent-sdk`, `pi`, `pi-sdk`, `claude-code`, `codex-cli`, `muse-cli`,
and `agent-sdk` are not harness IDs or aliases. Retained packages and broker
drivers are implementation details, not selectable compatibility routes.

The compiler's exhaustive catalog is the only authority that maps harness and
presentation to a builder, driver, protocol, transport, terminal requirement,
hosting requirement, and presentation fulfillment. Configuration parses and
property-preservingly merges scalars; public contracts carry vocabulary and
DTOs; neither can select a recipe. Builders receive the resolved recipe and
cannot reinterpret raw selection fields.

The catalog at `compiler/agent-spaces/src/harness-selection/catalog.ts#HARNESS_CATALOG`
defines these driver and terminal choices.

| Harness | `presentation: false` | `presentation: true` |
| --- | --- | --- |
| `agent-harness` | `agent-harness` native worker without a terminal | `agent-harness-tmux` native worker with a tmux TUI |
| `claude` | `claude-code-tmux` with a tmux terminal | Same intrinsic presentation |
| `claude-hrcpty` | `claude-code-hrcpty` with an HRC PTY | Same intrinsic presentation |
| `codex` | `codex-app-server` without a terminal | Same driver with a tmux TUI attachment |
| `codex-hrcpty` | `codex-app-server` with an HRC PTY attachment surface | Same attachable recipe |
| `antigravity-hrcpty` | `antigravity-cli-hrcpty` with an HRC PTY | Same intrinsic presentation |
| `muse` | `muse-serve` without a terminal | `muse-cli-tmux` with a tmux TUI |

A true request must resolve to the stated fulfillment or a typed refusal. A
later request may attach only where the recipe permits it. Switching a birth
variant requires explicit lifecycle replacement.

## Configuration and compilation

`agent-profile.toml` accepts only `version = 4`; `asp-targets.toml` accepts
only `schema = 2`. TOML uses `model_provider` and boolean `presentation`; the
wire uses `modelProvider` and `presentation`. Versions 1–3, schema 1,
`viewer`, aliases, provider-prefixed model strings, and all retired selection
fields fail at their first typed boundary. There is no dual reader or runtime
migration fallback.

Resolution is deterministic: catalog defaults, agent profile, project target,
per-summon directives, explicit compile overrides, compatibility validation,
then one recipe. Omitted provider and model use the selected catalog defaults;
changing only harness preserves explicit provider/model and refuses an
incompatible combination.

The ordinary public RPC is `aspc.compileHarnessInvocation`. The aspd service
serves this v2 boundary, and the compiler resolves the execution recipe. The
service guide is `docs/aspd.md`. The table describes selection. The serving
daemon's mode also governs admission. The Rust daemon in sole mode refuses
`agent-harness` and `muse` compile requests with `unsupported_harness` under
`architecture/records/invariants/agent-spaces.aspd-rust-front-door.yaml`.
`compileRuntimePlan` is an internal compiler/SDK operation.
Foreground `asp run` has a separate process-preparation path. Exact-profile,
participant, Desktop, and observer flows have their own named operations.

Every ordinary success contains one `plan.execution` and one canonical start
request at `plan.execution.dispatchRequest.startRequest`. The profile may reference
that request and its hashes but never duplicates it. There is no
`executionProfiles`, `selectedProfile`, top-level `startRequest`, or caller
`brokerDriver` selection input.

## Package and hosting boundaries

```text
profile / project TOML / directives / compile request
                    |
                    v
  spaces-config: parse and merge independent scalars
                    |
                    v
  agent-spaces compiler: catalog, resolver, selected recipe, canonical start request
                    |
                    v
  aspd: serve the v2 compile result and bind the selected driver
                    |
                    v
  release worker: execute the frozen driver
```

The public contract package owns vocabulary and resolved DTOs only. The
compiler owns selection. A v2 immutable release must positively bind every
catalog-selectable driver, including Codex, before a successful compile can
name its worker. The broker executes the frozen driver named by the canonical
start request.

HRC retains placement, authorization, terminal leases, lifecycle, messaging,
continuation, credentials, and reattachment. It consumes the producer's
resolved harness, recipe, and worker binding.

## Retained implementation layers

`spaces-runtime` still supplies harness-neutral session contracts and
`spaces-execution` still supplies foreground installation/build/run plumbing.
Harness-specific packages and broker drivers may remain while they implement a
catalog recipe or preserve historical artifacts. Their presence does not make
their names public selection vocabulary. ASP source continues to avoid HRC,
ACP, gateway, coordination-substrate, wrkq, and wlearn imports.
