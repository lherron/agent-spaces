# Agent-Level Defaults Configuration Plan

Move agent identity and runtime defaults from per-project `asp-targets.toml` / `.animata/config.toml` into `~/agents/<agent>/agent-profile.toml`, with project-local override support.

## Goal

Run `asp agent larry:myproject query "do something"` in **any directory** — with or without `asp-targets.toml` — and have the agent function with its default identity, priming prompt, harness config, and space composition.

## Problem

Today agent config is scattered:

| Field | Lives in | Problem |
|---|---|---|
| `priming_prompt` | `asp-targets.toml` per target | Copy-pasted across every project |
| `compose` (spaces) | `asp-targets.toml` per target | Repeated per project |
| `model`, `yolo`, `claude.*`, `codex.*` | `asp-targets.toml` per target | Repeated per project |
| `harness` | `.animata/config.toml` per agent | Separate from target options |
| `display`, `role` | `.animata/config.toml` per agent | Not in asp-spaces at all |

`asp agent` **fails** if no `asp-targets.toml` exists in the project directory and no `--project-target` / `--compose` is provided — the `agent-default` bundle returns empty spaces.

---

## Design

### Two-Layer Config: Agent Defaults + Project Overrides

```
Layer 1: ~/agents/<agent>/agent-profile.toml     (agent defaults — always loaded)
Layer 2: ./asp-targets.toml [targets.<agent>]     (project overrides — optional)
Layer 3: CLI flags (--model, --yolo, etc.)        (invocation overrides)
```

Each layer overrides the previous. Field-level merge for scalar/sub-table fields. Explicit mode control for `compose` and `priming_prompt`.

### Agent Discovery

Resolution order for agent root directory:

1. **CLI flag:** `--agent-root /path/to/agent`
2. **Env var:** `ASP_AGENTS_ROOT` → `$ASP_AGENTS_ROOT/<agent-name>/`
3. **ASP home config:** `~/.asp/config.toml` → `agents-root` key
4. **Convention default:** `~/agents/<agent-name>/`

Steps 1-3 already work via `getAgentsRoot()` in `packages/config/src/store/asp-config.ts`. Step 4 is new — add `~/agents` as the fallback when no explicit agents-root is configured.

---

## Schema: `agent-profile.toml` v2

```toml
schemaVersion = 2

# ── Identity (NEW) ──────────────────────────────────────────
[identity]
display = "Larry"                          # Display name
role = "coder"                             # Role hint: coder | qa | ops | facilitator
harness = "codex"                          # Default harness: claude-code | codex-cli | agent-sdk | pi-sdk

# ── Priming Prompt (NEW) ────────────────────────────────────
# Default priming prompt. Used when project does not override.
priming_prompt = """
You are Larry, a coding agent in a shared workbench.

## Startup
1. Run `agentchat info` and `wrkq info` immediately.
2. Wait for incoming requests.
"""
# Alternative: load from file relative to agent root
# priming_prompt_file = "PRIMING.md"

# ── Spaces (existing, unchanged) ───────────────────────────
[spaces]
base = ["space:defaults@dev"]

[spaces.byMode.heartbeat]
base = ["space:agent:task-worker"]

# ── Instructions (existing, unchanged) ─────────────────────
[instructions]
additionalBase = ["agent-root:///SOUL.md"]

# ── Harness Defaults (EXTENDED) ────────────────────────────
[harnessDefaults]
model = "claude-opus-4-6"
yolo = false                               # NEW: skip permission prompts

# Claude-specific defaults (NEW sub-table)
[harnessDefaults.claude]
permission_mode = "default"
args = []

# Codex-specific defaults (NEW sub-table)
[harnessDefaults.codex]
model_reasoning_effort = "high"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

# ── Per-mode harness overrides (existing, extended with sub-tables) ──
[harnessByMode.heartbeat]
model = "claude-haiku-4-5"

[harnessByMode.heartbeat.codex]
approval_policy = "never"

# ── Named Targets (existing, unchanged) ────────────────────
[targets.review]
compose = ["space:agent:private-ops", "space:project:repo-defaults"]

[targets.delivery]
compose = ["space:agent:task-worker", "space:project:task-scaffolds"]
```

