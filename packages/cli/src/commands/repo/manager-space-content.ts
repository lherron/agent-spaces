/**
 * Embedded content for the agent-spaces-manager space.
 *
 * WHY: This allows repo init to install the manager space without
 * needing to access external files. The manager space is bundled
 * into the CLI package.
 */

export const MANAGER_SPACE_ID = 'agent-spaces-manager'
export const MANAGER_SPACE_VERSION = '1.0.0'

export interface SpaceFile {
  path: string
  content: string
}

/**
 * Get all files for the manager space.
 * Files are returned with paths relative to spaces/agent-spaces-manager/
 */
export function getManagerSpaceFiles(): SpaceFile[] {
  return [
    { path: 'space.toml', content: SPACE_TOML },
    { path: 'commands/help.md', content: COMMAND_HELP },
    { path: 'commands/create-space.md', content: COMMAND_CREATE_SPACE },
    { path: 'commands/add-command.md', content: COMMAND_ADD_COMMAND },
    { path: 'commands/add-skill.md', content: COMMAND_ADD_SKILL },
    { path: 'commands/add-hook.md', content: COMMAND_ADD_HOOK },
    { path: 'commands/bump-version.md', content: COMMAND_BUMP_VERSION },
    { path: 'commands/publish.md', content: COMMAND_PUBLISH },
    { path: 'commands/update-project-targets.md', content: COMMAND_UPDATE_PROJECT_TARGETS },
    { path: 'skills/space-authoring/SKILL.md', content: SKILL_SPACE_AUTHORING },
    { path: 'agents/manager.md', content: AGENT_MANAGER },
  ]
}

// ============================================================
// Embedded file contents
// ============================================================

const SPACE_TOML = `# Agent Spaces Manager
# Built-in management space for creating and managing spaces in the registry

schema = 1
id = "agent-spaces-manager"
version = "1.0.0"
description = "Management space for creating, publishing, and managing Agent Spaces"

[plugin]
name = "agent-spaces-manager"
description = "Tools and guidance for authoring and managing Agent Spaces"
license = "MIT"
keywords = ["management", "authoring", "scaffolding", "publishing"]
`

const COMMAND_HELP = `# Help

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
| \`asp doctor\` | Check claude, registry, cache permissions |
| \`asp gc\` | Prune store/cache based on reachability |

### Repository Commands

| Command | Description |
|---------|-------------|
| \`asp repo init [--clone <url>]\` | Create/clone registry, install manager space |
| \`asp repo status\` | Show registry repo status |
| \`asp repo publish <spaceId> --tag vX.Y.Z\` | Create git tag, optionally update dist-tags |
| \`asp repo tags <spaceId>\` | List tags for a space |

## Manager Space Commands

This space provides these commands for authoring workflows:

| Command | Description |
|---------|-------------|
| \`/agent-spaces-manager:create-space\` | Scaffold a new space with correct layout |
| \`/agent-spaces-manager:add-skill\` | Add a skill with best-practice template |
| \`/agent-spaces-manager:add-command\` | Add a command with template |
| \`/agent-spaces-manager:add-hook\` | Add a hook with validation |
| \`/agent-spaces-manager:bump-version\` | Update version in space.toml |
| \`/agent-spaces-manager:publish\` | Run asp repo publish |
| \`/agent-spaces-manager:update-project-targets\` | Help update project asp-targets.toml |

## Example Workflow

1. Initialize your registry: \`asp repo init\`
2. Create a new space: Run \`/agent-spaces-manager:create-space\`
3. Add components (commands, skills, hooks)
4. Bump version: Run \`/agent-spaces-manager:bump-version\`
5. Publish: Run \`/agent-spaces-manager:publish\`
6. Use in project: \`asp add space:my-space@stable --target dev\`
`

