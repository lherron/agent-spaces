# Agent Spaces v2

Compose reproducible Claude Code environments from reusable capability modules.

Agent Spaces lets you define **Spaces** (versioned bundles of commands, skills, agents, and hooks) and compose them into **Run Targets** for your projects. At runtime, `asp run` materializes spaces into Claude Code plugin directories and launches Claude with everything wired up.

## Quick Install

```bash
# Clone and build
git clone <repo-url> agent-spaces-v2
cd agent-spaces-v2
bun install
bun run build

# Add to PATH (or create alias)
export PATH="$PATH:$(pwd)/packages/cli/bin"
```

## Hello World

```bash
# Initialize your registry (creates ~/.asp/repo with manager space)
asp repo init

# Run the manager space to get started
asp run space:agent-spaces-manager@stable
```

The manager space guides you through creating your first space.

## Core Concepts

**Space** — A versioned, reusable capability module stored in a git-backed registry. Contains Claude Code plugin components: commands, skills, agents, hooks, and MCP server configs.

**Run Target** — A named composition profile defined in your project's `asp-targets.toml`. Specifies which spaces to compose for a particular workflow (e.g., `frontend`, `backend`, `architect`).

**Registry** — A git repository containing spaces. Versioning uses git tags (`space/<id>/v1.0.0`) with optional dist-tags (`stable`, `latest`) for channel resolution.

## Project Setup

Create `asp-targets.toml` in your project root:

```toml
schema = 1

[targets.default]
description = "Default development environment"
compose = [
  "space:my-tools@stable",
  "space:project-helpers@^1.0.0"
]
```

Then run:

```bash
asp install    # Resolve and lock dependencies
asp run default # Launch Claude with composed spaces
```

## Commands Overview

| Command | Description |
|---------|-------------|
| `asp run <target>` | Launch Claude with composed spaces |
| `asp install` | Resolve targets and generate lock file |
| `asp build` | Materialize plugins without launching Claude |
| `asp add` / `asp remove` | Modify target composition |
| `asp upgrade` | Update lock to latest matching versions |
| `asp explain` | Show resolution graph and load order |
| `asp lint` | Detect conflicts and issues |
| `asp doctor` | Check system health |
| `asp repo init` | Initialize registry |
| `asp repo publish` | Create version tags |

See [USAGE.md](./USAGE.md) for complete command reference and examples.

## Run Modes

```bash
# Project mode: run a target from asp-targets.toml
asp run frontend

# Global mode: run a space directly (no project needed)
asp run space:my-space@stable

# Dev mode: run a local space directory
asp run ./path/to/my-space
```

## Documentation

- [USAGE.md](./USAGE.md) — Detailed usage guide and command reference
- [specs/AGENT-SPACES-V2-SPEC.md](./specs/AGENT-SPACES-V2-SPEC.md) — Design specification
- [specs/AGENT-SPACES-V2-SCHEMAS.md](./specs/AGENT-SPACES-V2-SCHEMAS.md) — File format schemas

## Requirements

- [Bun](https://bun.sh/) >= 1.0
- [Claude Code](https://claude.ai/code) CLI installed and accessible

## License

MIT