### New fields vs v1

| Field | Type | Default | Description |
|---|---|---|---|
| `identity.display` | `string` | agent dir name | Human-readable name |
| `identity.role` | `string` | `undefined` | Role hint for orchestrators |
| `identity.harness` | `string` | `"claude-code"` | Default harness binary |
| `priming_prompt` | `string` | `undefined` | Default priming prompt text |
| `priming_prompt_file` | `string` | `undefined` | Path to priming prompt file (relative to agent root) |
| `harnessDefaults.yolo` | `boolean` | `false` | Skip permission prompts |
| `harnessDefaults.claude` | `ClaudeOptions` | `{}` | Claude-specific defaults |
| `harnessDefaults.codex` | `CodexOptions` | `{}` | Codex-specific defaults |
| `harnessByMode.<mode>.claude` | `ClaudeOptions` | `{}` | Per-mode claude overrides |
| `harnessByMode.<mode>.codex` | `CodexOptions` | `{}` | Per-mode codex overrides |

**Backward compatibility:** `schemaVersion: 1` profiles continue to parse and work. Missing v2 fields simply produce no defaults (same as today).

---

## Project Override: `asp-targets.toml`

`asp-targets.toml` becomes an optional **override layer**. Two new fields per target:

```toml
[targets.larry]
description = "Larry for agent-spaces"

# Spaces override with explicit mode control
compose_mode = "merge"                     # NEW: "replace" (default) | "merge"
compose = ["space:praesidium-defaults@dev"]

# Priming prompt override (replace)
priming_prompt = "You are Larry in agent-spaces..."

# OR priming prompt append (additive)
# priming_prompt_append = "\n## Project: agent-spaces\n..."

# Harness overrides (field-level merge with agent defaults)
[targets.larry.codex]
model_reasoning_effort = "high"
```

### `compose_mode` Semantics

**`replace`** (default): Project `compose` fully replaces agent's `spaces.base` + `spaces.byMode`:

```
Agent spaces.base:    [A, B]
Agent spaces.byMode:  [C]
Project compose:      [D, E]
→ Effective:          [D, E]
```

**`merge`**: Project `compose` is appended to agent layers, deduplicated (first-seen wins by normalized key):

```
Agent spaces.base:    [A, B]
Agent spaces.byMode:  [C]
Project compose:      [B, E]       (B duplicates agent base)
→ Effective:          [A, B, C, E] (B deduplicated)
```

### `priming_prompt` / `priming_prompt_append` Rules

- `priming_prompt` set → **replaces** agent default entirely
- `priming_prompt_append` set → agent default + `\n` + append text
- Both set → **config error** (ambiguous, fail at load time)
- Neither set → agent default passes through

---

## Merge Function

