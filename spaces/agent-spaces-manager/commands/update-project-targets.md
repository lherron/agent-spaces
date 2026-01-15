# Update Project Targets

Help update a project's `asp-targets.toml` to compose spaces into run targets.

## Usage

Run this command when you need to configure which spaces are used in a project's targets.

## What is asp-targets.toml?

The `asp-targets.toml` file in a project root defines run targets - named compositions of spaces that can be launched with `asp run <target>`.

## File Location

```
project-root/
├── asp-targets.toml    # Defines targets
├── asp-lock.json       # Generated lock file (don't edit manually)
└── ...
```

## File Format

```toml
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
```

## Space Reference Formats

Spaces are referenced using the `space:<id>@<selector>` format:

| Format | Example | Description |
|--------|---------|-------------|
| Dist-tag | `space:my-space@stable` | Uses the version tagged as "stable" |
| Semver exact | `space:my-space@1.2.3` | Exact version |
| Semver range | `space:my-space@^1.0.0` | Compatible versions (1.x.x) |
| Semver range | `space:my-space@~1.2.0` | Patch versions (1.2.x) |
| Git pin | `space:my-space@git:abc123` | Exact commit SHA |

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
   ```bash
   asp install
   ```

5. **Show the changes** for review

## Example Workflows

### Adding a space to a target
```toml
# Before
[targets.dev]
compose = ["space:frontend-tools@stable"]

# After
[targets.dev]
compose = [
  "space:frontend-tools@stable",
  "space:new-space@stable"
]
```

### Creating a new target
```toml
[targets.new-target]
description = "Description of this target"
compose = [
  "space:space-a@stable",
  "space:space-b@^1.0.0"
]
```

### Removing a space
```toml
# Before
[targets.dev]
compose = [
  "space:keep-this@stable",
  "space:remove-this@stable"
]

# After
[targets.dev]
compose = ["space:keep-this@stable"]
```

## CLI Shortcuts

You can also use CLI commands:

```bash
# Add a space to a target
asp add space:my-space@stable --target dev

# Remove a space from a target
asp remove my-space --target dev

# See what would change
asp diff --target dev
```

## After Updating

1. **Install to update lock file**:
   ```bash
   asp install
   ```

2. **Verify the resolution**:
   ```bash
   asp explain dev
   ```

3. **Run the target**:
   ```bash
   asp run dev
   ```

## Best Practices

1. **Use dist-tags for stability**: `@stable` is safer than `@latest`
2. **Pin critical spaces**: Use exact versions for production
3. **Group related spaces**: Create focused targets (dev, review, deploy)
4. **Document targets**: Use the `description` field
5. **Commit asp-targets.toml**: This is your source of truth
6. **Commit asp-lock.json**: This ensures reproducibility

## Troubleshooting

- **Space not found**: Ensure the space is published in your registry
- **Version not found**: Check `asp repo tags <space-id>`
- **Lint warnings**: Run `asp lint` to see composition issues
