# Add Command

Add a new command to an existing space with best-practice template.

## Usage

Run this command to add a command to a space. Commands are invokable actions that Claude can execute when the user requests them.

## Required Information

1. **Space ID or Path**: Which space to add the command to
2. **Command Name**: Filename for the command (kebab-case, without .md)
3. **Command Title**: Human-readable title
4. **Command Description**: What the command does

## Command Structure

Commands are stored as markdown files in the `commands/` directory:

```
spaces/<space-id>/
└── commands/
    └── <command-name>.md
```

When loaded, the command is accessible as:
- `/agent-spaces-manager:<command-name>` (fully-qualified)
- `/<command-name>` (if no collision with other plugins)

## Template

The created command will follow this structure:

```markdown
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
```

## Execution Steps

When you run this command, I will:

1. **Identify the target space**:
   - Ask which space to modify
   - Verify the space exists

2. **Get command details**:
   - Command name (kebab-case, e.g., `run-tests`)
   - Command title (e.g., "Run Tests")
   - Description of functionality

3. **Create the commands directory** (if needed):
   ```bash
   mkdir -p ~/.asp/repo/spaces/<space-id>/commands
   ```

4. **Generate <command-name>.md** with best-practice template

5. **Verify** the command file is valid

## Example

Adding a "run-tests" command to a development space:

```markdown
# Run Tests

Execute the project's test suite and report results.

## Usage

Run this command when you want to:
- Verify code changes don't break existing functionality
- Check test coverage
- Debug failing tests

## Parameters

- **Test Pattern** (optional): Glob pattern to filter tests (e.g., `*.unit.test.ts`)
- **Watch Mode** (optional): Whether to run in watch mode

## Execution Steps

1. Detect the test framework (Jest, Vitest, Bun test, etc.)
2. Run the appropriate test command
3. Parse and summarize results
4. Report failures with actionable suggestions

## Example

User: "Run the unit tests for the auth module"

I'll execute:
\`\`\`bash
bun test src/auth/**/*.test.ts
\`\`\`

## Notes

- Ensure dependencies are installed before running tests
- Some tests may require environment variables
- Watch mode is useful during active development
```

## Best Practices for Commands

1. **Clear Purpose**: Each command should do one thing well
2. **Descriptive Names**: Use verb-noun format (e.g., `run-tests`, `create-component`)
3. **Document Parameters**: Be explicit about required vs optional inputs
4. **Show Examples**: Real usage examples help users understand the command
5. **Fully-Qualified References**: Always use `/plugin:command` format when referencing other commands

## Important Notes

- Commands are invoked via `/plugin:command` syntax
- Always use fully-qualified command names in your documentation
- Keep commands focused and composable
