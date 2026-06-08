# SOLID / code-smell audit — `agent-spaces`

Scope: every non-test `*.ts` under `packages/agent-spaces/src/` (including `src/testing/` conformance harnesses). Public surface is ONLY what `src/index.ts` re-exports; everything else is internal. `package.json` ships only `dist` and exports only `.` → `index.ts`, so `testing/` and the compile/turn modules are internal.

Overall: the package was recently through a SOLID cleanup pass (commit e238805). Most small files (`index.ts`, `foreground-launch.ts`, `runtime-env.ts`, `run-turn-helpers.ts`, `session-events.ts`, `run-tracker.ts`, `placement-api.ts`, `types.ts`, `broker-invocation.ts`, `client-support.ts`, `client-materialization.ts`) are clean and well-factored. Note: the previously-checked-in report in this file claimed `toAgentSpacesError` / `normalizeAttachmentRefs` were duplicated in `run-tracker.ts` — that is STALE; current `run-tracker.ts` imports both from their canonical modules and does not redefine them. The remaining real smells concentrate in the four large orchestration files: `compile-runtime-plan.ts`, `run-placement-turn.ts`, `client.ts`, `prepare-cli-runtime.ts`. The most material finding is heavy copy-paste between the two interactive tmux broker compilers plus an ~80-line plan-assembly tail repeated across all five plan builders.

---

## Dead local: unused `_clientRegistryPath`
- File: packages/agent-spaces/src/client.ts:124
- Risk: Low
- API-impact: internal-only
- Smell: `const _clientRegistryPath = options?.registryPath` is assigned but never read (methods use per-request `req.registryPath`). The `registryPath` client option is silently ignored.
- Proposed change: Delete the dead local line. (Whether to keep/wire the public `registryPath` option is a separate item below.)

## `AgentSpacesClientOptions.registryPath` is accepted but never honored
- File: packages/agent-spaces/src/client.ts:119
- Risk: High
- API-impact: public-surface
- Smell: The exported constructor option is wired nowhere (only the dead local above consumed it). Either thread it into materialization or remove it from the type.
- Proposed change: Defer. Removing or wiring it changes exported behavior/typing; a human must decide whether callers depend on it.

## Duplicated interactive tmux broker compilers
- File: packages/agent-spaces/src/compile-runtime-plan.ts:1410
- Risk: Med
- API-impact: internal-only
- Smell: `compileClaudeTmuxBrokerPlan` (1410-1644) and `compileCodexTmuxBrokerPlan` (1646-1878) are ~90% byte-identical. They differ only in: driver `kind` (`claude-code-tmux` vs `codex-cli-tmux`), the codex `hookBridge: 'codex-hooks/v1'`, and codex appending a `disallowedToolsUnsupportedDiagnostic`. Everything else (route resolve, prepare call, policy reads, spec assembly, profile assembly, validation, plan tail) is copy-pasted.
- Proposed change: Extract one private `compileTmuxBrokerPlan(req, placement, options, { driverKind, hookBridge?, emitDisallowedToolsWarning })` and have both delegate. Behavior- and hash-preserving (each driver keeps its existing field set). Largest single dedup win in the file.

## Repeated plan-assembly tail across all five plan builders
- File: packages/agent-spaces/src/compile-runtime-plan.ts:787
- Risk: Med
- API-impact: internal-only
- Smell: The block `compileId = stableId('compile', {...}) → createdAt → toResolvedBundle → toCompiledPlacement → planMaterial = {...} → planHash = projectionHash(planMaterial,'plan') → plan → return {ok:true, plan, diagnostics}` is repeated essentially verbatim at lines 787-855, 978-1040, 1295-1357, 1584-1644, 1818-1877 (5 occurrences). `lockedEnvKeys` (5x) and the `model.modelId`/`requestedModel`/`reasoningEffort` construction are likewise hand-copied.
- Proposed change: Extract a private `assemblePlan({ req, profile, profileHash, route, prepared, lockedEnvKeys, bundleIdentity, lockHash, diagnostics }): RuntimeCompileResponse` that builds compileId + planMaterial + planHash + the success response. Hash-preserving (same field shape passed to `projectionHash`).

