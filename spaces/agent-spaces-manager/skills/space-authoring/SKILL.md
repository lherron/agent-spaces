---
name: space-authoring
description: Create, structure, or debug an Agent Space and its components (commands, skills, agents, hooks).
---

# Space Authoring Expert

Expert guidance for creating and maintaining Agent Spaces - reusable capability modules for Claude Code.

## When to Use

Activate this skill when:
- Creating a new space from scratch
- Adding components (commands, skills, agents, hooks) to a space
- Structuring a space for maintainability
- Debugging space-related issues
- Understanding space composition and dependencies

## Core Concepts

### What is a Space?

A Space is a reusable capability module stored as a plain directory. Shared spaces live under the shared spaces root (`<agents-root>/spaces/<id>/`) and compose as `space:<id>@dev`; project and agent spaces live under `<projectRoot>/spaces/` and `<agentRoot>/spaces/`. A space materializes into a Claude Code plugin directory at runtime.

Key properties:
- **Live from disk**: Composition reads the space directory directly; there is no registry, tag or publish step
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
  "space:base-tools@dev"
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

### Making Changes Live

1. Edit the space content in place
2. Validate: `asp lint`
3. Commit the change in the repo that holds the space
4. Reinstall consuming projects (`asp install`) so their locks pick up the new content

Breaking changes (removing commands/skills, changing behavior incompatibly, restructuring dependencies) take effect for every consumer on their next install, so coordinate them.

## Common Patterns

### Layered Spaces

Base space with core functionality, specialized spaces depend on it:

```
base-tools/          # Shared utilities
├── space.toml
└── commands/
    └── common.md

frontend-tools/      # Depends on base
├── space.toml       # deps.spaces = ["space:base-tools@dev"]
└── commands/
    └── build-ui.md
```

### Feature Toggles via Composition

Instead of configuring features, compose different spaces:

```toml
# asp-targets.toml
[targets.minimal]
compose = ["space:core@dev"]

[targets.full]
compose = [
  "space:core@dev",
  "space:advanced-features@dev"
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

1. **Space not found**
   - Verify space ID matches exactly
   - Check the space exists: `asp spaces list` (shared) or `<projectRoot>/spaces/<id>/`
   - Confirm `asp repo status` points at the shared spaces root you expect

2. **Selector resolution fails**
   - Use `@dev` (or no selector for project/agent spaces)
   - `@stable`, dist-tags, semver ranges and `git:` pins are retired and no longer resolve

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
asp lint <agents-root>/spaces/<space-id>

# Explain resolution
asp explain <target>

# Check plugin structure
asp build <target> --output ./debug-plugins
ls -la ./debug-plugins/<plugin-name>/
```

## Best Practices

1. **Single Responsibility**: Each space should have a focused purpose
2. **Document Everything**: Commands, skills, and agents need clear docs
3. **Test Locally First**: Use `asp run <path>` before composing it into targets
4. **Minimize Dependencies**: Only depend on what you need
5. **Fully-Qualified References**: Always use `/plugin:command` format