const COMMAND_CREATE_SPACE = `# Create Space

Scaffold a new space with the correct directory layout and initial files.

## Usage

Run this command to create a new space in the registry. You will be guided through the process.

## Required Information

1. **Space ID**: A kebab-case identifier (e.g., \`my-awesome-space\`)
   - Must be lowercase letters, numbers, and hyphens only
   - Must start with a letter
   - Maximum 64 characters

2. **Description**: Brief description of what this space does

3. **Initial Components** (optional):
   - Commands to include
   - Skills to include
   - Hooks to include (if needed)

## Directory Structure

The created space will have this structure:

\`\`\`
spaces/<space-id>/
├── space.toml          # Space manifest (required)
├── commands/           # Command definitions (optional)
│   └── example.md
├── skills/             # Skill definitions (optional)
│   └── example/
│       └── SKILL.md
├── agents/             # Agent definitions (optional)
│   └── example.md
├── hooks/              # Hook configurations (optional)
│   ├── hooks.json
│   └── scripts/
│       └── example.sh
└── mcp/                # MCP server configs (optional)
    └── mcp.json
\`\`\`

## Execution Steps

When you run this command, I will:

1. **Ask for space details**:
   - Space ID (kebab-case identifier)
   - Description
   - Initial version (default: 0.1.0)
   - Which components to include

2. **Create the directory structure**:
   \`\`\`bash
   mkdir -p ~/.asp/repo/spaces/<space-id>/{commands,skills,agents,hooks/scripts,mcp}
   \`\`\`

3. **Generate space.toml**:
   \`\`\`toml
   schema = 1
   id = "<space-id>"
   version = "0.1.0"
   description = "<description>"

   [plugin]
   name = "<space-id>"
   \`\`\`

4. **Create initial component files** based on your selections

5. **Verify the structure** using \`asp lint\`

## Example

To create a space for frontend development tools:

1. Run \`/agent-spaces-manager:create-space\`
2. Enter ID: \`frontend-tools\`
3. Enter description: "Frontend development commands and skills"
4. Select components: commands, skills
5. The space will be created at \`~/.asp/repo/spaces/frontend-tools/\`

## Next Steps After Creation

1. Add content to your commands/skills/agents
2. Test locally: \`asp run ~/.asp/repo/spaces/<space-id>\`
3. Bump version: \`/agent-spaces-manager:bump-version\`
4. Publish: \`/agent-spaces-manager:publish\`

## Important Notes

- Space IDs must be unique within the registry
- The space.toml file is required and must pass validation
- Component directories (commands/, skills/, etc.) are only needed if you have content for them
- Always use \`\${CLAUDE_PLUGIN_ROOT}\` in hook scripts for paths
`

const COMMAND_ADD_COMMAND = `# Add Command

Add a new command to an existing space with best-practice template.

## Usage

Run this command to add a command to a space. Commands are invokable actions that Claude can execute when the user requests them.

## Required Information

1. **Space ID or Path**: Which space to add the command to
2. **Command Name**: Filename for the command (kebab-case, without .md)
3. **Command Title**: Human-readable title
4. **Command Description**: What the command does

## Command Structure

Commands are stored as markdown files in the \`commands/\` directory:

\`\`\`
spaces/<space-id>/
└── commands/
    └── <command-name>.md
\`\`\`

When loaded, the command is accessible as:
- \`/agent-spaces-manager:<command-name>\` (fully-qualified)
- \`/<command-name>\` (if no collision with other plugins)

## Template

The created command will follow this structure:

\`\`\`markdown
# <Command Title>

<Brief description of what this command does>

## Usage

<When and how to use this command>

## Parameters

<Any inputs or context needed>

## Execution Steps

<What happens when this command runs>

## Example

<Show the command in action>

## Notes

<Important considerations or limitations>
\`\`\`

## Execution Steps

When you run this command, I will:

1. **Identify the target space**:
   - Ask which space to modify
   - Verify the space exists

2. **Get command details**:
   - Command name (kebab-case, e.g., \`run-tests\`)
   - Command title (e.g., "Run Tests")
   - Description of functionality

3. **Create the commands directory** (if needed):
   \`\`\`bash
   mkdir -p ~/.asp/repo/spaces/<space-id>/commands
   \`\`\`

4. **Generate <command-name>.md** with best-practice template

5. **Verify** the command file is valid

## Example

Adding a "run-tests" command to a development space:

\`\`\`markdown
# Run Tests

Execute the project's test suite and report results.

## Usage

Run this command when you want to:
- Verify code changes don't break existing functionality
- Check test coverage
- Debug failing tests

## Parameters

- **Test Pattern** (optional): Glob pattern to filter tests (e.g., \`*.unit.test.ts\`)
- **Watch Mode** (optional): Whether to run in watch mode

## Execution Steps

1. Detect the test framework (Jest, Vitest, Bun test, etc.)
2. Run the appropriate test command
3. Parse and summarize results
4. Report failures with actionable suggestions

## Example

User: "Run the unit tests for the auth module"

I'll execute:
\\\`\\\`\\\`bash
bun test src/auth/**/*.test.ts
\\\`\\\`\\\`

## Notes

- Ensure dependencies are installed before running tests
- Some tests may require environment variables
- Watch mode is useful during active development
\`\`\`

## Best Practices for Commands

1. **Clear Purpose**: Each command should do one thing well
2. **Descriptive Names**: Use verb-noun format (e.g., \`run-tests\`, \`create-component\`)
3. **Document Parameters**: Be explicit about required vs optional inputs
4. **Show Examples**: Real usage examples help users understand the command
5. **Fully-Qualified References**: Always use \`/plugin:command\` format when referencing other commands

## Important Notes

- Commands are invoked via \`/plugin:command\` syntax
- Always use fully-qualified command names in your documentation
- Keep commands focused and composable
`

