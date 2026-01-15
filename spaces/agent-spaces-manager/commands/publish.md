# Publish

Publish a space to the registry by creating a git tag and optionally updating dist-tags.

## Usage

Run this command to publish a new version of a space to the registry.

## Required Information

1. **Space ID**: Which space to publish
2. **Version Tag**: The version to publish (e.g., `v1.0.0`)
3. **Dist-tag** (optional): Channel to update (e.g., `stable`, `latest`, `beta`)

## What Publishing Does

1. **Validates the space** - Runs lint checks
2. **Creates a git tag** - Immutable semver tag: `space/<id>/vX.Y.Z`
3. **Updates dist-tags** (optional) - Modifies `registry/dist-tags.json`
4. **Commits changes** - If dist-tags were updated

## Execution Steps

When you run this command, I will:

1. **Identify the space**:
   - Verify it exists in the registry
   - Read current version from space.toml

2. **Validate the space**:
   ```bash
   asp lint ~/.asp/repo/spaces/<space-id>
   ```
   - Must pass with no errors (warnings are OK)

3. **Create the git tag**:
   ```bash
   cd ~/.asp/repo
   git tag space/<space-id>/v<version>
   ```

4. **Update dist-tags** (if requested):
   - Read `registry/dist-tags.json`
   - Update the specified channel
   - Commit the change

5. **Show summary** of what was published

## Example

Publishing version 1.2.0 as stable:

```bash
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
```

## Dist-Tags Explained

Dist-tags provide named channels for versions:

| Tag | Purpose |
|-----|---------|
| `stable` | Production-ready, thoroughly tested |
| `latest` | Most recent release |
| `beta` | Pre-release for testing |
| `canary` | Cutting-edge, potentially unstable |

Users reference these in `asp-targets.toml`:
```toml
compose = ["space:my-space@stable"]
```

## CLI Equivalent

This command wraps:
```bash
asp repo publish <spaceId> --tag v<version> [--dist-tag <tag>]
```

## Pre-publish Checklist

Before publishing, ensure:

1. **Version is bumped**: Run `/agent-spaces-manager:bump-version` first
2. **Changes are committed**: All space changes should be committed
3. **Lint passes**: No errors in the space
4. **Tested locally**: Try `asp run ~/.asp/repo/spaces/<space-id>`

## After Publishing

1. **Push tags to remote** (if using remote registry):
   ```bash
   cd ~/.asp/repo
   git push origin space/<space-id>/v<version>
   git push origin main  # or your default branch
   ```

2. **Verify in projects**:
   ```bash
   cd /path/to/project
   asp upgrade <space-id>
   asp explain <target>
   ```

## Important Notes

- Git tags are **immutable** - once created, they cannot be changed
- Dist-tag updates are **committed metadata** - they're PR-reviewable
- Publishing does NOT push to remote - do that separately if needed
- Spaces should be validated before publishing
