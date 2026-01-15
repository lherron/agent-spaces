# Help

Show available Agent Spaces CLI commands and management operations.

## Usage

Run this command when you need to see what `asp` commands are available or understand how to manage spaces.

## CLI Commands Reference

### Core Commands

| Command | Description |
|---------|-------------|
| `asp run <target>` | Run a target, space, or path - launches Claude with the composed plugins |
| `asp install` | Resolve targets and generate/update asp-lock.json, populate store |
| `asp build <target> --output <dir>` | Materialize plugins without launching Claude |

### Management Commands

| Command | Description |
|---------|-------------|
| `asp add <spaceRef> --target <name>` | Add a space reference to a target in asp-targets.toml |
| `asp remove <spaceId> --target <name>` | Remove a space from a target |
| `asp upgrade [spaceId] [--target <name>]` | Update lock pins according to selectors |
| `asp diff [--target <name>]` | Show pending lock changes without writing |

### Diagnostic Commands

| Command | Description |
|---------|-------------|
| `asp explain <target>` | Print resolved graph, pins, load order, warnings |
| `asp lint` | Validate targets/spaces, emit warnings |
| `asp list` | List targets, resolved spaces, cached envs |
| `asp doctor` | Check claude, registry, cache permissions |
| `asp gc` | Prune store/cache based on reachability |

### Repository Commands

| Command | Description |
|---------|-------------|
| `asp repo init [--clone <url>]` | Create/clone registry, install manager space |
| `asp repo status` | Show registry repo status |
| `asp repo publish <spaceId> --tag vX.Y.Z` | Create git tag, optionally update dist-tags |
| `asp repo tags <spaceId>` | List tags for a space |

## Manager Space Commands

This space provides these commands for authoring workflows:

| Command | Description |
|---------|-------------|
| `/agent-spaces-manager:create-space` | Scaffold a new space with correct layout |
| `/agent-spaces-manager:add-skill` | Add a skill with best-practice template |
| `/agent-spaces-manager:add-command` | Add a command with template |
| `/agent-spaces-manager:add-hook` | Add a hook with validation |
| `/agent-spaces-manager:bump-version` | Update version in space.toml |
| `/agent-spaces-manager:publish` | Run asp repo publish |
| `/agent-spaces-manager:update-project-targets` | Help update project asp-targets.toml |

## Example Workflow

1. Initialize your registry: `asp repo init`
2. Create a new space: Run `/agent-spaces-manager:create-space`
3. Add components (commands, skills, hooks)
4. Bump version: Run `/agent-spaces-manager:bump-version`
5. Publish: Run `/agent-spaces-manager:publish`
6. Use in project: `asp add space:my-space@stable --target dev`
