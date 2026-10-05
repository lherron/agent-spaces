# Help

Show available Agent Spaces CLI commands and management operations.

## Usage

Run this command when you need to see what `asp` commands are available or understand how to manage spaces.

## CLI Commands Reference

### Core Commands

| Command | Description |
|---------|-------------|
| `asp run <target> [prompt]` | Run a target, space reference, or path with optional prompt |
| `asp install` | Resolve targets, update asp-lock.json, and materialize project bundles under ASP_HOME |
| `asp build <target> --output <dir>` | Materialize plugins without launching the harness |

### Management Commands

| Command | Description |
|---------|-------------|
| `asp add <spaceRef> --target <name>` | Add a space reference to a target |
| `asp remove <spaceId> --target <name>` | Remove a space from a target |
| `asp upgrade [spaceIds...] [--target <name>]` | Update lock file pins according to selectors |
| `asp diff [--target <name>]` | Show pending lock changes without writing |

### Diagnostic Commands

| Command | Description |
|---------|-------------|
| `asp explain [target]` | Print resolved graph, pins, load order, warnings |
| `asp describe [target]` | Describe hooks, skills, tools, and lint warnings |
| `asp lint [target]` | Validate targets and detect conflicts |
| `asp list` | List targets, resolved spaces, and cached environments |
| `asp doctor` | Check harness binary, shared spaces root, cache permissions |
| `asp harnesses` | List available harnesses and their status |
| `asp path <spaceId>` | Print the filesystem path to a space |

### Shared Spaces Root Commands

Shared spaces live as plain directories under `<agents-root>/spaces/<id>/` and compose as `space:<id>@dev`. There is no registry to publish to; a space is live once its files are on disk.

| Command | Description |
|---------|-------------|
| `asp repo init` | Create the shared spaces dir and install this manager space |
| `asp repo new-space <spaceId>` | Scaffold a new space in the shared spaces root |
| `asp repo status` | Show the shared spaces root, its spaces, and uncommitted edits |
| `asp spaces list` | List spaces with their versions and descriptions |

### Other Commands

| Command | Description |
|---------|-------------|
| `asp init` | Create a new asp-targets.toml project file |
| `asp gc` | Garbage collect unreferenced store and cache entries |

## Key Command Options

### asp run

```
asp run <target> [prompt]
  --harness <id>        Harness to use (default: agent-harness; also claude, codex, muse)
  --model <model>       Model override
  --yolo                Skip all permission prompts
  --dry-run             Print the harness command without executing
  --no-refresh          Skip refresh and use cached project bundles
  --debug               Enable Claude hook debugging
  --no-interactive      Run non-interactively
  --inherit-all         Inherit all harness settings
  --settings <file>     Path to settings JSON file or JSON string
```

### asp install

```
asp install
  --targets <names...>  Specific targets to install
  --harness <id>        Harness to use (default: agent-harness)
  --update              Update existing lock (re-resolve selectors)
  --refresh             Force re-copy from source (clear cache)
```

## Available Harnesses

ASP supports multiple coding agent harnesses:

| Harness | Description |
|---------|-------------|
| `agent-harness` | Pi-based agent harness (default) - supports extensions, skills |
| `claude` | Claude Code - supports plugins, commands, agents, MCP, settings |
| `codex` | Codex - commands map to prompts, skills supported |
| `muse` | Muse harness |

Use `asp harnesses` to check which are available on your system.

## Harness Notes (Multi-Harness)

- Most commands accept `--harness <id>` (default: `agent-harness`) to select the runtime.
- The default `agent-harness` runs only agent targets with a validated agent profile; run dev targets, space refs and space paths with `--harness claude` or `--harness codex`.
- Project targets are harness-agnostic; choose the harness at run/build/install time.
- Project bundles are materialized per harness under ASP_HOME.

## Manager Space Commands

This space provides these commands for authoring workflows:

| Command | Description |
|---------|-------------|
| `/agent-spaces-manager:help` | Show this help |
| `/agent-spaces-manager:space-authoring` | Full authoring guide (multi-harness) |
| `/agent-spaces-manager:create-space` | Scaffold a new space with correct layout |
| `/agent-spaces-manager:add-command` | Add a command with template (Claude-only) |
| `/agent-spaces-manager:add-skill` | Add a skill with best-practice template |
| `/agent-spaces-manager:add-hook` | Add a hook with validation |
| `/agent-spaces-manager:add-extension` | Add an agent-harness (Pi) extension with template |
| `/agent-spaces-manager:validate-space` | Run lint checks and explain warnings |
| `/agent-spaces-manager:update-project-targets` | Help update project asp-targets.toml |

## Example Workflow

1. Create the shared spaces dir (once): `asp repo init`
2. Read the authoring guide: `/agent-spaces-manager:space-authoring`
3. Create a new space: `/agent-spaces-manager:create-space`
4. Add components (commands, skills, hooks, extensions)
5. Validate: `/agent-spaces-manager:validate-space`
6. Use in project: `asp add space:my-space@dev --target dev`
7. Run with a harness: `asp run dev --harness claude`