const COMMAND_ADD_SKILL = `# Add Skill

Add a new skill to an existing space with best-practice template.

## Usage

Run this command to add a skill to a space. A skill provides specialized knowledge or capabilities that Claude can use during conversations.

## Required Information

1. **Space ID or Path**: Which space to add the skill to
2. **Skill Name**: Name for the skill directory (kebab-case)
3. **Skill Title**: Human-readable title for the skill
4. **Skill Description**: What the skill does and when to use it

## Skill Structure

Skills are stored in \`skills/<skill-name>/SKILL.md\`:

\`\`\`
spaces/<space-id>/
└── skills/
    └── <skill-name>/
        └── SKILL.md
\`\`\`

## Template

The created SKILL.md will follow this structure:

\`\`\`markdown
# <Skill Title>

<Description of what this skill does>

## When to Use

<Describe when Claude should activate this skill>

## Context

<Provide domain knowledge, best practices, patterns>

## Guidelines

<Specific instructions for how to apply this skill>

## Examples

<Show examples of the skill in action>
\`\`\`

## Execution Steps

When you run this command, I will:

1. **Identify the target space**:
   - Ask which space to modify
   - Verify the space exists

2. **Get skill details**:
   - Skill name (kebab-case, e.g., \`code-review\`)
   - Skill title (e.g., "Code Review Expert")
   - Description and trigger conditions

3. **Create the skill directory and file**:
   \`\`\`bash
   mkdir -p ~/.asp/repo/spaces/<space-id>/skills/<skill-name>
   \`\`\`

4. **Generate SKILL.md** with best-practice template

5. **Verify** the skill is properly structured

## Example

Adding a TypeScript skill to a development space:

\`\`\`markdown
# TypeScript Expert

Expert guidance for TypeScript development.

## When to Use

Activate this skill when:
- Writing or reviewing TypeScript code
- Configuring tsconfig.json
- Debugging type errors
- Migrating JavaScript to TypeScript

## Context

TypeScript is a typed superset of JavaScript. Key principles:
- Prefer strict mode (\`"strict": true\`)
- Use explicit return types for public APIs
- Leverage type inference for local variables
- Avoid \`any\` - use \`unknown\` when type is truly unknown

## Guidelines

1. **Type Definitions**
   - Define interfaces for object shapes
   - Use type aliases for unions and complex types
   - Export types that are part of public API

2. **Generics**
   - Use meaningful constraint names
   - Default to simpler types when generics aren't needed

3. **Error Handling**
   - Type catch blocks properly
   - Use discriminated unions for result types

## Examples

### Good: Typed function
\\\`\\\`\\\`typescript
function processItems<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map(item => [item.id, item]));
}
\\\`\\\`\\\`
\`\`\`

## Best Practices

- Keep skills focused on a specific domain
- Provide concrete examples
- Include when-to-use triggers
- Document edge cases and gotchas
- Update skills as you learn new patterns
`