```typescript
interface EffectiveTargetConfig {
  priming_prompt?: string
  compose: SpaceRefString[]
  yolo: boolean
  harness: string
  model?: string
  claude: ClaudeOptions
  codex: CodexOptions
  description?: string
}

function mergeAgentWithProjectTarget(
  agentProfile: AgentRuntimeProfileV2,
  projectTarget: TargetDefinition | undefined,  // from asp-targets.toml
  runMode: RunMode
): EffectiveTargetConfig {
  const composeMode = projectTarget?.compose_mode ?? 'replace'

  // 1. Resolve effective compose
  let compose: SpaceRefString[]
  if (!projectTarget?.compose) {
    // No project override → full agent layering
    compose = deduplicateSpaces([
      ...(agentProfile.spaces?.base ?? []),
      ...(agentProfile.spaces?.byMode?.[runMode] ?? []),
    ])
  } else if (composeMode === 'replace') {
    compose = projectTarget.compose
  } else {
    // merge: agent layers + project, deduplicated
    compose = deduplicateSpaces([
      ...(agentProfile.spaces?.base ?? []),
      ...(agentProfile.spaces?.byMode?.[runMode] ?? []),
      ...projectTarget.compose,
    ])
  }

  // 2. Resolve priming prompt
  const priming_prompt = mergePrimingPrompt(
    agentProfile.priming_prompt,
    projectTarget
  )

  // 3. Resolve harness options (agent defaults + project overrides, field-level)
  const claude = mergeClaudeOptions(
    agentProfile.harnessDefaults?.claude,
    projectTarget?.claude
  )
  const codex = mergeCodexOptions(
    agentProfile.harnessDefaults?.codex,
    projectTarget?.codex
  )

  return {
    priming_prompt,
    compose,
    yolo: projectTarget?.yolo ?? agentProfile.harnessDefaults?.yolo ?? false,
    harness: agentProfile.identity?.harness ?? 'claude-code',
    model: projectTarget?.claude?.model ?? projectTarget?.codex?.model
           ?? agentProfile.harnessDefaults?.model,
    claude,
    codex,
    description: projectTarget?.description,
  }
}

function mergePrimingPrompt(
  agentDefault: string | undefined,
  projectTarget: { priming_prompt?: string; priming_prompt_append?: string } | undefined
): string | undefined {
  if (!projectTarget) return agentDefault
  if (projectTarget.priming_prompt && projectTarget.priming_prompt_append) {
    throw new ConfigValidationError(
      'Cannot set both priming_prompt and priming_prompt_append on the same target'
    )
  }
  if (projectTarget.priming_prompt != null) return projectTarget.priming_prompt
  if (projectTarget.priming_prompt_append && agentDefault) {
    return `${agentDefault}\n${projectTarget.priming_prompt_append}`
  }
  return agentDefault
}
```

---

## End-to-End Example

### `~/agents/larry/agent-profile.toml`

```toml
schemaVersion = 2

[identity]
display = "Larry"
role = "coder"
harness = "codex"

priming_prompt = """
You are Larry, a coding agent in a shared workbench.

## Startup
1. Run `agentchat info` and `wrkq info` immediately.
2. Wait for incoming requests.

## Workflow
1. Review or create wrkq task.
2. Work with smokey for red/green TDD on impactful changes.
3. Implement, validate, commit.
"""

[spaces]
base = ["space:defaults@dev"]

[harnessDefaults]
model = "claude-opus-4-6"

[harnessDefaults.codex]
model_reasoning_effort = "high"
```

### `~/praesidium/agent-spaces/asp-targets.toml` (project override)

```toml
schema = 1

[targets.larry]
description = "Larry for agent-spaces"
compose_mode = "merge"
compose = ["space:praesidium-defaults@dev"]
priming_prompt_append = """

## Project: agent-spaces
- Uses Bun workspace, TypeScript.
- Run `just verify` before committing.
"""

[targets.clod]
description = "clod code rules the world"
yolo = true
compose = ["space:defaults@dev", "space:praesidium-defaults@dev", "space:praesidium-architect@dev"]
```

### Effective config: `asp agent larry:agent-spaces query "fix the bug"`

```
harness:          codex
model:            claude-opus-4-6
compose:          [space:defaults@dev, space:praesidium-defaults@dev]  (merged)
codex.effort:     high
yolo:             false
priming_prompt:   "You are Larry..." + "\n## Project: agent-spaces\n..."
```

### Effective config: `asp agent larry:random-project query "fix the bug"` (no asp-targets.toml)

```
harness:          codex
model:            claude-opus-4-6
compose:          [space:defaults@dev]  (agent base only)
codex.effort:     high
yolo:             false
priming_prompt:   "You are Larry..."  (agent default only)
```

---

## Implementation Plan

### Phase 1: Types and Parser (packages/config)

#### Step 1.1 — Extend AgentRuntimeProfile types

**File:** `packages/config/src/core/types/agent-profile.ts`

Add v2 types alongside v1 (backward-compatible):

