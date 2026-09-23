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
agent-harness | claude | codex | muse
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

The catalog's initial recipes are:

| Harness | `presentation: false` | `presentation: true` |
| --- | --- | --- |
| `claude` | `claude-code-tmux` | same intrinsic recipe |
| `codex` | `codex-app-server` | same driver with Codex TUI attachment |
| `muse` | `muse-serve` | `muse-cli-tmux` birth variant |
| `agent-harness` | `agent-harness` native worker | `agent-harness-tmux` birth variant |

A true request must resolve to the stated fulfillment or a typed refusal; it
is never silently downgraded. A later request may attach only where the recipe
permits it. Birth variants require explicit lifecycle replacement.

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

The ordinary public RPC is solely `aspc.compileHarnessInvocation`. ASPC
validates the v2 envelope and invokes the compiler; it has no catalog, profile
selector, or driver selector. `compileRuntimePlan` remains an internal
compiler/SDK operation, not another public RPC. Foreground `asp run` retains
its separate process-preparation path, while exact-profile, participant,
Desktop, and observer flows remain explicitly named operations.

Every ordinary success contains one `execution` and one canonical start
request at `execution.dispatchRequest.startRequest`. The profile may reference
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
  spaces-aspc: v2 envelope validation and compiler invocation
                    |
                    v
  aspc-facade / release worker: bind and execute the frozen driver
```

The public contract package owns vocabulary and resolved DTOs only. The
compiler owns selection. A v2 immutable release must positively bind every
catalog-selectable driver, including Codex, before a successful compile can
name its worker. The broker executes the frozen driver named by the canonical
start request.

HRC retains placement, authorization, terminal leases, lifecycle, messaging,
continuation, credentials, and reattachment. It does not choose a harness,
recipe, or worker. Migrating HRC callers and persisted state to this breaking
v2 contract is explicitly outside this ASP-only cutover.

## Retained implementation layers

`spaces-runtime` still supplies harness-neutral session contracts and
`spaces-execution` still supplies foreground installation/build/run plumbing.
Harness-specific packages and broker drivers may remain while they implement a
catalog recipe or preserve historical artifacts. Their presence does not make
their names public selection vocabulary. ASP source continues to avoid HRC,
ACP, gateway, coordination-substrate, wrkq, and wlearn imports.
