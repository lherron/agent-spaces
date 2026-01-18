# Project-Defined Spaces: Design Plan

## Overview

This document outlines the design for allowing projects to define their own spaces locally (in a `spaces/` directory) alongside the `asp-targets.toml` manifest, using the same directory structure and materialization process as registry spaces.

## Current State

### Space Reference Types

The system currently supports:

| Format | Example | Description |
|--------|---------|-------------|
| `space:<id>@<selector>` | `space:frontend@stable` | Registry space with dist-tag |
| `space:<id>@<semver>` | `space:frontend@^1.0.0` | Registry space with semver range |
| `space:<id>@git:<sha>` | `space:frontend@git:abc123` | Registry space pinned to commit |
| `space:<id>@dev` | `space:frontend@dev` | Registry space from working directory |
| `space:path:<path>@<selector>` | `space:path:/abs/path@dev` | Path-based ref (partially implemented) |

### Resolution Flow

1. Parse refs from `asp-targets.toml` → targets[].compose
2. Resolve selectors to git commits (or `dev` marker for filesystem)
3. Read manifests and compute dependency closure (DFS postorder)
4. Generate lock file with commits + integrity hashes
5. Snapshot spaces to content-addressed store
6. Materialize plugins to `asp_modules/<target>/<harness>/plugins/`

### Directory Structure (Current)

**Registry (global)**:
```
~/.asp/repo/spaces/           # Registry spaces live here
├── base/
│   ├── space.toml
│   ├── commands/
│   └── skills/
└── frontend/
    └── ...

~/.asp/snapshots/<sha256>/    # Content-addressed snapshots
~/.asp/cache/<key>/           # Materialized plugin cache
```

**Project**:
```
my-project/
├── asp-targets.toml          # Project manifest
├── asp-lock.json             # Lock file (version pins)
└── asp_modules/              # Materialized output
    └── <target>/
        └── claude/
            └── plugins/
```

## Proposed Design

### New Reference Format

Introduce `space:project:<id>` for project-local spaces:

```
space:project:<id>[@<selector>]
```

- `<id>` is the space directory name (kebab-case)
- `<selector>` defaults to `dev` (only `dev` is meaningful for project spaces)
- Explicit `@dev` is optional but allowed for clarity

**Examples**:
```toml
compose = [
  "space:project:my-workflow",       # Project space (implicit @dev)
  "space:project:team-utils@dev",    # Project space (explicit @dev)
  "space:frontend@stable"            # Registry space
]
```

### Directory Structure (Proposed)

```
my-project/
├── asp-targets.toml          # Project manifest
├── asp-lock.json             # Lock file
├── asp_modules/              # Materialized output
└── spaces/                   # NEW: Project-local spaces
    ├── my-workflow/
    │   ├── space.toml        # Same schema as registry spaces
    │   ├── commands/
    │   ├── skills/
    │   ├── hooks/
    │   │   ├── hooks.toml
    │   │   └── my-hook.py
    │   └── CLAUDE.md
    └── team-utils/
        └── ...
```

### Example Usage

**asp-targets.toml**:
```toml
schema = 1

[targets.dev]
description = "Development environment with custom workflows"
compose = [
  "space:project:my-workflow",      # Project-local space
  "space:praesidium-defaults@dev"   # Registry space
]

[targets.team]
description = "Team-specific tooling"
compose = [
  "space:project:team-utils",       # Project-local
  "space:project:my-workflow",      # Project-local (can share)
  "space:base@stable"               # Registry
]
```

**spaces/my-workflow/space.toml**:
```toml
schema = 1
id = "my-workflow"
version = "0.1.0"
description = "Custom workflow for this project"

[plugin]
name = "my-workflow"

[deps]
spaces = [
  "space:base@stable"  # Can depend on registry spaces
]
```

### Resolution Behavior

#### Ref Parsing

Add new pattern `SPACE_PROJECT_REF_PATTERN`:
```typescript
// space:project:<id>[@<selector>]
const SPACE_PROJECT_REF_PATTERN = /^spaces?:project:([a-z0-9]+(?:-[a-z0-9]+)*)(?:@(.+))?$/
```

Parse result includes `projectSpace: true` flag:
```typescript
interface SpaceRef {
  id: SpaceId
  selectorString: string
  selector: Selector
  projectSpace?: boolean  // NEW: true for space:project:<id> refs
}
```

#### Closure Computation

In `closure.ts`, when processing a project space ref:

1. Resolve path as `<projectRoot>/spaces/<id>/`
2. Read manifest from filesystem (like `@dev`)
3. Use `commit: "project"` marker (distinct from registry `@dev`)
4. Compute integrity from directory content
5. Continue with normal dependency resolution

```typescript
if (ref.projectSpace) {
  // Project space - look in project root
  const projectSpacePath = join(projectRoot, 'spaces', ref.id)
  const manifest = await readSpaceManifestFromFilesystem(
    projectSpacePath,
    { cwd: projectRoot }
  )
  resolved = {
    commit: PROJECT_COMMIT_MARKER, // "project"
    selector: { kind: 'dev' },
  }
  key = asSpaceKey(ref.id, PROJECT_COMMIT_MARKER)
}
```

