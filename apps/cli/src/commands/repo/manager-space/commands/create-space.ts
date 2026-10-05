import type { SpaceFile } from '../../manager-space-content'

export const CREATE_SPACE_COMMAND: SpaceFile = {
  path: 'commands/create-space.md',
  content: `# Create Space

Scaffold a new space with the correct directory layout and initial files.

## Usage

Run this command to route space creation through the deterministic scaffold generator, then add any real components afterward.

## Required Information

1. **Space ID**: A kebab-case identifier (e.g., \`my-awesome-space\`)
   - Must be lowercase letters, numbers, and hyphens only
   - Must start with a letter
   - Maximum 64 characters

2. **Description**: Brief description of what this space does

3. **Initial Components** (optional, added after scaffold):
   - Commands to include
   - Skills to include
   - Hooks to include (if needed)

## Directory Structure

The created space will have this structure:

\`\`\`
spaces/<space-id>/
├── space.toml          # Space manifest (required)
├── commands/           # Command definitions (optional)
├── skills/             # Skill definitions (optional)
├── agents/             # Agent definitions (optional)
├── hooks/              # Hook configurations (optional)
│   └── scripts/
└── mcp/                # MCP server configs (optional)
\`\`\`

## Execution Steps

When you run this command, I will:

1. **Ask for space details**:
   - Space ID (kebab-case identifier)
   - Description
   - Initial version for the manifest (default: 0.1.0)
   - Which components to include

2. **Run the deterministic scaffold command**:
   \`\`\`bash
   asp repo new-space <space-id> --description "<description>" --version 0.1.0
   \`\`\`

3. **Create initial component files** based on your selections

4. **Verify the generated manifest** with the scaffold command's built-in validation gate before adding content

## Example

To create a space for frontend development tools:

1. Run \`/agent-spaces-manager:create-space\`
2. Enter ID: \`frontend-tools\`
3. Enter description: "Frontend development commands and skills"
4. Select components: commands, skills
5. I will run \`asp repo new-space frontend-tools --description "Frontend development commands and skills"\`
6. The space will be created at \`<agents-root>/spaces/frontend-tools/\` (see \`asp repo status\` for the resolved root)

## Next Steps After Creation

1. Add content to your commands/skills/agents
2. Validate: \`asp lint\`
3. Test locally: \`asp run <agents-root>/spaces/<space-id>\`
4. Compose it into a target: \`asp add space:<space-id>@dev --target <name>\`

## Important Notes

- Space IDs must be unique within the shared spaces root
- The space.toml file is required and must pass validation
- Component directories (commands/, skills/, etc.) are only needed if you have content for them
- Always use \`\${CLAUDE_PLUGIN_ROOT}\` in hook scripts for paths
`,
}
