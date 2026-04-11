# Agent-Local Skills and Commands

## Problem

Agent-specific skills and commands require wrapping in a full space today:

```
~/agents/rex/
  agent-profile.toml          # spaces.base includes "space:agent:rex-skills"
  spaces/
    rex-skills/
      space.toml               # boilerplate manifest
      skills/
        peekaboo/SKILL.md
        feature-workflow/SKILL.md
```

This is excessive ceremony for content that belongs to a single agent. The `space.toml` wrapper and `space:agent:*` reference add friction without value.

## Solution

Auto-discover `skills/` and `commands/` directories in the agent root and materialize them as a synthetic plugin in the target bundle — no space wrapper, no explicit reference needed.

```
~/agents/rex/
  agent-profile.toml           # no change needed
  skills/                      # auto-discovered
    peekaboo/SKILL.md
    feature-workflow/SKILL.md
  commands/                    # auto-discovered
    deploy.md
```

## Design Decisions

1. **Auto-discovered** — no opt-in flag. If `<agentRoot>/skills/` or `<agentRoot>/commands/` exist, they are included.
2. **Name conflicts error** — if an agent-local skill/command name collides with a space-provided skill/command name, materialization fails with a clear error.
3. **Scoped to skills/ and commands/ only** — hooks, mcp, scripts remain space-only concerns (they require more configuration than a single .md file).

## Architecture

### Current Pipeline (spaces only)

```
agent-profile.toml [spaces].base
  → computeClosure() → generateLock() → populateSnapshots()
  → materializeSpace() per space         [install.ts:materializeTarget]
  → composeTarget()                      [claude-adapter.ts]
  → plugins/000-defaults/ 001-rex-skills/ ...
```

### Proposed Pipeline (spaces + agent components)

```
agent-profile.toml [spaces].base  +  <agentRoot>/skills/  +  <agentRoot>/commands/
  → computeClosure() → generateLock() → populateSnapshots()
  → materializeSpace() per space         [install.ts:materializeTarget]
  → materializeAgentComponents()         ← NEW
  → composeTarget()                      [claude-adapter.ts]
  → plugins/000-defaults/ 001-rex-skills/ ... 999-agent/   ← agent components last
```

The agent components become a synthetic artifact appended to the artifacts array before `composeTarget()` is called.

## Implementation

### Step 1: Detect agent-local components

**File:** `packages/execution/src/run.ts` — in `run()`, after `loadAgentProfileForRun()` (~line 959)

After loading the agent profile, detect whether the agent root has skills/ or commands/:

```ts
// After line 959
const agentLocalComponents = agentProfile
  ? await detectAgentLocalComponents(agentProfile.agentRoot)
  : undefined
```

Pass `agentLocalComponents` into `materializeFromRefs()` (or directly into `materializeTarget()`) so the materialization layer can incorporate them.

**New function** (add to `run.ts` or a shared utility):

```ts
interface AgentLocalComponents {
  agentRoot: string
  hasSkills: boolean
  hasCommands: boolean
  skillsDir: string   // <agentRoot>/skills
  commandsDir: string // <agentRoot>/commands
}

async function detectAgentLocalComponents(
  agentRoot: string
): Promise<AgentLocalComponents | undefined> {
  const skillsDir = join(agentRoot, 'skills')
  const commandsDir = join(agentRoot, 'commands')
  const hasSkills = await pathExists(skillsDir)
  const hasCommands = await pathExists(commandsDir)

  if (!hasSkills && !hasCommands) return undefined

  return { agentRoot, hasSkills, hasCommands, skillsDir, commandsDir }
}
```

### Step 2: Materialize agent components as a synthetic plugin

**File:** `packages/config/src/orchestration/install.ts` — in `materializeTarget()`, after the space loop (~line 390)

After all spaces have been materialized into `artifacts[]`, and before calling `adapter.composeTarget()`, build a synthetic artifact from the agent's local components.

```ts
// After the for-loop over entries, before composeTarget():
if (options.agentLocalComponents) {
  const agentArtifact = await materializeAgentLocalComponents(
    options.agentLocalComponents,
    paths,
    adapter
  )
  if (agentArtifact) {
    artifacts.push(agentArtifact)
    settingsInputs.push({})  // no settings from agent components
  }
}
```

**New function** in `install.ts`:

```ts
async function materializeAgentLocalComponents(
  components: AgentLocalComponents,
  paths: PathResolver,
  adapter: HarnessAdapter
): Promise<ResolvedSpaceArtifact | undefined> {
  // Use a stable cache key derived from agent root path
  // Agent components are always rebuilt (no caching — mutable local files)
  const tmpDir = paths.tmp(`agent-components-${basename(components.agentRoot)}`)
  await mkdir(tmpDir, { recursive: true })

  // Write minimal plugin.json
  const pluginDir = join(tmpDir, '.claude-plugin')
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify({
    name: `${basename(components.agentRoot)}-agent`,
    version: '0.0.0',
    description: 'Agent-local skills and commands',
  }, null, 2))

  // Copy skills/ if present (use copy, not hardlinks — mutable source)
  if (components.hasSkills) {
    await linkDirectory(components.skillsDir, join(tmpDir, 'skills'), { forceCopy: true })
  }

  // Copy commands/ if present
  if (components.hasCommands) {
    await linkDirectory(components.commandsDir, join(tmpDir, 'commands'), { forceCopy: true })
  }

  return {
    spaceKey: `${basename(components.agentRoot)}-agent@local` as SpaceKey,
    spaceId: `${basename(components.agentRoot)}-agent`,
    artifactPath: tmpDir,
    pluginName: `${basename(components.agentRoot)}-agent`,
    pluginVersion: '0.0.0',
  }
}
```

Key properties:
- Uses `forceCopy: true` — agent files are mutable, must not be hardlinked
- Always rebuilt on every `asp run` — no cache check (matches `space:agent:*` behavior)
- Appended **last** to `artifacts[]` so it gets the highest numeric prefix in the bundle
- Uses existing `linkDirectory()` from `link-components.ts` — no new file copy logic

### Step 3: Name collision detection

**File:** `packages/config/src/orchestration/materialize-refs.ts` — in `discoverSkills()` (~line 309)

After discovering skills from all plugins, check for duplicates:

```ts
export async function discoverSkills(pluginDirs: string[]): Promise<SkillMetadata[]> {
  const skills: SkillMetadata[] = []

  for (const pluginDir of pluginDirs) {
    const skillsDir = join(pluginDir, 'skills')
    if (!existsSync(skillsDir)) continue

    const files = await findSkillFiles(skillsDir)
    files.sort()

    for (const file of files) {
      const name = getSkillName(skillsDir, pluginDir, file)
      skills.push({ name, sourcePath: file, pluginDir })
    }
  }

  // NEW: Check for name collisions
  const seen = new Map<string, SkillMetadata>()
  for (const skill of skills) {
    const existing = seen.get(skill.name)
    if (existing) {
      throw new Error(
        `Skill name conflict: "${skill.name}" exists in both ` +
        `${basename(existing.pluginDir)} and ${basename(skill.pluginDir)}`
      )
    }
    seen.set(skill.name, skill)
  }

  return skills
}
```

Add an equivalent `discoverCommands()` function or extend `discoverSkills()` to also scan `commands/` directories for name collisions. Commands use a simpler structure (`commands/<name>.md`) so the discovery logic is a flat readdir.

**New function** (add alongside `discoverSkills()`):

```ts
export async function detectCommandConflicts(pluginDirs: string[]): Promise<void> {
  const seen = new Map<string, string>()  // name → pluginDir basename

  for (const pluginDir of pluginDirs) {
    const commandsDir = join(pluginDir, 'commands')
    if (!existsSync(commandsDir)) continue

    const entries = await readdir(commandsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const name = entry.name.replace(/\.md$/, '')
      const existing = seen.get(name)
      if (existing) {
        throw new Error(
          `Command name conflict: "${name}" exists in both ` +
          `${existing} and ${basename(pluginDir)}`
        )
      }
      seen.set(name, basename(pluginDir))
    }
  }
}
```

### Step 4: Thread agent components through the call chain

Several functions need the `agentLocalComponents` parameter threaded through:

**`packages/execution/src/run.ts`**

`run()` (~line 998): Pass `agentLocalComponents` to `materializeFromRefs()`:

```ts
await materializeFromRefs({
  targetName,
  refs: effectiveCompose,
  // ... existing options ...
  agentLocalComponents,   // NEW
})
```

**`packages/config/src/orchestration/materialize-refs.ts`**

`MaterializeFromRefsOptions` interface: Add optional field:

```ts
agentLocalComponents?: AgentLocalComponents | undefined
```

`materializeFromRefs()` (~line 215): Pass through to `materializeTarget()`:

```ts
const materialization = await materializeTarget(targetName, mergedLock, {
  ...matOptions,
  agentLocalComponents: options.agentLocalComponents,
})
```

**`packages/config/src/orchestration/install.ts`**

`InstallOptions` interface: Add optional field:

```ts
agentLocalComponents?: AgentLocalComponents | undefined
```

`materializeTarget()`: Use it as described in Step 2.

### Step 5: Collision detection call site

**File:** `packages/config/src/orchestration/materialize-refs.ts` — after `discoverSkills()` (~line 218)

```ts
const materialization = await materializeTarget(targetName, mergedLock, matOptions)
const skills = await discoverSkills(materialization.pluginDirs)
await detectCommandConflicts(materialization.pluginDirs)  // NEW
```