```typescript
// Existing (unchanged)
export interface HarnessSettings {
  model?: string | undefined
  sandboxMode?: string | undefined
  approvalPolicy?: string | undefined
  profile?: string | undefined
}

// NEW: Identity section
export interface AgentIdentity {
  display?: string | undefined
  role?: string | undefined
  harness?: string | undefined
}

// NEW: Extended harness settings with harness-specific sub-tables
export interface ExtendedHarnessSettings extends HarnessSettings {
  yolo?: boolean | undefined
  claude?: ClaudeOptions | undefined
  codex?: CodexOptions | undefined
}

// NEW: Extended per-mode harness settings
export interface ExtendedHarnessByMode {
  [mode: string]: ExtendedHarnessSettings | undefined
}

// EXTENDED: v2 profile (superset of v1)
export interface AgentRuntimeProfile {
  schemaVersion: 1 | 2
  identity?: AgentIdentity | undefined                          // NEW
  priming_prompt?: string | undefined                           // NEW
  priming_prompt_file?: string | undefined                      // NEW
  instructions?: AgentProfileInstructions | undefined
  spaces?: AgentProfileSpaces | undefined
  targets?: Record<string, AgentProfileTarget> | undefined
  harnessDefaults?: ExtendedHarnessSettings | undefined         // WIDENED from HarnessSettings
  harnessByMode?: Partial<Record<RunMode, ExtendedHarnessSettings>> | undefined  // WIDENED
}
```

Import `ClaudeOptions` and `CodexOptions` from `./targets.js`.

#### Step 1.2 — Extend agent-profile.toml parser

**File:** `packages/config/src/core/config/agent-profile-toml.ts`

Changes to `parseAgentProfile()`:

1. Accept `schemaVersion` 1 or 2 (line 205-206).
2. Add `identity`, `priming_prompt`, `priming_prompt_file` to the `assertOnlyKeys` allowlist (line 198-203).
3. Parse `[identity]` section — validate `display`, `role`, `harness` are strings. Validate `harness` against known values.
4. Parse `priming_prompt` as optional string.
5. Parse `priming_prompt_file` as optional string. Error if both `priming_prompt` and `priming_prompt_file` are set.
6. Extend `parseHarnessSettings()` to accept `yolo` (boolean), `claude` (sub-table), `codex` (sub-table) when `schemaVersion >= 2`.

New helper functions:
- `parseIdentity(value, source, path): AgentIdentity | undefined`
- `parseClaudeOptions(value, source, path): ClaudeOptions | undefined`
- `parseCodexOptions(value, source, path): CodexOptions | undefined`

#### Step 1.3 — Add `compose_mode` and `priming_prompt_append` to TargetDefinition

**File:** `packages/config/src/core/types/targets.ts`

```typescript
export interface TargetDefinition {
  description?: string
  priming_prompt?: string
  priming_prompt_append?: string              // NEW
  compose: SpaceRefString[]
  compose_mode?: 'replace' | 'merge'          // NEW (default: 'replace')
  claude?: ClaudeOptions
  codex?: CodexOptions
  resolver?: ResolverConfig
  yolo?: boolean
}
```

#### Step 1.4 — Extend targets-toml parser

**File:** `packages/config/src/core/config/targets-toml.ts`

Parse `compose_mode` (validate enum) and `priming_prompt_append` (string) from target definitions. Error if both `priming_prompt` and `priming_prompt_append` are set on the same target.

#### Step 1.5 — Add merge utilities

**File:** `packages/config/src/core/merge/agent-project-merge.ts` (NEW)

Contains:
- `mergeAgentWithProjectTarget()` — main merge function (see Merge Function section above)
- `mergePrimingPrompt()` — priming prompt merge with replace/append logic
- `resolveEffectiveCompose()` — compose merge with replace/merge mode
- Re-exports `mergeClaudeOptions` and `mergeCodexOptions` from targets.ts

#### Step 1.6 — Add priming_prompt_file resolution

**File:** `packages/config/src/core/merge/agent-project-merge.ts`

```typescript
function resolveAgentPrimingPrompt(profile: AgentRuntimeProfile, agentRoot: string): string | undefined {
  if (profile.priming_prompt) return profile.priming_prompt
  if (profile.priming_prompt_file) {
    const filePath = join(agentRoot, profile.priming_prompt_file)
    return readFileSync(filePath, 'utf8')
  }
  return undefined
}
```

