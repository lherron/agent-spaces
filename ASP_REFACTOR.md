Main finding: the codebase does not have one canonical “run planner.” It has several partially overlapping planners that each resolve a slightly different subset of the same decisions. That is the root cause of the drift.

The overlapping planners today are:

1. `hrc-cli` does its own scope parsing, project inference, bundle inference, and provider inference in `packages/hrc-cli/src/cli.ts:511-594` and then builds an `HrcRuntimeIntent` in `:1200-1254`.
2. `asp agent` does a separate scope parser, separate harness normalization, and separate placement builder in `packages/cli/src/commands/agent/index.ts:34-52`, `:159-178`, and `:348-375`.
3. The legacy `asp run` path has its own harness/default resolution in `packages/execution/src/run.ts:861-1099`.
4. `agent-spaces` has a CLI planner in `packages/agent-spaces/src/client.ts:1500-1710`.
5. `agent-spaces` has a separate SDK planner in `packages/agent-spaces/src/client.ts:1727-1945`.
6. `hrc-server` re-derives frontends again from provider/mode in `packages/hrc-server/src/index.ts:4867-4878`, `packages/hrc-server/src/agent-spaces-adapter/cli-adapter.ts:31-34,123-133`, and `packages/hrc-server/src/agent-spaces-adapter/sdk-adapter.ts:125-126`.

That is too many places to encode the same intent.

## 1. Proposal for simplifying `hrc run`

### A. Make harness resolution a single shared module

Right now the harness vocabulary is split across at least five places, and they do not agree. The clearest bug is `normalizeHarness('pi-sdk')` returning `provider: 'anthropic'` in `packages/cli/src/commands/agent/index.ts:45-46`, while `agent-spaces` treats `pi-sdk` as OpenAI in `packages/agent-spaces/src/client.ts:173-179` and `packages/agent-spaces/src/placement-api.ts:109-114`.

I would create one canonical harness catalog in a low-level package that all of `spaces-config`, `agent-spaces`, `hrc-server`, `hrc-cli`, and `asp agent` can depend on. The catalog should be the only place that knows the mapping among:

- alias string from config/CLI, like `claude`, `claude-code`, `agent-sdk`, `codex`, `codex-cli`, `pi`, `pi-sdk`
- provider family, `anthropic` or `openai`
- public frontend, `claude-code | codex-cli | agent-sdk | pi-sdk`
- internal adapter id, `claude | codex | claude-agent-sdk | pi-sdk | pi`
- transport, `cli | sdk`

A concrete shape:

```ts
type ProviderFamily = 'anthropic' | 'openai'
type Frontend = 'claude-code' | 'codex-cli' | 'agent-sdk' | 'pi-sdk'
type Transport = 'cli' | 'sdk'

type HarnessCatalogEntry = {
  aliases: readonly string[]
  family: ProviderFamily
  frontend: Frontend
  internalId: HarnessId
  transport: Transport
}
```

Then expose small helpers:

- `normalizeHarnessAlias(input)`
- `familyForConfiguredHarness(input)`
- `frontendForFamily(family, transport)`
- `internalIdForFrontend(frontend)`

That one change lets you delete or replace all of these:

- `resolveProviderFromAgent` in `hrc-cli`
- `normalizeHarness` in `asp agent`
- `PROVIDER_TO_FRONTEND` in the HRC CLI adapter
- `toFrontend` in the HRC SDK adapter
- `deriveInteractiveHarness` / `deriveSdkHarness` in `hrc-server`
- the provider map in `agent-spaces/src/placement-api.ts`

### B. Stop representing HRC harness choice as `{ provider, interactive }`

This is the core structural bug. `HrcRuntimeIntent` currently only carries:

```ts
harness: {
  provider: 'anthropic' | 'openai'
  interactive: boolean
  ...
}
```

in `packages/hrc-core/src/contracts.ts:30-56`, and `hrc-server` only parses those fields in `packages/hrc-server/src/index.ts:4377-4417`.

That representation is lossy. It throws away the actual harness/front-end choice, so every downstream layer has to re-derive it. That is why you have separate `provider -> codex-cli` and `provider -> pi-sdk` logic.

I would change the intent to carry either:

- the explicit frontend, or
- a normalized family plus a requested transport

Minimal-churn version:

```ts
type HrcHarnessIntent = {
  frontend?: Frontend
  provider?: ProviderFamily   // derived/validated when frontend is set
  interactive: boolean
  model?: string
  yolo?: boolean
}
```

Clean version:

```ts
type HrcHarnessIntent = {
  family?: ProviderFamily | 'auto'
  frontend?: Frontend | 'auto'
  model?: string
  yolo?: boolean
}

type HrcExecutionIntent = {
  transport?: 'cli' | 'sdk' | 'auto'
  interactionMode?: 'interactive' | 'headless' | 'nonInteractive'
}
```

