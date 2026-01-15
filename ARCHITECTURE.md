# Architecture

Agent Spaces v2 is a plugin composition system for Claude Code. It resolves versioned "spaces" from a git registry, snapshots them to a content-addressed store, and materializes them into plugin directories.

## System Overview

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐     ┌──────────────┐
│ asp-targets.toml│ ──▶ │   Resolver   │ ──▶ │  asp-lock.json  │ ──▶ │    Store     │
│ (project wants) │     │ (git + tags) │     │ (pinned commits)│     │ (snapshots)  │
└─────────────────┘     └──────────────┘     └─────────────────┘     └──────────────┘
                                                                            │
                                                                            ▼
                        ┌──────────────┐     ┌─────────────────┐     ┌──────────────┐
                        │    Claude    │ ◀── │  Materialized   │ ◀── │ Materializer │
                        │   (invoke)   │     │   Plugins       │     │ (link+json)  │
                        └──────────────┘     └─────────────────┘     └──────────────┘
```

## Package Structure

```
packages/
├── core/         # Types, schemas, config parsing, errors, locks, atomic writes
├── git/          # Git operations (tags, archive, show, exec)
├── claude/       # Claude CLI detection, validation, invocation
├── resolver/     # Resolution engine: refs → commits → closures → locks
├── store/        # Content-addressed snapshot storage, cache management
├── materializer/ # Plugin directory generation (plugin.json, links, hooks)
├── lint/         # Linting rules for spaces and configurations
├── engine/       # Orchestration: install, build, run, explain
└── cli/          # Command-line interface (asp command)
```

### Dependency Graph

```
cli ──▶ engine ──▶ resolver ──▶ git ──▶ core
                 └──▶ store ──────────▶ core
                 └──▶ materializer ──▶ store ──▶ core
                 └──▶ claude ─────────────────▶ core
                 └──▶ lint ───────────────────▶ core
```

## Key Abstractions

### Space Reference (`SpaceRefString`)

Format: `space:<id>@<selector>`

```typescript
// packages/core/src/types/refs.ts
type SpaceRefString = `space:${string}@${string}`

type Selector =
  | { kind: 'dist-tag'; tag: DistTagName }  // stable, latest, beta
  | { kind: 'semver'; range: string }       // ^1.0.0, ~1.2.3, 1.2.3
  | { kind: 'git-pin'; sha: CommitSha }     // git:abc1234
```

### Space Key (`SpaceKey`)

Uniquely identifies a resolved space version: `<id>@<commit>`

```typescript
type SpaceKey = `${string}@${string}`  // e.g., "my-space@abc1234def"
```

### Space Manifest (`space.toml`)

Defines a space in the registry:

```toml
schema = 1
id = "my-space"
version = "1.0.0"
description = "A space for doing things"

[plugin]
name = "my-plugin"   # Optional override

[deps]
spaces = ["space:base@stable"]
```

### Project Manifest (`asp-targets.toml`)

Defines what spaces a project uses:

```toml
[registry]
url = "https://github.com/org/spaces-registry"

[targets.default]
compose = ["space:frontend@stable", "space:backend@^1.0.0"]

[targets.dev]
compose = ["space:frontend@latest", "space:backend@latest"]
```

### Lock File (`asp-lock.json`)

Pins all space versions to exact commits with integrity hashes:

```typescript
// packages/core/src/types/lock.ts
interface LockFile {
  lockfileVersion: 1
  resolverVersion: 1
  generatedAt: string
  registry: LockRegistry
  spaces: Record<SpaceKey, LockSpaceEntry>
  targets: Record<string, LockTargetEntry>
}

interface LockSpaceEntry {
  id: SpaceId
  commit: CommitSha
  path: string                    // "spaces/my-space"
  integrity: Sha256Integrity      // "sha256:..."
  plugin: LockPluginInfo
  deps: LockSpaceDeps
}
```

## Resolution Pipeline

### 1. Parse References

```
space:todo@stable
       │     │
       ▼     ▼
   SpaceId  Selector
```

**File:** `packages/resolver/src/ref-parser.ts`

### 2. Resolve Selector → Commit

```
stable    ──▶ dist-tags.json lookup ──▶ v1.2.3 ──▶ todo/v1.2.3 (tag) ──▶ abc1234
^1.0.0    ──▶ list tags matching ──────────────▶ pick highest ──────▶ abc1234
git:abc   ──▶ direct ───────────────────────────────────────────────▶ abc1234
```

**Files:**
- `packages/resolver/src/selector.ts` - Selector resolution
- `packages/resolver/src/dist-tags.ts` - Dist-tag handling
- `packages/resolver/src/git-tags.ts` - Git tag operations

### 3. Compute Closure

Recursively resolve all dependencies in topological order:

```
todo@abc1234
├── base@def5678
└── utils@789abc
    └── base@def5678  (deduped)