### Phase 2: New Bundle Kind + Placement Resolution (packages/config)

#### Step 2.1 — Add `agent-project` bundle kind

**File:** `packages/config/src/core/types/placement.ts`

```typescript
export type RuntimeBundleRef =
  | { kind: 'agent-default' }
  | { kind: 'agent-target'; target: string }
  | { kind: 'project-target'; projectRoot: string; target: string }
  | { kind: 'compose'; compose: SpaceRefString[] }
  | { kind: 'agent-project'; agentName: string; projectRoot?: string }  // NEW
```

Update `VALID_BUNDLE_KINDS` set to include `'agent-project'`.

#### Step 2.2 — Extend placement resolver

**File:** `packages/config/src/resolver/placement-resolver.ts`

Add `agent-project` case to `resolveBundleSpaces()`:

```typescript
case 'agent-project': {
  // 1. Load agent-profile.toml (v1 or v2)
  const profile = loadAgentProfile(placement.agentRoot)

  // 2. Optionally load asp-targets.toml from projectRoot
  let projectTarget: TargetDefinition | undefined
  if (bundle.projectRoot) {
    projectTarget = loadProjectTargetOptional(bundle.projectRoot, bundle.agentName)
  }

  // 3. Merge and return effective compose list
  const effective = mergeAgentWithProjectTarget(profile, projectTarget, placement.runMode)
  return effective.compose
}
```

New helpers:
- `loadAgentProfile(agentRoot): AgentRuntimeProfile` — load and parse agent-profile.toml, return empty profile if not found
- `loadProjectTargetOptional(projectRoot, targetName): TargetDefinition | undefined` — load asp-targets.toml and extract target, return undefined if file or target missing

#### Step 2.3 — Extend `agent-default` bundle to use agent profile spaces

Currently `agent-default` returns `[]`. Change to load agent-profile.toml spaces.base + spaces.byMode when available:

```typescript
case 'agent-default': {
  const profile = loadAgentProfile(placement.agentRoot)
  if (!profile?.spaces) return []
  return deduplicateSpaces([
    ...(profile.spaces.base ?? []),
    ...(profile.spaces.byMode?.[placement.runMode] ?? []),
  ])
}
```

This is a behavioral change but safe — today agent-default returns `[]`, so any new spaces are additive.

### Phase 3: CLI Integration (packages/cli)

#### Step 3.1 — Auto-detect `agent-project` bundle

**File:** `packages/cli/src/commands/agent/shared.ts`

Modify `buildBundleRef()` to produce `agent-project` when no explicit bundle selector is provided:

```typescript
export function buildBundleRef(options: BundleRefOptions): RuntimeBundleRef {
  if (options.agentTarget) {
    return { kind: 'agent-target', target: options.agentTarget }
  }
  if (options.projectTarget) {
    if (!options.projectRoot) throw new Error('--project-root is required with --project-target')
    return { kind: 'project-target', projectRoot: options.projectRoot, target: options.projectTarget }
  }
  if (options.compose && options.compose.length > 0) {
    return { kind: 'compose', compose: options.compose as SpaceRefString[] }
  }
  // NEW: default to agent-project when we have enough context
  if (options.agentName) {
    return {
      kind: 'agent-project',
      agentName: options.agentName,
      projectRoot: options.projectRoot,
    }
  }
  return { kind: 'agent-default' }
}
```

#### Step 3.2 — Pass agent name through CLI

**File:** `packages/cli/src/commands/agent/index.ts`

The scope already contains the agent ID (`parseScopeRef(canonicalRef).agentId`). Thread `agentName` into the options passed to `buildBundleRef()`:

```typescript
// In the action handler, after parsing scope:
const parsed = parseScopeRef(canonicalRef)
// ... existing agent root resolution ...

// Pass agentName to buildBundleRef
const bundle = buildBundleRef({ ...options, agentName: parsed.agentId })
```

