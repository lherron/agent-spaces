# Multi-Harness Smoke Testing Plan

> **Status:** In Progress - fixtures use unsupported space refs; CLI ignores --harness for run/build/install
> **Created:** 2025-01-11
> **Location:** ~/projects/asp-smoke

## Objective

Manually smoke test multi-harness support (Phase 5 from IMPLEMENTATION_PLAN.md) by creating a test spaces repository and running through the key scenarios.

## Codebase Understanding (from exploration)

### Harness Architecture
- **HarnessAdapter interface** (`packages/core/src/types/harness.ts`): Common interface for harnesses with methods:
  - `detect()` - Find harness binary, get version/capabilities
  - `validateSpace()` - Check space compatibility
  - `materializeSpace()` - Transform space into harness-specific artifact
  - `composeTarget()` - Assemble multiple artifacts into target bundle
  - `buildRunArgs()` - Generate CLI arguments
  - `getTargetOutputPath()` - Get output path (`asp_modules/<target>/<harness>/`)

### ClaudeAdapter (`packages/engine/src/harness/claude-adapter.ts`)
- Wraps existing `@agent-spaces/claude` and `@agent-spaces/materializer` packages
- Key transformations:
  - `hooks.toml` → `hooks/hooks.json` (Claude format)
  - `permissions.toml` → merged into `settings.json`
  - `AGENT.md` → `CLAUDE.md`
- Output: `asp_modules/<target>/claude/plugins/<NNN-spaceId>/`

### PiAdapter (`packages/engine/src/harness/pi-adapter.ts`)
- Extension bundling with Bun (`.ts` → `.js`)
- Tool namespacing: `<spaceId>__<name>.js`
- Hook bridge generation: `asp-hooks.bridge.js`
- Model translation: `sonnet` → `claude-sonnet`
- Output: `asp_modules/<target>/pi/extensions/`

### CLI Commands
- `asp harnesses` - List available harnesses (TESTED - WORKS)
- `asp run <target> --harness <id> --dry-run` - Preview run command
- `asp install --harness <id>` - Install for specific harness
- `asp build <target> --harness <id>` - Build for specific harness
- `asp explain <target> --harness <id>` - Explain target configuration

### Key Files
- Hooks TOML: `packages/materializer/src/hooks-toml.ts`
- Permissions TOML: `packages/materializer/src/permissions-toml.ts`
- Link components: `packages/materializer/src/link-components.ts` (AGENT.md handling)
- Registry: `packages/engine/src/harness/registry.ts`

## Smoke Test Setup Created

### Directory Structure
```
~/projects/asp-smoke/
├── spaces/
│   ├── core/           # Base space, no deps
│   │   ├── space.toml
│   │   ├── AGENT.md
│   │   ├── permissions.toml
│   │   └── skills/coding/SKILL.md
│   ├── tools/          # Depends on core
│   │   ├── space.toml  # [deps] core = "space:core@dev"
│   │   ├── hooks/
│   │   │   ├── hooks.toml
│   │   │   ├── validate.sh
│   │   │   ├── log.sh
│   │   │   └── cleanup.sh
│   │   └── commands/{build,test}.md
│   └── app/            # Depends on tools (transitive on core)
│       ├── space.toml  # [deps] tools = "space:tools@dev"
│       ├── extensions/helper.ts  # Pi extension
│       ├── commands/deploy.md
│       └── skills/debugging/SKILL.md
└── project/
    └── asp-targets.toml  # Targets: full, tools-only, core-only
```

### Dependency Graph
```
app → tools → core
```

### Harness Availability (Confirmed)
```
✔ claude (2.1.4) - default
✔ pi (0.40.0)
```

## Issues Encountered

**Problem:** Space references like `space:core@dev` require spaces to be in a registry structure at `<registryPath>/spaces/<id>/space.toml`.

The current setup has spaces at `~/projects/asp-smoke/spaces/` but the resolver expects them relative to a registry path.

**Solution Needed:** Either:
1. Restructure to `~/projects/asp-smoke/registry/spaces/{core,tools,app}/` and set `ASP_HOME` or `--registry` flag
2. Or use the existing integration-tests fixtures which are already set up correctly

**New Issue:** `integration-tests/fixtures/multi-harness/multi-harness-project/asp-targets.toml` uses `space:path:../...@dev` refs. These now fail validation (`space:<id>@<selector>` only). The CLI error suggests invalid space ref format.

**New Issue:** `asp run --harness pi` (and `asp build/install/explain --harness pi`) ignores the harness option and still uses Claude. CLI validates the harness, but does not pass it to engine. This blocks Pi harness smoke testing via CLI.

## Tests to Run

### Completed
- [x] `asp harnesses` - Lists both Claude and Pi correctly
- [x] `asp harnesses --json` - JSON output works
- [x] `asp run claude-combo --harness claude --dry-run` with temp registry/project - generates multi-plugin Claude command
- [x] Verified hooks.toml → hooks.json conversion (keeps hooks.toml)
- [x] Verified AGENT.md → CLAUDE.md renaming
- [x] Verified permissions.toml merged into target settings.json
- [x] Verified MCP composition into target mcp.json
- [x] Invalid harness error (`--harness nope`) prints available harnesses

### Blocked (need registry fix)
- [ ] `asp run <target> --harness claude --dry-run` using fixture project (blocked by space:path refs)
- [ ] `asp run <target> --harness pi --dry-run` (blocked: CLI ignores harness)
- [ ] Verify Pi extension bundling and tool namespacing (blocked: CLI ignores harness)
- [ ] Error case: missing harness binary (not exercised; both claude and pi found)

## Commands to Resume Testing

```bash
# Set up registry path properly
ASP_HOME=~/projects/asp-smoke/registry bun packages/cli/bin/asp.js run full --harness claude --dry-run --project ~/projects/asp-smoke/project

# Or use existing fixtures
cd /Users/lherron/projects/agent-spaces-v2
bun packages/cli/bin/asp.js run full-stack --harness claude --dry-run --project integration-tests/fixtures/multi-harness/multi-harness-project

# Temp registry/project workaround (local smoke)
REG=/tmp/asp-smoke-registry
PROJ=/tmp/asp-smoke-project
bun packages/cli/bin/asp.js run claude-combo --harness claude --dry-run --project $PROJ --registry $REG
bun packages/cli/bin/asp.js run full-stack --harness claude --dry-run --project $PROJ --registry $REG
```

## Files Created in asp-smoke

All files listed above were created. Hook scripts made executable with `chmod +x`.

## Files Created (local temp)

- `/tmp/asp-smoke-registry/spaces/{claude-only,pi-only,multi-harness}/`
- `/tmp/asp-smoke-project/asp-targets.toml`

## Next Steps

1. **Fix registry structure**: Move spaces to `~/projects/asp-smoke/registry/spaces/` or restructure
2. **Run Claude tests**: `--dry-run` first, then check materialized output
3. **Run Pi tests**: Verify extension bundling, hook bridge generation
4. **Check composed output**: Inspect `asp_modules/` for correct structure
5. **Document defects**: Write any blocking issues back to IMPLEMENTATION_PLAN.md

## Reference: Test Fixture Paths

Existing well-formed fixtures for reference:
```
integration-tests/fixtures/multi-harness/
├── claude-only/
├── pi-only/
├── multi-harness/
└── multi-harness-project/asp-targets.toml
```

These use `space:path:../relative-path@dev` format in compose arrays.