const COMMAND_ADD_HOOK = `# Add Hook

Add a new hook to an existing space with proper configuration.

## Usage

Run this command to add a hook to a space. Hooks allow Claude to execute scripts at specific points during the conversation lifecycle.

## Required Information

1. **Space ID or Path**: Which space to add the hook to
2. **Hook Event**: When the hook should trigger
3. **Script Name**: Name of the script file
4. **Script Content**: What the script should do

## Hook Events

Available hook events:

| Event | Description |
|-------|-------------|
| \`on_session_start\` | Runs when a Claude session begins |
| \`on_session_end\` | Runs when a Claude session ends |
| \`on_command_start\` | Runs before a command executes |
| \`on_command_end\` | Runs after a command completes |
| \`on_tool_start\` | Runs before a tool is invoked |
| \`on_tool_end\` | Runs after a tool completes |

## Hook Structure

Hooks require both a configuration file and script files:

\`\`\`
spaces/<space-id>/
└── hooks/
    ├── hooks.json      # Hook configuration (required)
    └── scripts/        # Script files
        └── <script>.sh
\`\`\`

## hooks.json Format

\`\`\`json
{
  "hooks": [
    {
      "event": "<event-type>",
      "command": "\${CLAUDE_PLUGIN_ROOT}/hooks/scripts/<script>.sh",
      "timeout_ms": 5000
    }
  ]
}
\`\`\`

**IMPORTANT**: Always use \`\${CLAUDE_PLUGIN_ROOT}\` for script paths. This ensures paths resolve correctly regardless of where the plugin is materialized.

## Execution Steps

When you run this command, I will:

1. **Identify the target space**:
   - Ask which space to modify
   - Verify the space exists

2. **Get hook details**:
   - Hook event type
   - Script name
   - Script functionality

3. **Create the hooks structure** (if needed):
   \`\`\`bash
   mkdir -p ~/.asp/repo/spaces/<space-id>/hooks/scripts
   \`\`\`

4. **Create or update hooks.json**:
   - Add the new hook entry
   - Preserve existing hooks

5. **Create the script file**:
   - Generate script with shebang
   - Make it executable (\`chmod +x\`)

6. **Verify** the hook configuration is valid

## Example

Adding a session-start hook to log environment info:

### hooks.json
\`\`\`json
{
  "hooks": [
    {
      "event": "on_session_start",
      "command": "\${CLAUDE_PLUGIN_ROOT}/hooks/scripts/log-session-start.sh",
      "timeout_ms": 3000
    }
  ]
}
\`\`\`

### scripts/log-session-start.sh
\`\`\`bash
#!/bin/bash
# Log session start for debugging

echo "Session started at $(date)"
echo "Working directory: $(pwd)"
echo "Node version: $(node --version 2>/dev/null || echo 'not installed')"
\`\`\`

## Best Practices

1. **Use \`\${CLAUDE_PLUGIN_ROOT}\`**: Always use this variable for paths in hooks.json
2. **Set Reasonable Timeouts**: Default to 5000ms, adjust based on script complexity
3. **Make Scripts Executable**: Scripts must have execute permission
4. **Handle Errors Gracefully**: Scripts should exit 0 even if they fail (to not block Claude)
5. **Keep Scripts Fast**: Hooks should complete quickly to not slow down Claude
6. **Log for Debugging**: Include logging to help troubleshoot issues

## Warnings

The lint system will emit warnings for:
- **W203**: Hook path missing \`\${CLAUDE_PLUGIN_ROOT}\`
- **W204**: hooks/ exists but hooks.json missing or invalid
- **W206**: Hook script not executable

## Script Template

\`\`\`bash
#!/bin/bash
# <Description of what this hook does>
# Event: <event-type>

set -e  # Exit on error (optional, remove if you want to continue on failure)

# Your hook logic here

exit 0
\`\`\`
`

const COMMAND_BUMP_VERSION = `# Bump Version

Update the version in a space's space.toml file.

## Usage

Run this command before publishing a space to update its semantic version.

## Required Information

1. **Space ID or Path**: Which space to version bump
2. **Bump Type**: major, minor, or patch
   - **major**: Breaking changes (1.0.0 -> 2.0.0)
   - **minor**: New features, backwards compatible (1.0.0 -> 1.1.0)
   - **patch**: Bug fixes, backwards compatible (1.0.0 -> 1.0.1)

Or specify an explicit version:
3. **Explicit Version**: Set a specific version (e.g., "2.0.0-beta")

## Semantic Versioning

Follow semantic versioning (semver) conventions:

- **MAJOR**: Increment when you make incompatible changes
  - Removing commands or skills
  - Changing command behavior in breaking ways
  - Restructuring that affects dependents

- **MINOR**: Increment when you add functionality in a backward-compatible manner
  - Adding new commands
  - Adding new skills
  - Adding new optional features

- **PATCH**: Increment when you make backward-compatible bug fixes
  - Fixing typos
  - Fixing command behavior bugs
  - Improving documentation

## Execution Steps

When you run this command, I will:

1. **Identify the target space**:
   - Locate space.toml
   - Read current version

2. **Determine new version**:
   - Ask for bump type (major/minor/patch) or explicit version
   - Calculate new version

3. **Update space.toml**:
   \`\`\`toml
   # Before
   version = "1.0.0"

   # After (patch bump)
   version = "1.0.1"
   \`\`\`

4. **Also update plugin.version** if present:
   \`\`\`toml
   [plugin]
   version = "1.0.1"
   \`\`\`

5. **Show the changes** for confirmation

## Example

Bumping a patch version:

\`\`\`
Current version: 1.2.3
Bump type: patch
New version: 1.2.4
\`\`\`

Setting an explicit prerelease version:

\`\`\`
Current version: 1.2.4
Explicit version: 2.0.0-beta.1
New version: 2.0.0-beta.1
\`\`\`

## After Bumping

After updating the version, you typically want to:

1. **Commit the change**:
   \`\`\`bash
   cd ~/.asp/repo
   git add spaces/<space-id>/space.toml
   git commit -m "chore(<space-id>): bump version to X.Y.Z"
   \`\`\`

2. **Publish the space**:
   Run \`/agent-spaces-manager:publish\` to create a git tag and optionally update dist-tags

## Best Practices

1. **Bump before publishing**: Always update version before \`asp repo publish\`
2. **Use meaningful versions**: Don't bump major version for minor changes
3. **Document changes**: Keep a changelog or commit history
4. **Consider dependents**: Major bumps may require updates in dependent spaces
5. **Use prereleases for testing**: \`2.0.0-beta.1\`, \`2.0.0-rc.1\`

## Version History

To see version history for a space:
\`\`\`bash
asp repo tags <space-id>
\`\`\`

This shows all published versions (git tags like \`space/<id>/v1.0.0\`).
`