#### Step 3.3 — Agent discovery fallback to ~/agents

**File:** `packages/config/src/store/asp-config.ts`

Add `~/agents` as the convention default when no explicit agents-root is configured:

```typescript
export function getAgentsRoot(opts?: ConfigOptions): string | undefined {
  const explicit = getConfiguredRoot('ASP_AGENTS_ROOT', 'agents-root', opts)
  if (explicit) return explicit

  // Convention default: ~/agents if it exists
  const env = opts?.env ?? process.env
  const home = env['HOME'] ?? homedir()
  const conventionPath = join(home, 'agents')
  return existsSync(conventionPath) ? conventionPath : undefined
}
```

### Phase 4: Harness Adapter Integration (packages/agent-spaces)

#### Step 4.1 — Thread effective config through buildPlacementInvocationSpec

**File:** `packages/agent-spaces/src/client.ts` (lines 1404-1528)

When the bundle kind is `agent-project`, load the merged effective config and use it to:

1. **Resolve harness** — use `effectiveConfig.harness` as the default when `req.frontend` is not explicitly set (or add a mechanism for the CLI to pass the agent's default harness).
2. **Inject priming prompt** — if `req.prompt` is not set, use `effectiveConfig.priming_prompt`.
3. **Inject harness options** — pass `effectiveConfig.claude` / `effectiveConfig.codex` to the adapter's `getDefaultRunOptions()`.
4. **Inject yolo** — `effectiveConfig.yolo` as default (CLI `--yolo` still overrides).
5. **Inject model** — `effectiveConfig.model` as default (CLI `--model` still overrides).

The key change is that today `getDefaultRunOptions()` loads from the materialized `ProjectManifest`. For `agent-project`, the manifest is the merged result, not raw asp-targets.toml. The cleanest approach:

- In `placementToSpec()` / `materializeSpec()`, when bundle is `agent-project`, build a synthetic `ProjectManifest` from the merged effective config.
- This means the adapter sees a normal manifest with the correct merged values — no adapter changes needed.

```typescript
// In buildPlacementInvocationSpec, before materializeSpec:
if (placement.bundle.kind === 'agent-project') {
  const profile = loadAgentProfile(placement.agentRoot)
  const projectTarget = loadProjectTargetOptional(
    placement.bundle.projectRoot,
    placement.bundle.agentName
  )
  const effective = mergeAgentWithProjectTarget(profile, projectTarget, placement.runMode)

  // Build synthetic manifest with merged config
  syntheticManifest = {
    schema: 1,
    claude: effective.claude,
    codex: effective.codex,
    targets: {
      [placement.bundle.agentName]: {
        compose: effective.compose,
        priming_prompt: effective.priming_prompt,
        yolo: effective.yolo,
        claude: effective.claude,
        codex: effective.codex,
      }
    }
  }
}
```

### Phase 5: Tests

#### Step 5.1 — Unit tests for agent-profile.toml v2 parser

**File:** `packages/config/src/core/config/__tests__/agent-profile-toml.test.ts`

- Parse v2 profile with identity, priming_prompt, extended harnessDefaults
- Parse v1 profile unchanged (backward compat)
- Reject unknown fields in identity
- Reject both priming_prompt + priming_prompt_file
- Parse harnessDefaults.claude and harnessDefaults.codex sub-tables
- Parse harnessByMode with claude/codex sub-tables

#### Step 5.2 — Unit tests for merge logic

**File:** `packages/config/src/core/merge/__tests__/agent-project-merge.test.ts` (NEW)

- Agent-only (no project target) → agent defaults pass through
- Project replaces compose (compose_mode = replace)
- Project merges compose (compose_mode = merge) with deduplication
- Project replaces priming_prompt
- Project appends priming_prompt_append
- Error on both priming_prompt + priming_prompt_append
- Field-level merge of claude/codex options
- yolo override
- model override cascading

#### Step 5.3 — Unit tests for targets-toml parser

**File:** `packages/config/src/core/config/__tests__/targets-toml.test.ts`

- Parse compose_mode field
- Parse priming_prompt_append field
- Reject both priming_prompt + priming_prompt_append

#### Step 5.4 — Unit tests for placement resolver agent-project bundle

**File:** `packages/config/src/resolver/__tests__/placement-resolver.test.ts`

- agent-project with agent profile only (no asp-targets.toml)
- agent-project with agent profile + project override (replace compose)
- agent-project with agent profile + project override (merge compose)
- agent-default loads agent profile spaces.base when available

#### Step 5.5 — Integration test for CLI agent-project flow

**File:** `packages/cli/src/commands/agent/__tests__/agent-project.test.ts` (NEW)

- buildBundleRef returns agent-project when no explicit target
- Full dry-run with fixture agent profile + project targets → verify effective argv

#### Step 5.6 — Test fixtures

**Directory:** `packages/config/src/__fixtures__/v2/`

- `agent-root-v2/agent-profile.toml` — full v2 profile with identity, priming_prompt, extended harness
- `project-with-overrides/asp-targets.toml` — project that overrides agent defaults
- `project-with-merge/asp-targets.toml` — project using compose_mode = merge
- `project-with-append/asp-targets.toml` — project using priming_prompt_append
- `bare-project/` — directory with no asp-targets.toml (tests agent-only path)

### Phase 6: .animata/config.toml Simplification (downstream, not in this PR)

After agent-profile.toml v2 is live, `.animata/config.toml` can drop `display`, `role`, `harness`, and `asp_target` from agent entries. The `ani` CLI resolves these from `~/agents/<id>/agent-profile.toml` at runtime. This is a separate change in the animata project.

---

## File Impact Summary

| File | Change Type | Description |
|---|---|---|
| `packages/config/src/core/types/agent-profile.ts` | MODIFY | Add AgentIdentity, ExtendedHarnessSettings, v2 fields to AgentRuntimeProfile |
| `packages/config/src/core/types/targets.ts` | MODIFY | Add compose_mode, priming_prompt_append to TargetDefinition |
| `packages/config/src/core/types/placement.ts` | MODIFY | Add agent-project to RuntimeBundleRef union |
| `packages/config/src/core/config/agent-profile-toml.ts` | MODIFY | Accept schemaVersion 2, parse identity/priming/extended harness |
| `packages/config/src/core/config/targets-toml.ts` | MODIFY | Parse compose_mode, priming_prompt_append |
| `packages/config/src/core/merge/agent-project-merge.ts` | NEW | mergeAgentWithProjectTarget, mergePrimingPrompt, resolveEffectiveCompose |
| `packages/config/src/store/asp-config.ts` | MODIFY | Add ~/agents convention fallback in getAgentsRoot |
| `packages/config/src/resolver/placement-resolver.ts` | MODIFY | Handle agent-project bundle kind, extend agent-default |
| `packages/cli/src/commands/agent/index.ts` | MODIFY | Thread agentName, use agent-project bundle by default |
| `packages/cli/src/commands/agent/shared.ts` | MODIFY | buildBundleRef produces agent-project when agentName available |
| `packages/agent-spaces/src/client.ts` | MODIFY | Build synthetic manifest from merged config for agent-project |
| Test files (5+) | NEW/MODIFY | See Phase 5 |
| Fixture files (5+) | NEW | See Phase 5 |

---

## Open Decisions

1. **`priming_prompt_file` resolution base** — Relative to agent root only, or also support `agent-root:///` URIs for consistency with instruction refs? Recommend: plain relative path for simplicity in v2, add URI support later if needed.

2. **Harness auto-selection from agent profile** — Today `--harness` defaults to `claude-code` in the CLI. Should `identity.harness` from agent-profile.toml override this default before CLI flags? Recommend: yes, the resolution order should be CLI flag > agent-profile.toml > `claude-code` default.

3. **Validation strictness** — Should `asp agent larry:project query` fail if `~/agents/larry/` doesn't exist, or silently fall back to empty defaults? Recommend: warn but continue if agent root doesn't exist (enables gradual migration).