Either way, the intent needs to preserve the resolved harness family/front-end instead of collapsing everything to provider+boolean.

### C. Resolve defaults from placement once, not separately in CLI and SDK paths

This is where the current behavioral drift lives.

`buildPlacementInvocationSpec()` threads effective target config into defaults and merges `model`, `prompt`, and `yolo` with adapter defaults in `packages/agent-spaces/src/client.ts:1545-1642`.

`runPlacementTurnNonInteractive()` does not. It re-resolves placement/materialization, but it ignores `effectiveConfig` for model/prompt/yolo and hardcodes `yolo: true` for pi-sdk in `:1872-1877`.

That means the same placement can produce different defaults depending on whether you went through the CLI path or SDK path. That is exactly the inconsistency you want gone.

I would split planning into two canonical layers:

1. `spaces-config`: resolve placement into a richer “placement context”
   - bundle kind
   - effective compose
   - effective target config
   - synthetic manifest when needed
   - cwd
   - resolved bundle metadata

2. `spaces-execution`: resolve that placement context into a “runtime plan”
   - chosen harness family/frontend/internal adapter id
   - adapter defaults
   - model/prompt/yolo after all merges
   - materialization output
   - system prompt
   - env/cwd/correlation
   - continuation handling

Then:

- `agent-spaces.buildProcessInvocationSpec()` becomes “plan + render CLI invocation”
- `agent-spaces.runTurnNonInteractive()` becomes “plan + instantiate SDK session”
- `spaces-execution.run()` becomes either a wrapper over the same planner or the planner owner
- `hrc-cli cmdRun` becomes only “scope input -> placement -> runtime intent”
- `hrc-server` becomes only dispatch/orchestration, not harness derivation

### D. Move `placementToSpec()` out of `agent-spaces`

`placementToSpec()` in `packages/agent-spaces/src/client.ts:337-453` duplicates logic already present in `spaces-config` `resolvePlacement()` and `mergeAgentWithProjectTarget()`:

- bundle-kind resolution
- project target lookup
- agent-profile parsing
- effective compose merge
- synthetic manifest construction

That logic belongs below `agent-spaces`, not inside it.

I would either:

- extend `spaces-config.resolvePlacement()` to return the extra effective/default metadata needed for execution, or
- add a sibling `resolvePlacementContext()` in `spaces-config`

and then delete `placementToSpec()` plus `buildSyntheticAgentProjectManifest()` from `agent-spaces`.

### E. Extract a shared scope/placement resolver for `hrc-cli` and `asp agent`

`hrc-cli` and `asp agent` both do nearly the same scope parsing:

- `packages/hrc-cli/src/cli.ts:526-562`
- `packages/cli/src/commands/agent/index.ts:159-178`

and bundle inference is duplicated too:

- `buildRunBundle()` in `hrc-cli` at `:580-594`
- `buildBundleRef()` in `asp agent` shared helpers at `packages/cli/src/commands/agent/shared.ts:24-52`

These should collapse into one helper that returns:

- canonical `scopeRef`
- `laneRef`
- `agentRoot`
- `projectRoot`
- `cwd`
- `RuntimePlacement`

That removes the local bundle/provider logic from `hrc-cli` entirely.

### F. Immediate bugs/inconsistencies to fix before the larger refactor

These are worth fixing even before the planner consolidation lands:

1. `pi-sdk` provider bug in `normalizeHarness()`:
   `packages/cli/src/commands/agent/index.ts:45-46`

2. `hrc-cli` provider inference is incomplete and ignores project target overrides:
   `packages/hrc-cli/src/cli.ts:564-577` only checks `profile.identity?.harness === 'codex'`.
   It does not account for `codex-cli`, `pi`, `pi-sdk`, `agent-sdk`, `claude-agent-sdk`, or `projectTarget?.harness`.
   The real precedence is in `mergeAgentWithProjectTarget()` at `packages/config/src/core/merge/agent-project-merge.ts:111-128`.

3. `asp agent` defaults to `claude-code` regardless of profile:
   `packages/cli/src/commands/agent/index.ts:146-148`

4. SDK path ignores effective defaults and hardcodes pi-sdk yolo:
   `packages/agent-spaces/src/client.ts:1815-1819`, `:1872-1877`

5. HRC runtime intent loses harness identity entirely:
   `packages/hrc-server/src/index.ts:4377-4417`

6. Env/correlation injection is duplicated:
   - `buildCorrelationEnvVars()` in `agent-spaces/src/placement-api.ts:90-102`
   - `AGENTCHAT_ID` / `ASP_PROJECT` injection in `agent-spaces/src/client.ts:1675-1693`
   - similar injection in `spaces-execution/src/run.ts:631-644`
   - HRC-specific env in `hrc-server/src/agent-spaces-adapter/cli-adapter.ts:140-156`

