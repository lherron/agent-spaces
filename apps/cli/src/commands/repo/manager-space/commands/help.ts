import type { SpaceFile } from '../../manager-space-content'

export const HELP_COMMAND: SpaceFile = {
  path: 'commands/help.md',
  content: `# Help

Show available Agent Spaces CLI commands and management operations.

## Usage

Run this command when you need to see what \`asp\` commands are available or understand how to manage spaces.

## CLI Commands Reference

### Core Commands

| Command | Description |
|---------|-------------|
| \`asp run <target>\` | Run a target, space, or path - launches Claude with the composed plugins |
| \`asp install\` | Resolve targets and generate/update asp-lock.json, populate store |
| \`asp build <target> --output <dir>\` | Materialize plugins without launching Claude |

### Management Commands

| Command | Description |
|---------|-------------|
| \`asp add <spaceRef> --target <name>\` | Add a space reference to a target in asp-targets.toml |
| \`asp remove <spaceId> --target <name>\` | Remove a space from a target |
| \`asp upgrade [spaceId] [--target <name>]\` | Update lock pins according to selectors |
| \`asp diff [--target <name>]\` | Show pending lock changes without writing |

### Diagnostic Commands

| Command | Description |
|---------|-------------|
| \`asp explain <target>\` | Print resolved graph, pins, load order, warnings |
| \`asp lint\` | Validate targets/spaces, emit warnings |
| \`asp list\` | List targets, resolved spaces, cached envs |
| \`asp doctor\` | Check claude, shared spaces root, cache permissions |
| \`asp gc\` | Prune store/cache based on reachability |

### Shared Spaces Root Commands

Shared spaces live as plain directories under \`<agents-root>/spaces/<id>/\` and compose as \`space:<id>@dev\`. There is no registry to publish to; a space is live once its files are on disk.

| Command | Description |
|---------|-------------|
| \`asp repo init\` | Create the shared spaces dir and install this manager space |
| \`asp repo new-space <spaceId>\` | Scaffold a new space in the shared spaces root |
| \`asp repo status\` | Show the shared spaces root, its spaces, and uncommitted edits |
| \`asp spaces list\` | List spaces with their versions and descriptions |

## Manager Space Commands

This space provides these commands for authoring workflows:

| Command | Description |
|---------|-------------|
| \`/agent-spaces-manager:create-space\` | Scaffold a new space with correct layout |
| \`/agent-spaces-manager:add-skill\` | Add a skill with best-practice template |
| \`/agent-spaces-manager:add-command\` | Add a command with template |
| \`/agent-spaces-manager:add-hook\` | Add a hook with validation |
| \`/agent-spaces-manager:update-project-targets\` | Help update project asp-targets.toml |

## Example Workflow

1. Create a new space: Run \`/agent-spaces-manager:create-space\`
2. Add components (commands, skills, hooks)
3. Validate: \`asp lint\`
4. Use in project: \`asp add space:my-space@dev --target dev\`
`,
}
