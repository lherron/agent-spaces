# Create Space

Scaffold a new space with the correct directory layout and initial files.

## Usage

Run this command to create a new space in the registry. You will be guided through the process.

## Required Information

1. **Space ID**: A kebab-case identifier (e.g., `my-awesome-space`)
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

```
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
```

## Execution Steps

When you run this command, I will:

1. **Ask for space details**:
   - Space ID (kebab-case identifier)
   - Description
   - Initial version (default: 0.1.0)
   - Which components to include

2. **Create the directory structure**:
   ```bash
   mkdir -p ~/.asp/repo/spaces/<space-id>/{commands,skills,agents,hooks/scripts,mcp}
   ```

3. **Generate space.toml**:
   ```toml
   schema = 1
   id = "<space-id>"
   version = "0.1.0"
   description = "<description>"

   [plugin]
   name = "<space-id>"
   ```

4. **Create initial component files** based on your selections

5. **Verify the structure** using `asp lint`

## Example

To create a space for frontend development tools:

1. Run `/agent-spaces-manager:create-space`
2. Enter ID: `frontend-tools`
3. Enter description: "Frontend development commands and skills"
4. Select components: commands, skills
5. The space will be created at `~/.asp/repo/spaces/frontend-tools/`

## Next Steps After Creation

1. Add content to your commands/skills/agents
2. Test locally: `asp run ~/.asp/repo/spaces/<space-id>`
3. Bump version: `/agent-spaces-manager:bump-version`
4. Publish: `/agent-spaces-manager:publish`

## Important Notes

- Space IDs must be unique within the registry
- The space.toml file is required and must pass validation
- Component directories (commands/, skills/, etc.) are only needed if you have content for them
- Always use `${CLAUDE_PLUGIN_ROOT}` in hook scripts for paths
