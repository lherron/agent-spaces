# Bump Version

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
   ```toml
   # Before
   version = "1.0.0"

   # After (patch bump)
   version = "1.0.1"
   ```

4. **Also update plugin.version** if present:
   ```toml
   [plugin]
   version = "1.0.1"
   ```

5. **Show the changes** for confirmation

## Example

Bumping a patch version:

```
Current version: 1.2.3
Bump type: patch
New version: 1.2.4
```

Setting an explicit prerelease version:

```
Current version: 1.2.4
Explicit version: 2.0.0-beta.1
New version: 2.0.0-beta.1
```

## After Bumping

After updating the version, you typically want to:

1. **Commit the change**:
   ```bash
   cd ~/.asp/repo
   git add spaces/<space-id>/space.toml
   git commit -m "chore(<space-id>): bump version to X.Y.Z"
   ```

2. **Publish the space**:
   Run `/agent-spaces-manager:publish` to create a git tag and optionally update dist-tags

## Best Practices

1. **Bump before publishing**: Always update version before `asp repo publish`
2. **Use meaningful versions**: Don't bump major version for minor changes
3. **Document changes**: Keep a changelog or commit history
4. **Consider dependents**: Major bumps may require updates in dependent spaces
5. **Use prereleases for testing**: `2.0.0-beta.1`, `2.0.0-rc.1`

## Version History

To see version history for a space:
```bash
asp repo tags <space-id>
```

This shows all published versions (git tags like `space/<id>/v1.0.0`).
