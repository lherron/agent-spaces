# asp run: Agent Profile Integration Gaps

The `asp run` (legacy) path in `packages/execution/src/run.ts` does not fully integrate with `~/agents/<agent>/agent-profile.toml`. Only `priming_prompt_append` merging was added (commit `b8f598b`). The `asp agent` path handles all of these correctly via the `agent-project` bundle kind.

## Current State

`asp run` reads everything from `asp-targets.toml` directly. The only agent-profile integration is:
- When a target has `priming_prompt_append` but no `priming_prompt`, load the agent's base prompt from agent-profile.toml and concatenate.

## Gaps

### 1. yolo (BUG — animan lost yolo=true)

**File:** `packages/execution/src/run.ts` ~line 710
**Agent-profile field:** `harnessDefaults.yolo`
**Impact:** animan's `yolo = true` was in the old asp-targets.toml but removed during Phase 5 migration. `asp run` doesn't read it from agent-profile.toml, so animan now runs without yolo via `asp run`/`ani`.
**Quick fix:** Restore `yolo = true` to `[targets.animan]` in asp-targets.toml.
**Proper fix:** Merge `profile.harnessDefaults.yolo` as default in `asp run`, with target-level `yolo` and CLI `--yolo` taking precedence.

### 2. model

**File:** `packages/execution/src/run.ts` ~line 710
**Agent-profile field:** `harnessDefaults.model`
**Impact:** Agent default model (e.g., `claude-opus-4-6`) is not applied. Currently no practical impact because targets either specify their own model via codex/claude sub-tables or rely on harness built-in defaults.
**Proper fix:** Use `profile.harnessDefaults.model` as default, overridden by target-level and CLI `--model`.

### 3. Harness-specific defaults (codex/claude sub-tables)

**File:** `packages/execution/src/run.ts` ~line 696 (adapter.getDefaultRunOptions)
**Agent-profile fields:** `harnessDefaults.codex.*`, `harnessDefaults.claude.*`
**Impact:** Agent-level codex defaults (model_reasoning_effort, approval_policy, sandbox_mode) and claude defaults (permission_mode, args) are not merged. Currently mitigated because `[targets.larry.codex]` and `[targets.animata.codex]` in asp-targets.toml duplicate these values.
**Proper fix:** Build a synthetic manifest that merges agent-profile harness defaults under project-level target overrides, so `adapter.getDefaultRunOptions()` sees the merged values.

### 4. identity.harness (default harness selection)

**Agent-profile field:** `identity.harness`
**Impact:** Agent's preferred harness is not auto-selected by `asp run`. The `ani` launcher passes `--harness` explicitly per agent, so no current impact. Manual `asp run larry` still defaults to claude (not codex).
**Proper fix:** If no `--harness` flag, check agent-profile `identity.harness` before falling back to the default.

### 5. compose_mode = "merge" (agent spaces composition)

**Agent-profile field:** `spaces.base`, `spaces.byMode`
**Impact:** `asp run` doesn't merge agent-profile spaces with project compose. Currently mitigated because asp-targets.toml retains full compose arrays for legacy compatibility.
**Proper fix:** When bundle is resolved, apply the same `resolveEffectiveCompose()` merge logic used in the `asp agent` path. This would allow removing duplicate compose arrays from asp-targets.toml.

## Recommended Approach

Extend `asp run` in `packages/execution/src/run.ts` to load agent-profile.toml (when it exists) and merge all effective fields before building run options. The pattern established by `resolveAgentPrimingPromptForRun()` can be generalized:

```typescript
function resolveAgentDefaults(targetName: string): AgentRuntimeProfile | undefined {
  const agentsRoot = getAgentsRoot()
  if (!agentsRoot) return undefined
  const profilePath = join(agentsRoot, targetName, 'agent-profile.toml')
  if (!existsSync(profilePath)) return undefined
  return parseAgentProfile(readFileSync(profilePath, 'utf8'), profilePath)
}
```

Then in `run()`, before building run options:
1. Load agent profile (if exists)
2. Merge priming prompt (already done)
3. Merge yolo: `target.yolo ?? profile.harnessDefaults?.yolo`
4. Merge model: `options.model ?? profile.harnessDefaults?.model`
5. Merge codex/claude: field-level merge of profile defaults under target overrides
6. Merge compose: apply `resolveEffectiveCompose()` when `compose_mode = "merge"`

Falls back to current behavior when no agent profile exists (e.g., `clod`).

## Immediate Fix (before full implementation)

Restore `yolo = true` to `[targets.animan]` in asp-targets.toml to fix the animan regression.

## Files to Modify

| File | Change |
|---|---|
| `packages/execution/src/run.ts` | Generalize agent-profile loading, merge all fields |
| `asp-targets.toml` | (immediate) Restore animan yolo; (after full fix) remove duplicate compose/codex |
| `packages/execution/src/run.test.ts` | Tests for agent-profile merge in asp run path |
