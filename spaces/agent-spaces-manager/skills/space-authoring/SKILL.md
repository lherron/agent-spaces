# Space Authoring Expert

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

```
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
```

### space.toml Manifest

Required fields:
```toml
schema = 1
id = "my-space"          # Kebab-case identifier
```

Optional fields:
```toml
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
```

## Guidelines

### Naming Conventions

1. **Space IDs**: kebab-case, lowercase
   - Good: `frontend-tools`, `code-review`, `api-testing`
   - Bad: `FrontendTools`, `code_review`, `API-Testing`

2. **Commands**: verb-noun or descriptive kebab-case
   - Good: `run-tests`, `create-component`, `analyze-code`
   - Bad: `tests`, `RunTests`, `component_creator`

3. **Skills**: domain-focused kebab-case
   - Good: `typescript-expert`, `react-patterns`, `api-design`

### Component Guidelines

**Commands**:
- One clear purpose per command
- Document parameters and examples
- Use fully-qualified references: `/plugin:command`
- Include execution steps

**Skills**:
- Focus on domain expertise
- Include "when to use" triggers
- Provide concrete examples
- Document best practices and gotchas

**Hooks**:
- Always use `${CLAUDE_PLUGIN_ROOT}` for paths
- Keep scripts fast (<5 seconds)
- Handle errors gracefully (exit 0)
- Make scripts executable

### Versioning Strategy

```
1.0.0 -> 1.0.1  (patch: bug fixes)
1.0.0 -> 1.1.0  (minor: new features)
1.0.0 -> 2.0.0  (major: breaking changes)
```

Breaking changes include:
- Removing commands/skills
- Changing command behavior incompatibly
- Restructuring dependencies

### Publishing Workflow

1. Make changes to space content
2. Bump version: `/agent-spaces-manager:bump-version`
3. Commit changes
4. Publish: `/agent-spaces-manager:publish`
5. Push to remote (if using shared registry)

## Common Patterns

### Layered Spaces

Base space with core functionality, specialized spaces depend on it:

```
base-tools/          # Shared utilities
├── space.toml
└── commands/
    └── common.md

frontend-tools/      # Depends on base
├── space.toml       # deps.spaces = ["space:base-tools@stable"]
└── commands/
    └── build-ui.md
```

### Feature Toggles via Composition

Instead of configuring features, compose different spaces:

```toml
# asp-targets.toml
[targets.minimal]
compose = ["space:core@stable"]

[targets.full]
compose = [
  "space:core@stable",
  "space:advanced-features@stable"
]
```

### Hook-Enhanced Workflows

Add automation via hooks:

```json
{
  "hooks": [
    {
      "event": "on_session_start",
      "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/setup.sh",
      "timeout_ms": 5000
    }
  ]
}
```

## Troubleshooting

### Common Issues

1. **Space not found in registry**
   - Verify space ID matches exactly
   - Check the space is committed and tagged
   - Ensure registry is up to date: `cd ~/.asp/repo && git pull`

2. **Version resolution fails**
   - Check available tags: `asp repo tags <space-id>`
   - Verify selector format is correct
   - Try explicit version instead of range

3. **Hooks not running**
   - Check hooks.json syntax
   - Verify scripts are executable
   - Check for `${CLAUDE_PLUGIN_ROOT}` in paths
   - Look for W203, W204, W206 warnings

4. **Command collisions**
   - Use fully-qualified names: `/plugin:command`
   - Rename conflicting commands
   - Consider if spaces should be combined

### Validation Commands

```bash
# Lint a space
asp lint ~/.asp/repo/spaces/<space-id>

# Explain resolution
asp explain <target>

# Check plugin structure
asp build <target> --output ./debug-plugins
ls -la ./debug-plugins/<plugin-name>/
```

## Best Practices

1. **Single Responsibility**: Each space should have a focused purpose
2. **Document Everything**: Commands, skills, and agents need clear docs
3. **Test Locally First**: Use `asp run <path>` before publishing
4. **Version Thoughtfully**: Follow semver conventions
5. **Use Dist-tags**: Promote stable versions explicitly
6. **Minimize Dependencies**: Only depend on what you need
7. **Fully-Qualified References**: Always use `/plugin:command` format