#### Lock File

Project spaces are locked with:
- `commit: "project"` (marker, not a real git SHA)
- `integrity: "sha256:..."` (computed from directory content)
- `path: "spaces/<id>"` (relative to project root)

```json
{
  "spaces": {
    "my-workflow@project": {
      "id": "my-workflow",
      "commit": "project",
      "path": "spaces/my-workflow",
      "integrity": "sha256:abc123...",
      "plugin": { "name": "my-workflow", "version": "0.1.0" },
      "deps": { "spaces": ["base@abc123de"] }
    }
  }
}
```

### Snapshot & Materialization

Two approaches (choose one):

#### Option A: Direct Read (Recommended)

Skip snapshotting for project spaces. During materialization:
1. Read directly from `<projectRoot>/spaces/<id>/`
2. Materialize to plugin cache using content-based cache key
3. Link to `asp_modules/` as normal

**Pros**: Simpler, no duplication, faster for local development
**Cons**: Different code path than registry spaces

#### Option B: Snapshot to Store

Snapshot project spaces like registry spaces:
1. Compute integrity hash from directory
2. Copy to `~/.asp/snapshots/<hash>/` (or use symlink)
3. Materialize from snapshot as normal

**Pros**: Unified code path
**Cons**: Duplication, unnecessary for always-local spaces

### Dependencies

| From | To | Allowed | Notes |
|------|-----|---------|-------|
| Project space | Registry space | ✅ | Common pattern |
| Project space | Project space | ✅ | Same project only |
| Registry space | Project space | ❌ | Registry is standalone |

When a project space depends on another project space:
```toml
# spaces/team-utils/space.toml
[deps]
spaces = [
  "space:project:shared-helpers",  # Another project space
  "space:base@stable"              # Registry space
]
```

### CLI Changes

#### `asp run`

No changes needed - project root already discovered by walking up for `asp-targets.toml`.

#### `asp install`

When resolving refs:
1. Check for `space:project:` prefix
2. Look in `<projectRoot>/spaces/<id>/`
3. Error if directory doesn't exist

#### `asp init`

Optional: add `--with-spaces` flag to create `spaces/` directory template.

#### `asp add` / `asp remove`

Support `space:project:<id>` refs in targets.

### Error Handling

| Condition | Error |
|-----------|-------|
| `space:project:foo` but `spaces/foo/` doesn't exist | `ProjectSpaceNotFoundError` |
| `space:project:foo` but `spaces/foo/space.toml` missing | `ConfigParseError` |
| Project space depends on nonexistent project space | `MissingDependencyError` |
| Circular project space dependencies | `CyclicDependencyError` |

## Implementation Steps

### Phase 1: Core Support

1. **ref-parser.ts**: Add `SPACE_PROJECT_REF_PATTERN` and parse to `SpaceRef` with `projectSpace` flag
2. **refs.ts**: Add type definitions for project space refs
3. **closure.ts**: Handle `projectSpace` refs - read from project root
4. **manifest.ts**: Add `readSpaceManifestFromProject()` helper

### Phase 2: Lock & Snapshot

5. **lock-generator.ts**: Handle `commit: "project"` marker
6. **integrity.ts**: Compute integrity for project spaces
7. **snapshot.ts**: Add `createProjectSnapshot()` or direct read path

### Phase 3: Orchestration

8. **resolve.ts**: Pass `projectRoot` through resolution
9. **install.ts**: Handle project space resolution
10. **build.ts**: Handle project space materialization

### Phase 4: CLI

11. **commands/run.ts**: Ensure project root available
12. **commands/add.ts**: Support adding project space refs
13. **commands/explain.ts**: Show project spaces in tree

### Phase 5: Testing & Docs

14. Add integration tests with fixture project containing `spaces/`
15. Update CLI help text
16. Document in README

## Open Questions

1. **Naming**: Is `space:project:` the best prefix? Alternatives:
   - `space:local:` - but "local" is ambiguous (could mean ~/.asp)
   - `space:./` - but clashes with path refs
   - `project-space:` - different prefix entirely

2. **Versioning**: Should project spaces have optional versioning?
   - Currently: always @dev (filesystem state)
   - Could support: git tags in project repo for project spaces

3. **Sharing**: Should project spaces be shareable across projects?
   - Currently: no, project-local only
   - Could support: path refs for absolute paths

4. **Caching**: Should project spaces use global cache?
   - Currently: yes, same cache as registry spaces
   - Alternative: project-local cache in `asp_modules/.cache/`

## Summary

The `space:project:<id>` reference format provides a clean, explicit way to define project-local spaces while reusing the existing directory structure and materialization process. Project spaces are resolved from `<projectRoot>/spaces/<id>/` and locked with a `"project"` commit marker and content integrity hash.

Key benefits:
- Same `space.toml` schema and directory structure as registry spaces
- Explicit syntax prevents ambiguity with registry spaces
- Project spaces can depend on registry spaces (common pattern)
- Lock file ensures reproducibility within the project
- Unified materialization to `asp_modules/` plugins