Load order: [base@def5678, utils@789abc, todo@abc1234]
```

**File:** `packages/resolver/src/closure.ts`

### 4. Generate Lock File

Combine all resolutions into a single lock with integrity hashes.

**File:** `packages/resolver/src/lock-generator.ts`

### 5. Snapshot to Store

Extract space directories from git into content-addressed storage:

```
~/.asp-v2/store/snapshots/sha256/<integrity>/
├── commands/
├── skills/
├── hooks/
├── agents/
└── space.toml
```

**File:** `packages/store/src/snapshot.ts`

### 6. Materialize Plugins

Transform snapshots into Claude plugin directories:

```
~/.asp-v2/cache/plugins/<cache-key>/
├── plugin.json         # Generated from space.toml
├── commands/           # Symlinked from snapshot
├── skills/             # Symlinked from snapshot
└── hooks/              # Copied + made executable
```

**File:** `packages/materializer/src/materialize.ts`

## Harness Adapters

Harness adapters translate materialized spaces into runnable bundles. `claude` uses Claude plugin directories, `pi` uses Pi CLI extensions, and `pi-sdk` writes a `bundle.json` manifest under `asp_modules/<target>/pi-sdk` that the Bun-based SDK runner consumes. The `pi-sdk` runner dynamically imports bundled extensions, so extensions must be dependency-free or depend on packages available in the runner environment.

## Storage Layout

```
~/.asp-v2/
├── store/
│   └── snapshots/
│       └── sha256/
│           └── <integrity>/     # Content-addressed space content
├── cache/
│   └── plugins/
│       └── <cache-key>/         # Materialized plugins
└── registry/                    # Cloned registry repo (if local)
```

### Path Resolution

```typescript
// packages/store/src/paths.ts
class PathResolver {
  snapshot(integrity: Sha256Integrity): string
  pluginCache(cacheKey: string): string
}
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `asp run [target]` | Install, build, and run Claude with target |
| `asp install` | Resolve and populate store |
| `asp build` | Materialize plugins from lock |
| `asp explain [target]` | Show resolution details |
| `asp lint` | Validate spaces and configs |
| `asp list` | List spaces in lock |
| `asp doctor` | Check environment health |
| `asp gc` | Garbage collect unused cache |
| `asp add <ref>` | Add space to target |
| `asp remove <id>` | Remove space from target |
| `asp upgrade [ids...]` | Upgrade spaces to latest |
| `asp diff` | Show changes since last install |
| `asp repo tags` | List published versions |
| `asp repo publish` | Publish space version |
| `asp repo status` | Show registry status |

**Entry point:** `packages/cli/src/index.ts`

## Engine Orchestration

The engine package coordinates the full workflow:

```typescript
// packages/engine/src/index.ts

// Resolution
resolveTarget(name, options): ResolveResult
resolveTargets(names, options): ResolveResult[]

// Installation
install(options): InstallResult         // resolve + store + lock
installNeeded(options): boolean         // check if outdated

// Building
build(options): BuildResult             // materialize from lock
buildAll(options): BuildResult[]

// Running
run(options): RunResult                 // build + invoke claude
runInteractive(options): RunResult
runWithPrompt(prompt, options): RunResult
```

## Integrity Model

### Content Integrity

Each space snapshot has a SHA256 hash computed over its directory tree:

```typescript
// packages/resolver/src/integrity.ts
computeIntegrity(spaceId, commit, options): Sha256Integrity
verifyIntegrity(snapshotPath, expected): boolean
```

### Environment Hash

Each target has an `envHash` computed over its load order and all space integrities:

```typescript
computeEnvHash(loadOrder, spaceIntegrities): Sha256Integrity
```

### Cache Key

Materialized plugins use a cache key to avoid re-materialization:

```typescript
// packages/store/src/cache.ts
computePluginCacheKey(integrity, pluginName, version): string
// Formula: sha256("materializer-v1\0" + integrity + "\0" + name + "\0" + version)
```

## Error Handling

All errors extend `AspError` with structured context:

```typescript
// packages/core/src/errors.ts
class AspError extends Error {
  code: string
  cause?: Error
}

// Specific error types:
ConfigParseError      // TOML/JSON parsing failed
ConfigValidationError // Schema validation failed
ResolutionError       // Selector couldn't resolve
MaterializationError  // Plugin generation failed
GitError              // Git operation failed
```

## Linting Rules

| Code | Rule |
|------|------|
| W201 | Command collision |
| W202 | Agent command namespace conflicts |
| W203 | Hook path without plugin root |
| W204 | Invalid hooks configuration |
| W205 | Plugin name collision |
| W206 | Non-executable hook script |
| W207 | Invalid plugin structure |

**File:** `packages/lint/src/rules/`

## JSON Schemas

Validation schemas in `packages/core/src/schemas/`:

- `space.schema.json` - Space manifest
- `targets.schema.json` - Project manifest
- `lock.schema.json` - Lock file
- `dist-tags.schema.json` - Dist-tags file