## Misnamed shared constant `CLAUDE_TMUX_BROKER_TERMINAL` used for codex too
- File: packages/agent-spaces/src/compile-runtime-plan.ts:1371
- Risk: Low
- API-impact: internal-only
- Smell: `CLAUDE_TMUX_BROKER_TERMINAL` is assigned as `brokerTerminal` for BOTH the claude profile (1533) and the codex profile (1762). The name implies claude-only but it is a generic tmux terminal surface.
- Proposed change: Rename the internal const to `TMUX_BROKER_TERMINAL` to match its actual shared use. (Folds away if the two tmux compilers are merged per the dedup finding.)

## Repeated interactive broker-prepare request literal
- File: packages/agent-spaces/src/compile-runtime-plan.ts:1430
- Risk: Med
- API-impact: internal-only
- Smell: The `preparePlacementCliRuntime({ provider, frontend, interactionMode:'interactive', ...model, ...reasoningEffort, ...continuation, ...prompt, ...attachments, ...env channels, placement }, options?.clientAspHome)` object is built identically in `compileClaudeTmuxBrokerPlan` (1430-1453) and `compileCodexTmuxBrokerPlan` (1663-1685); the same env-channel spread also appears in `compileBrokerPlan` (680-682).
- Proposed change: Extract a private `buildInteractivePrepareRequest(req, route, placement, { disallowedTools? })`. Folds naturally into the tmux-compiler dedup above.

## `runPlacementTurnNonInteractive` is a 380-line function doing many jobs
- File: packages/agent-spaces/src/run-placement-turn.ts:61
- Risk: Med
- API-impact: internal-only
- Smell: One function performs provider validation, dry-run planning, emitter priming, model gating, a full env-channel build (locked/dispatch/brain/tools), a SECOND `planPlacementRuntime` call, agent-sdk vs pi-sdk session construction, the event loop, and success/failure assembly. Nested try/finally with an inner try.
- Proposed change: Extract module-private helpers: `buildPlacementEnvChannels(placement, req, aspHome)` (158-198), `createSdkSessionForPlacement(...)` / `createPiSessionForPlacement(...)` (236-303), `assemblePlacementTurnResult(...)` (377-418). No signature change.

## Duplicated env-channel + brain/tool build between run-placement-turn and prepare-cli-runtime
- File: packages/agent-spaces/src/run-placement-turn.ts:158
- Risk: Med
- API-impact: internal-only
- Smell: The locked/dispatch env compose + `prepareAgentBrainRuntime` + `prepareAgentToolRuntime` + the `const { PATH: toolPath, ...toolLockedEnv } = toolRuntime.env; void toolPath` PATH-strip (158-198) is near-identical to `preparePlacementCliRuntime` (prepare-cli-runtime.ts:272-338). The `void toolPath` trick is copy-pasted in both.
- Proposed change: Extract a shared private `composePlacementLaunchEnv(...)` (e.g. into runtime-env.ts) consumed by both. Behavior-preserving; flagged Med because it spans two internal modules and the dispatchEnv-overlay / ASP_HOME-injection ordering must be preserved.

## `planPlacementRuntime` invoked twice in run-placement-turn
- File: packages/agent-spaces/src/run-placement-turn.ts:85
- Risk: High
- API-impact: internal-only
- Smell: `planPlacementRuntime` is called in the pre-flight try (85-95) and again inside the main try (206-216) with the same args. Redundant work plus a drift risk (two arg lists kept in sync by hand).
- Proposed change: Defer. The planner may have side effects; a human must confirm the second call does not depend on intervening env setup before collapsing to one.