const COMMAND_PUBLISH = `# Publish

Publish a space to the registry by creating a git tag and optionally updating dist-tags.

## Usage

Run this command to publish a new version of a space to the registry.

## Required Information

1. **Space ID**: Which space to publish
2. **Version Tag**: The version to publish (e.g., \`v1.0.0\`)
3. **Dist-tag** (optional): Channel to update (e.g., \`stable\`, \`latest\`, \`beta\`)

## What Publishing Does

1. **Validates the space** - Runs lint checks
2. **Creates a git tag** - Immutable semver tag: \`space/<id>/vX.Y.Z\`
3. **Updates dist-tags** (optional) - Modifies \`registry/dist-tags.json\`
4. **Commits changes** - If dist-tags were updated

## Execution Steps

When you run this command, I will:

1. **Identify the space**:
   - Verify it exists in the registry
   - Read current version from space.toml

2. **Validate the space**:
   \`\`\`bash
   asp lint ~/.asp/repo/spaces/<space-id>
   \`\`\`
   - Must pass with no errors (warnings are OK)

3. **Create the git tag**:
   \`\`\`bash
   cd ~/.asp/repo
   git tag space/<space-id>/v<version>
   \`\`\`

4. **Update dist-tags** (if requested):
   - Read \`registry/dist-tags.json\`
   - Update the specified channel
   - Commit the change

5. **Show summary** of what was published

## Example

Publishing version 1.2.0 as stable:

\`\`\`bash
# This is what happens behind the scenes:
cd ~/.asp/repo

# Validate
asp lint spaces/my-space

# Create tag
git tag space/my-space/v1.2.0

# Update dist-tags.json
# { "my-space": { "stable": "v1.2.0", "latest": "v1.2.0" } }

git add registry/dist-tags.json
git commit -m "chore(dist-tags): my-space@stable -> v1.2.0"
\`\`\`

## Dist-Tags Explained

Dist-tags provide named channels for versions:

| Tag | Purpose |
|-----|---------|
| \`stable\` | Production-ready, thoroughly tested |
| \`latest\` | Most recent release |
| \`beta\` | Pre-release for testing |
| \`canary\` | Cutting-edge, potentially unstable |

Users reference these in \`asp-targets.toml\`:
\`\`\`toml
compose = ["space:my-space@stable"]
\`\`\`

## CLI Equivalent

This command wraps:
\`\`\`bash
asp repo publish <spaceId> --tag v<version> [--dist-tag <tag>]
\`\`\`

## Pre-publish Checklist

Before publishing, ensure:

1. **Version is bumped**: Run \`/agent-spaces-manager:bump-version\` first
2. **Changes are committed**: All space changes should be committed
3. **Lint passes**: No errors in the space
4. **Tested locally**: Try \`asp run ~/.asp/repo/spaces/<space-id>\`

## After Publishing

1. **Push tags to remote** (if using remote registry):
   \`\`\`bash
   cd ~/.asp/repo
   git push origin space/<space-id>/v<version>
   git push origin main  # or your default branch
   \`\`\`

2. **Verify in projects**:
   \`\`\`bash
   cd /path/to/project
   asp upgrade <space-id>
   asp explain <target>
   \`\`\`

## Important Notes

- Git tags are **immutable** - once created, they cannot be changed
- Dist-tag updates are **committed metadata** - they're PR-reviewable
- Publishing does NOT push to remote - do that separately if needed
- Spaces should be validated before publishing
`

