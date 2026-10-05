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
├── spaces/             # Optional project-local spaces (space:project:<id>)
│   └── my-tools/
│       └── space.toml
└── ...
```

## File Format

```toml
schema = 2

[targets.dev]
description = "Development environment with all tools"
compose = [
  "space:defaults@dev",
  "space:praesidium-defaults",
  "space:project:my-tools"
]

[targets.review]
description = "Code review focused environment"
compose = ["space:defaults@dev"]

# Per-target birth defaults (optional)
[targets.review.provisioning]
harness = "claude"

# Claude options for this target (optional)
[targets.review.provisioning.claude]
model = "sonnet"
permission_mode = "plan"
```

`schema = 2` is the only accepted schema. Use model aliases (`opus`, `sonnet`, `haiku`) rather than pinned model versions.

## Space Reference Formats

| Format | Example | Description |
|--------|---------|-------------|
| Dev | `space:defaults@dev` | The space's current files on disk |
| Bare | `space:defaults` | Same as `@dev` |
| Project-local | `space:project:my-tools` | `<projectRoot>/spaces/my-tools/` |
| Agent-local | `space:agent:muse-meta` | `<agentRoot>/spaces/muse-meta/`; valid in an agent's `agent-profile.toml` `[spaces]` lists, not in `asp-targets.toml` |

Shared spaces resolve from the spaces directory on disk. There is no registry to publish to: `@stable`, dist-tags, semver ranges and `git:` pins were retired; they no longer resolve and `asp install` fails on them.

## Execution Steps

When you run this command, I will:

1. **Locate or create asp-targets.toml**:
   - Check if file exists in project root
   - Create with `schema = 2` and a `[targets.<name>]` table if missing

2. **Understand your needs**:
   - Which target to modify (or create new)
   - Which spaces to add/remove
   - Any provisioning or Claude options to configure

3. **Update the file**:
   - Add/remove space references with `asp add` / `asp remove`
   - Edit `[targets.<name>.provisioning.claude]` for Claude options
   - Validate with `asp lint`

4. **Regenerate lock file**:
   ```bash
   asp install
   ```

5. **Show the changes** for review

## Example Workflows

### Adding a space to a target
```bash
asp add space:praesidium-defaults --target dev
```
```toml
# Before
[targets.dev]
compose = ["space:defaults@dev"]

# After
[targets.dev]
compose = ["space:defaults@dev", "space:praesidium-defaults"]
```

### Creating a new target
```toml
[targets.new-target]
description = "Description of this target"
compose = [
  "space:defaults@dev",
  "space:project:my-tools"
]
```

### Removing a space
```bash
asp remove praesidium-defaults --target dev
```
```toml
# Before
[targets.dev]
compose = ["space:defaults@dev", "space:praesidium-defaults"]

# After
[targets.dev]
compose = ["space:defaults@dev"]
```

## CLI Shortcuts

`--target` is required for `asp add` and `asp remove`. Both run `asp install` afterwards unless you pass `--no-install`.

```bash
# Add a space to a target
asp add space:my-space --target dev

# Remove a space from a target (bare id or the full ref as written)
asp remove my-space --target dev
asp remove space:project:my-tools --target dev

# See what would change
asp diff --target dev
```

## After Updating

1. **Install to update lock file**:
   ```bash
   asp install                 # all targets
   asp install --targets dev   # specific targets
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

1. **Compose live spaces**: write `space:<id>@dev` or bare `space:<id>`
2. **Keep project-specific spaces local**: put them under `spaces/` and reference them as `space:project:<id>`
3. **Group related spaces**: Create focused targets (dev, review, deploy)
4. **Document targets**: Use the `description` field
5. **Commit asp-targets.toml**: This is your source of truth
6. **Commit asp-lock.json**: This ensures reproducibility

## Troubleshooting

- **Space manifest not found**: Check that `spaces/<id>/space.toml` exists in the shared spaces directory (or in the project's `spaces/` for `space:project:<id>`)
- **Not a valid space reference**: Use one of the formats above; `space:agent:<id>` belongs in `agent-profile.toml`
- **Install fails on `@stable`, a semver range or `git:<sha>`**: Those selectors are retired; replace them with `@dev` or drop the selector
- **Lint warnings**: Run `asp lint` to see composition issues