## `runTurnNonInteractive` (legacy path) is a ~240-line method
- File: packages/agent-spaces/src/client.ts:618
- Risk: Med
- API-impact: internal-only
- Smell: The legacy (non-placement) branch (626-859) mixes validation, pi-sdk continuation-path resolution, two-frontend session creation, the event loop, and result assembly in one closure — structurally parallel to `run-placement-turn.ts` but separately maintained.
- Proposed change: Extract module-private helpers (per-frontend session construction, turn-result assembly) mirroring the run-placement-turn extraction. Method signature unchanged.

## `runTurnInFlight` is a ~220-line method with hand-duplicated drains
- File: packages/agent-spaces/src/client.ts:330
- Risk: Med
- API-impact: internal-only
- Smell: The in-flight executor (330-551) nests a Promise executor inside a try inside `withAspHome`; the `.then(resolveInFlight).catch(rejectInFlight)` settle drain is hand-duplicated three times (496-498, 504-506, 513-515).
- Proposed change: Extract a private `settleInFlight(context, work)` wrapping the resolve/reject drain, and pull session construction into a helper. Internal-only.

## `preparePlacementCliRuntime` is a ~263-line function
- File: packages/agent-spaces/src/prepare-cli-runtime.ts:119
- Risk: Med
- API-impact: internal-only
- Smell: Single function does provider validation, placement resolution, runtime planning, adapter detection, materialization, system-prompt build, run-options assembly, codex-home prep, env compose, brain env, tool env, display command, and a 25-field return object.
- Proposed change: Extract in-module private steps: `buildRunOptions(...)` (220-264) and `composeLaunchEnv(...)` (272-338, shared with the dedup finding above), keeping `preparePlacementCliRuntime` as an orchestrator. Behavior-preserving.

## Duplicated namespaced-modelId slash split
- File: packages/agent-spaces/src/execute-embedded-sdk.ts:401
- Risk: Low
- API-impact: internal-only
- Smell: The `indexOf('/')` → `slice(0,i)` / `slice(i+1)` provider/model split (401-405) reimplements `parseModelId` in client-support.ts:133-147 (a similar split is also referenced in compile-runtime-plan around the embedded effectiveModel comment).
- Proposed change: Extract a tiny shared private `splitNamespacedModelId(modelId)` util and call it from both, preserving each site's distinct fallback (parseModelId → `'codex'`; executor → `profile.session.provider`). Low-risk, internal.

## Name collision: two `validateProviderMatch` with opposite semantics
- File: packages/agent-spaces/src/placement-api.ts:137
- Risk: High
- API-impact: public-surface
- Smell: `placement-api.ts` exports `validateProviderMatch` (returns `AgentSpacesError | undefined`) and re-exports it from `index.ts`; `client-support.ts` defines a different `validateProviderMatch` (throws `CodedError`, different signature). Same name, opposite control-flow contract — a foot-gun.
- Proposed change: Defer. The placement-api one is public surface (renaming breaks consumers). A human should decide whether to rename the internal `client-support` thrower to e.g. `assertProviderMatch` (internal-only, safe) while leaving the public export alone. Flagged High because the public name is involved.

## `pre-hrc-*` testing harnesses are large but are internal test infrastructure
- File: packages/agent-spaces/src/testing/pre-hrc-broker-contract-harness.ts:1379
- Risk: Med
- API-impact: internal-only
- Smell: `pre-hrc-broker-contract-harness.ts` (1562 lines) and `pre-hrc-interactive-tmux-runner.ts` (1060 lines) contain very large driver functions (`runPreHrcBrokerContractHarness`, `runInteractiveClaudeTmuxSession`). These are conformance-suite drivers — not shipped (`files: [dist]`, only `.` exported), effectively test scaffolding.
- Proposed change: Defer / out of scope for an automated API-preserving pass. Not on the public surface; step-by-step linearity is intentional. Any split should be driven by the conformance-suite owners.