I would centralize that into one runtime-env builder.

## 2. Overall architecture assessment and simplification/refactoring recommendations

The high-level layering is mostly right. Keeping deterministic config/materialization separate from runtime execution is a good idea. Keeping harness-specific adapters in separate packages is also reasonable.

The main problem is that the seams are not being honored. `agent-spaces` is supposed to be a façade, but it has become a second execution engine. `hrc-server` is supposed to orchestrate, but it re-derives harness/front-end choices. `hrc-cli` is supposed to be thin over the SDK, but it does local run planning and even imports `buildCliInvocation` from `hrc-server` (`packages/hrc-cli/src/cli.ts:30,1345`), which is backwards.

My recommendation is:

### 1. Collapse to one execution planning kernel

This is the biggest maintainability win by far. Until that exists, every bug fix will continue to be made 2–4 times.

I would treat the canonical planner as the architectural center of gravity and route all of these through it:

- `asp run`
- `asp agent`
- `agent-spaces` CLI build path
- `agent-spaces` SDK path
- `hrc run`
- HRC server dispatch

### 2. Keep `spaces-config` separate, but make `agent-spaces` thin

I would keep `spaces-config` as a distinct boundary. It is already the right place for deterministic resolution, merge rules, placement, locks, and materialization metadata.

I would thin `agent-spaces` aggressively. It should not parse TOML, merge profile/target defaults, or synthesize manifests itself. After the planner refactor, `agent-spaces` should mostly translate public API requests into the shared planner and then either:

- return an invocation spec, or
- run a session

### 3. Consider merging `spaces-runtime` into `spaces-execution`

This one is optional, but I think it is worth considering. The split is conceptually defensible, but in practice the two packages are tightly coupled and both are small. You have about 2.2k non-test LOC in `runtime` and 2.0k in `execution`, and consumers often need both. If the goal is maintainability and fewer moving parts, folding `spaces-runtime` into `spaces-execution` would reduce package sprawl without losing a meaningful architectural boundary.

I would not merge `spaces-config` into execution, and I would not merge the harness packages.

### 4. Decide whether `asp run` and `asp agent` both need to exist

Right now there are effectively two first-class run stacks:

- legacy `asp run` through `spaces-execution/run.ts`
- placement-driven `asp agent` through `agent-spaces`

If both are strategic, they need the same planner underneath. If one is transitional, I would make it a wrapper and eventually delete the duplicate stack.

### 5. Split the monolith files after planner consolidation

I would not start with file-splitting alone; that risks preserving the same duplication in more files. After the run planner is unified, these files should be broken apart:

- `packages/hrc-server/src/index.ts` — 6398 lines
- `packages/hrc-store-sqlite/src/repositories.ts` — 2190 lines
- `packages/agent-spaces/src/client.ts` — 1974 lines
- `packages/hrc-cli/src/cli.ts` — 1944 lines
- `packages/execution/src/run.ts` — 1633 lines

The obvious splits are:

- `hrc-server`: request parsing, runtime orchestration, launch/tmux, app-session management, bridges/surfaces, startup/recovery, serialization
- `agent-spaces/client.ts`: harness catalog, placement resolution, materialization helpers, CLI planner, SDK runner
- `hrc-cli`: one file per command area plus shared scope/run helpers
- `repositories.ts`: one repository per aggregate/root table
- `execution/run.ts`: planner, invocation builder, codex-home prep, prompt/env assembly

### 6. Unify vocabulary and delete dead surface

You currently have multiple overlapping type systems for the same concepts:

- `HrcProvider` in `hrc-core`
- `ProviderDomain` in `agent-spaces`
- `HrcHarness` in `hrc-core`
- `HarnessFrontend` in `agent-spaces`
- `HarnessId` in `spaces-config`

These should become one shared vocabulary module, with re-exports upward.

I would also audit and likely remove unused intent fields such as `fallback`, `allowFallback`, and `autoLaunchInteractive` from `hrc-core/src/contracts.ts:30-42` if they are truly dead. Keeping speculative fields in the central intent model increases cognitive load everywhere.

## Suggested sequence

1. Introduce shared harness catalog and switch all mappings to it.
2. Extend `spaces-config` with a richer placement-resolution result and delete `placementToSpec()`.
3. Introduce one execution planner in `spaces-execution`.
4. Convert `agent-spaces` CLI and SDK paths to that planner.
5. Convert `hrc-cli cmdRun` and `asp agent` to shared scope/placement helpers.
6. Either wrap or retire the duplicate `asp run` path.
7. Split `hrc-server`, `agent-spaces/client.ts`, and `hrc-cli/cli.ts`.

The highest-ROI invariant to lock in with tests is: for the same placement and the same explicit overrides, CLI and SDK planning must resolve the same harness family, prompt default, model default, yolo default, cwd, and correlation env, differing only in frontend-specific rendering.