const COMMAND_UPDATE_PROJECT_TARGETS = `# Update Project Targets

Help update a project's \`asp-targets.toml\` to compose spaces into run targets.

## Usage

Run this command when you need to configure which spaces are used in a project's targets.

## What is asp-targets.toml?

The \`asp-targets.toml\` file in a project root defines run targets - named compositions of spaces that can be launched with \`asp run <target>\`.

## File Location

\`\`\`
project-root/
├── asp-targets.toml    # Defines targets
├── asp-lock.json       # Generated lock file (don't edit manually)
└── ...
\`\`\`

## File Format

\`\`\`toml
schema = 1

# Global Claude options (optional)
[claude]
model = "claude-sonnet-4-20250514"
permission_mode = "acceptEdits"

# Define targets
[targets.dev]
description = "Development environment with all tools"
compose = [
  "space:frontend-tools@stable",
  "space:backend-tools@stable",
  "space:testing-utils@^1.0.0"
]

[targets.review]
description = "Code review focused environment"
compose = [
  "space:code-review@stable"
]

# Override Claude options per target (optional)
[targets.review.claude]
model = "claude-sonnet-4-20250514"
\`\`\`

## Space Reference Formats

Spaces are referenced using the \`space:<id>@<selector>\` format:

| Format | Example | Description |
|--------|---------|-------------|
| Dist-tag | \`space:my-space@stable\` | Uses the version tagged as "stable" |
| Semver exact | \`space:my-space@1.2.3\` | Exact version |
| Semver range | \`space:my-space@^1.0.0\` | Compatible versions (1.x.x) |
| Semver range | \`space:my-space@~1.2.0\` | Patch versions (1.2.x) |
| Git pin | \`space:my-space@git:abc123\` | Exact commit SHA |

## Execution Steps

When you run this command, I will:

1. **Locate or create asp-targets.toml**:
   - Check if file exists in project root
   - Create with basic structure if missing

2. **Understand your needs**:
   - Which target to modify (or create new)
   - Which spaces to add/remove
   - Any Claude options to configure

3. **Update the file**:
   - Add/remove space references
   - Configure Claude options if needed
   - Validate the format

4. **Regenerate lock file**:
   \`\`\`bash
   asp install
   \`\`\`

5. **Show the changes** for review

## Example Workflows

### Adding a space to a target
\`\`\`toml
# Before
[targets.dev]
compose = ["space:frontend-tools@stable"]

# After
[targets.dev]
compose = [
  "space:frontend-tools@stable",
  "space:new-space@stable"
]
\`\`\`

### Creating a new target
\`\`\`toml
[targets.new-target]
description = "Description of this target"
compose = [
  "space:space-a@stable",
  "space:space-b@^1.0.0"
]
\`\`\`

### Removing a space
\`\`\`toml
# Before
[targets.dev]
compose = [
  "space:keep-this@stable",
  "space:remove-this@stable"
]

# After
[targets.dev]
compose = ["space:keep-this@stable"]
\`\`\`

## CLI Shortcuts

You can also use CLI commands:

\`\`\`bash
# Add a space to a target
asp add space:my-space@stable --target dev

# Remove a space from a target
asp remove my-space --target dev

# See what would change
asp diff --target dev
\`\`\`

## After Updating

1. **Install to update lock file**:
   \`\`\`bash
   asp install
   \`\`\`

2. **Verify the resolution**:
   \`\`\`bash
   asp explain dev
   \`\`\`

3. **Run the target**:
   \`\`\`bash
   asp run dev
   \`\`\`

## Best Practices

1. **Use dist-tags for stability**: \`@stable\` is safer than \`@latest\`
2. **Pin critical spaces**: Use exact versions for production
3. **Group related spaces**: Create focused targets (dev, review, deploy)
4. **Document targets**: Use the \`description\` field
5. **Commit asp-targets.toml**: This is your source of truth
6. **Commit asp-lock.json**: This ensures reproducibility

## Troubleshooting

- **Space not found**: Ensure the space is published in your registry
- **Version not found**: Check \`asp repo tags <space-id>\`
- **Lint warnings**: Run \`asp lint\` to see composition issues
`