The skill collision check is already inside `discoverSkills()` (per Step 3). The command collision check runs separately.

### Step 6: Cleanup

The synthetic artifact directory is created in `paths.tmp()` which is inside `~/.asp/tmp/`. It should be cleaned up after `composeTarget()` copies its contents into the bundle. Add cleanup at the end of `materializeTarget()`:

```ts
// After composeTarget():
if (agentComponentsTmpDir) {
  await rm(agentComponentsTmpDir, { recursive: true, force: true }).catch(() => {})
}
```

## File-by-File Change Summary

| File | Change | Lines |
|------|--------|-------|
| `packages/execution/src/run.ts` | Detect agent-local components, pass to materialize pipeline | ~959, ~998 |
| `packages/config/src/orchestration/install.ts` | Build synthetic artifact from agent skills/commands in `materializeTarget()` | After space loop (~390) |
| `packages/config/src/orchestration/materialize-refs.ts` | Thread `agentLocalComponents`, add `detectCommandConflicts()`, add collision check in `discoverSkills()` | ~128 (options), ~215 (passthrough), ~309 (collision check) |
| `packages/config/src/core/types/harness.ts` | No change — `ResolvedSpaceArtifact` and `ComposeTargetInput` already support what we need |
| `packages/config/src/materializer/link-components.ts` | No change — reuse `linkDirectory()` with `forceCopy: true` |
| `packages/harness-claude/src/adapters/claude-adapter.ts` | No change — `composeTarget()` already iterates `input.artifacts[]` generically |

## What Does NOT Change

- `space.toml` schema — no new fields
- `agent-profile.toml` schema — no new fields (auto-discovery, not configuration)
- Lock file format — agent-local components are not versioned refs, not tracked in lock
- `composeTarget()` — it already processes an ordered `artifacts[]` array; the synthetic artifact is just another entry
- `COMPONENT_DIRS` constant — skills and commands are already in the list
- Existing `space:agent:*` local spaces — still work exactly as before

## Bundle Output

Before:
```
plugins/
  000-defaults/
    skills/frontend-design/SKILL.md
    commands/hello.md
  001-praesidium-defaults/
    skills/worktree/SKILL.md
    commands/commit.md
```

After (agent has local skills/ and commands/):
```
plugins/
  000-defaults/
    skills/frontend-design/SKILL.md
    commands/hello.md
  001-praesidium-defaults/
    skills/worktree/SKILL.md
    commands/commit.md
  999-rex-agent/                      ← synthetic plugin, always last
    .claude-plugin/plugin.json
    skills/peekaboo/SKILL.md
    skills/feature-workflow/SKILL.md
    commands/deploy.md
```

The `999` prefix is not literal — it's `String(artifacts.length - 1).padStart(3, '0')` since the agent artifact is appended last to the array. For a 3-space compose + agent components, it would be `003-rex-agent/`.

## Testing

### Unit Tests

**`packages/config/src/orchestration/install.test.ts`** (or new file):
- `materializeAgentLocalComponents()` creates correct directory structure
- Skills only, commands only, both, neither — all four combos
- `forceCopy: true` is used (verify files are copies, not hardlinks)

**`packages/config/src/orchestration/materialize-refs.test.ts`**:
- `discoverSkills()` throws on name collision between space skill and agent skill
- `detectCommandConflicts()` throws on name collision between space command and agent command
- No error when names are unique across spaces and agent

**`packages/execution/src/run.test.ts`**:
- `detectAgentLocalComponents()` returns undefined when no skills/ or commands/
- Returns correct structure when skills/ exists
- Returns correct structure when commands/ exists
- Returns correct structure when both exist

### Integration Tests

**`integration-tests/tests/harness.test.ts`** (extend existing):
- Create a test agent with `skills/test-skill/SKILL.md` and `commands/test-cmd.md`
- Run `asp run <agent> --dry-run`
- Verify the skill and command appear in the bundle's plugin dirs
- Verify the skill is listed in discovered skills

**Collision test**:
- Create agent with `skills/frontend-design/SKILL.md` (conflicts with defaults space)
- Verify `asp run` fails with a clear error message naming both sources

## Migration Path

Existing agents with `spaces/<name>/` wrappers continue to work. No breaking changes.

To migrate an agent like rex:

1. Move `spaces/rex-skills/skills/*` → `skills/*`
2. Move `spaces/rex-skills/commands/*` → `commands/*` (if any)
3. Remove `space:agent:rex-skills` from `agent-profile.toml [spaces].base`
4. Delete `spaces/rex-skills/` directory
5. Run `asp run rex --dry-run` to verify

If the space contained hooks, mcp, or other non-skill/command components, those must remain in a space.