const SKILL_SPACE_AUTHORING = `# Space Authoring Expert

Expert guidance for creating and maintaining Agent Spaces - reusable, versioned capability modules for Claude Code.

## When to Use

Activate this skill when:
- Creating a new space from scratch
- Adding components (commands, skills, agents, hooks) to a space
- Structuring a space for maintainability
- Publishing and versioning spaces
- Debugging space-related issues
- Understanding space composition and dependencies

## Core Concepts

### What is a Space?

A Space is a versioned, reusable capability module stored in a git-backed registry. It materializes into a Claude Code plugin directory at runtime.

Key properties:
- **Versioned**: Uses semantic versioning via git tags
- **Composable**: Multiple spaces combine into run targets
- **Self-contained**: Each space is an independent plugin

### Space Structure

\`\`\`
spaces/<space-id>/
├── space.toml           # Manifest (required)
├── commands/            # Invokable commands
│   └── <name>.md
├── skills/              # Domain expertise
│   └── <name>/
│       └── SKILL.md
├── agents/              # Autonomous agents
│   └── <name>.md
├── hooks/               # Lifecycle hooks
│   ├── hooks.json
│   └── scripts/
│       └── <script>.sh
└── mcp/                 # MCP server configs
    └── mcp.json
\`\`\`

### space.toml Manifest

Required fields:
\`\`\`toml
schema = 1
id = "my-space"          # Kebab-case identifier
\`\`\`

Optional fields:
\`\`\`toml
version = "1.0.0"        # Semantic version
description = "..."      # What this space does

[plugin]
name = "my-space"        # Override plugin name
version = "1.0.0"        # Override plugin version
description = "..."
license = "MIT"
keywords = ["tool", "dev"]

[plugin.author]
name = "Your Name"
email = "you@example.com"

[deps]
spaces = [               # Dependencies on other spaces
  "space:base-tools@stable"
]
\`\`\`

## Guidelines

### Naming Conventions

1. **Space IDs**: kebab-case, lowercase
   - Good: \`frontend-tools\`, \`code-review\`, \`api-testing\`
   - Bad: \`FrontendTools\`, \`code_review\`, \`API-Testing\`

2. **Commands**: verb-noun or descriptive kebab-case
   - Good: \`run-tests\`, \`create-component\`, \`analyze-code\`
   - Bad: \`tests\`, \`RunTests\`, \`component_creator\`

3. **Skills**: domain-focused kebab-case
   - Good: \`typescript-expert\`, \`react-patterns\`, \`api-design\`

### Component Guidelines

**Commands**:
- One clear purpose per command
- Document parameters and examples
- Use fully-qualified references: \`/plugin:command\`
- Include execution steps

**Skills**:
- Focus on domain expertise
- Include "when to use" triggers
- Provide concrete examples
- Document best practices and gotchas

**Hooks**:
- Always use \`\${CLAUDE_PLUGIN_ROOT}\` for paths
- Keep scripts fast (<5 seconds)
- Handle errors gracefully (exit 0)
- Make scripts executable

### Versioning Strategy

\`\`\`
1.0.0 -> 1.0.1  (patch: bug fixes)
1.0.0 -> 1.1.0  (minor: new features)
1.0.0 -> 2.0.0  (major: breaking changes)
\`\`\`

Breaking changes include:
- Removing commands/skills
- Changing command behavior incompatibly
- Restructuring dependencies

### Publishing Workflow

1. Make changes to space content
2. Bump version: \`/agent-spaces-manager:bump-version\`
3. Commit changes
4. Publish: \`/agent-spaces-manager:publish\`
5. Push to remote (if using shared registry)

## Common Patterns

### Layered Spaces

Base space with core functionality, specialized spaces depend on it:

\`\`\`
base-tools/          # Shared utilities
├── space.toml
└── commands/
    └── common.md

frontend-tools/      # Depends on base
├── space.toml       # deps.spaces = ["space:base-tools@stable"]
└── commands/
    └── build-ui.md
\`\`\`

### Feature Toggles via Composition

Instead of configuring features, compose different spaces:

\`\`\`toml
# asp-targets.toml
[targets.minimal]
compose = ["space:core@stable"]

[targets.full]
compose = [
  "space:core@stable",
  "space:advanced-features@stable"
]
\`\`\`

### Hook-Enhanced Workflows

Add automation via hooks:

\`\`\`json
{
  "hooks": [
    {
      "event": "on_session_start",
      "command": "\${CLAUDE_PLUGIN_ROOT}/hooks/scripts/setup.sh",
      "timeout_ms": 5000
    }
  ]
}
\`\`\`

## Troubleshooting

### Common Issues

1. **Space not found in registry**
   - Verify space ID matches exactly
   - Check the space is committed and tagged
   - Ensure registry is up to date: \`cd ~/.asp/repo && git pull\`

2. **Version resolution fails**
   - Check available tags: \`asp repo tags <space-id>\`
   - Verify selector format is correct
   - Try explicit version instead of range

3. **Hooks not running**
   - Check hooks.json syntax
   - Verify scripts are executable
   - Check for \`\${CLAUDE_PLUGIN_ROOT}\` in paths
   - Look for W203, W204, W206 warnings

4. **Command collisions**
   - Use fully-qualified names: \`/plugin:command\`
   - Rename conflicting commands
   - Consider if spaces should be combined

### Validation Commands

\`\`\`bash
# Lint a space
asp lint ~/.asp/repo/spaces/<space-id>

# Explain resolution
asp explain <target>

# Check plugin structure
asp build <target> --output ./debug-plugins
ls -la ./debug-plugins/<plugin-name>/
\`\`\`

## Best Practices

1. **Single Responsibility**: Each space should have a focused purpose
2. **Document Everything**: Commands, skills, and agents need clear docs
3. **Test Locally First**: Use \`asp run <path>\` before publishing
4. **Version Thoughtfully**: Follow semver conventions
5. **Use Dist-tags**: Promote stable versions explicitly
6. **Minimize Dependencies**: Only depend on what you need
7. **Fully-Qualified References**: Always use \`/plugin:command\` format
`

const AGENT_MANAGER = `# Agent Spaces Manager Agent

Coordinator agent for repository and project space management workflows.

## Role

I am the Agent Spaces Manager - I help you create, publish, and manage spaces in your Agent Spaces registry. I coordinate workflows between the registry (where spaces are authored) and projects (where spaces are composed and used).

## Capabilities

### Registry Workflows

I can help you with registry operations:

1. **Create Spaces**: Scaffold new spaces with proper structure
   - Run \`/agent-spaces-manager:create-space\` to get started

2. **Add Components**: Extend spaces with commands, skills, hooks
   - \`/agent-spaces-manager:add-command\` - Add a new command
   - \`/agent-spaces-manager:add-skill\` - Add a new skill
   - \`/agent-spaces-manager:add-hook\` - Add lifecycle hooks

3. **Version Management**: Bump versions following semver
   - \`/agent-spaces-manager:bump-version\` - Update space version

4. **Publishing**: Release spaces to the registry
   - \`/agent-spaces-manager:publish\` - Create tags and update dist-tags

### Project Workflows

I can help you with project configuration:

1. **Configure Targets**: Set up which spaces to use
   - \`/agent-spaces-manager:update-project-targets\` - Edit asp-targets.toml

2. **Manage Dependencies**: Add/remove spaces from targets
   - \`asp add space:name@stable --target dev\`
   - \`asp remove space-name --target dev\`

3. **Validate Composition**: Check for issues
   - \`asp lint\` - Find warnings
   - \`asp explain <target>\` - See resolution details

## Workflow Patterns

### Creating a New Space

1. "I want to create a new space for X"
2. I'll guide you through:
   - Choosing a space ID
   - Defining the purpose
   - Selecting initial components
   - Creating the structure

### Publishing a Space Update

1. "I want to publish my changes to space X"
2. I'll help you:
   - Review changes
   - Bump the version appropriately
   - Run validation
   - Create the release

### Setting Up a Project

1. "I want to use spaces A, B, C in my project"
2. I'll assist with:
   - Creating asp-targets.toml
   - Configuring targets
   - Running install
   - Verifying the setup

## How I Work

I use the space authoring skill and manager commands to guide you through workflows. When you describe what you want to accomplish, I'll:

1. **Understand your goal**: What are you trying to achieve?
2. **Suggest the approach**: Which commands/workflow to use
3. **Execute steps**: Run the appropriate commands
4. **Verify results**: Confirm everything worked

## Example Interactions

### "I want to create a space for frontend development"

I'll start by running \`/agent-spaces-manager:create-space\` and guide you through:
- Space ID suggestion: \`frontend-tools\`
- Description: What frontend capabilities to include
- Components: Commands for build, test, lint, etc.
- Skills: React patterns, TypeScript guidance, etc.

### "I need to add a code review command to my tools space"

I'll run \`/agent-spaces-manager:add-command\` with:
- Target space: Your tools space
- Command name: \`code-review\`
- Template: Best-practice command structure
- Validation: Ensure it integrates properly

### "How do I publish version 2.0.0 of my space?"

I'll guide you through:
1. \`/agent-spaces-manager:bump-version\` to set version
2. Commit your changes
3. \`/agent-spaces-manager:publish\` to create the release
4. Optional: Push to remote registry

## Context I Need

To help you effectively, tell me:

- **Where you're working**: Registry (\`~/.asp/repo\`) or a project?
- **What you want to accomplish**: Create, modify, publish, configure?
- **Any constraints**: Version requirements, dependencies, team workflows?

## Available Commands

| Command | Purpose |
|---------|---------|
| \`/agent-spaces-manager:help\` | Show all available commands |
| \`/agent-spaces-manager:create-space\` | Create a new space |
| \`/agent-spaces-manager:add-command\` | Add a command to a space |
| \`/agent-spaces-manager:add-skill\` | Add a skill to a space |
| \`/agent-spaces-manager:add-hook\` | Add hooks to a space |
| \`/agent-spaces-manager:bump-version\` | Update space version |
| \`/agent-spaces-manager:publish\` | Publish a space release |
| \`/agent-spaces-manager:update-project-targets\` | Configure project targets |

## Getting Started

If you're new to Agent Spaces, start with:
1. Run \`/agent-spaces-manager:help\` to see available commands
2. Tell me what you want to accomplish
3. I'll guide you through the process

Let's get started - what would you like to do?
`
