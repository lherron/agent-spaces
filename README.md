# Agent Spaces

Every agent deserves to have its own private space, isolated from all the chaos that is your twelve .claude/.codex/.gemini directories.  This project aims to solve that dilemma.

Compose reproducible Claude Code environments from reusable capability modules.

Agent Spaces lets you define **Spaces** (versioned bundles of commands, skills, agents, and hooks) and compose them into **Run Targets** for your projects. At runtime, `asp run` materializes spaces into Claude Code plugin directories and launches Claude with everything wired up.  It turns off default settings by default (enable with --inherit flags).

The repo is currently split into a config-time layer (`spaces-config`), a harness-agnostic runtime layer (`spaces-runtime`), a run-time execution/orchestration layer (`spaces-execution`), harness-specific adapters, the public `agent-spaces` client API, and the standalone `agent-scope` package for semantic scope/session addressing.

## The v2 Runtime Model

The v2 runtime model separates agent-local state from project-local state:

- **`agentRoot`** (`<agentsRoot>/<agentId>/`) owns reserved runtime files — `SOUL.md` (required), optional `HEARTBEAT.md`, `agent-profile.toml` — plus agent-local `spaces/<id>/`.
- **`projectRoot`** owns `asp-targets.toml` and project-local `spaces/<id>/`.
- **`agentsRoot`** (default `~/praesidium/var/agents`, override via `ASP_AGENTS_ROOT` or `agents-root` in `$ASP_HOME/config.toml`) hosts agent homes and shared spaces under `<agentsRoot>/spaces/`. Projects can additionally declare an `agents-root` key in `asp-targets.toml` to layer project-local agent homes over the canonical root.

Root-relative refs (`agent-root:///`, `agents-root:///`, `project-root:///`) address files inside those roots with escape-safe resolution. Target-based v1 flows still work; new APIs are shaped around explicit roots and frontend-aware runtime placement.

## Quick Install

```bash
# Clone and build
git clone https://github.com/lherron/agent-spaces.git
cd agent-spaces
bun install
bun run build

# Add to PATH (or create alias)
export PATH="$PATH:$(pwd)/packages/cli/bin"
```

## Hello World

```bash
cd your-project
asp init        # creates asp-targets.toml with a dev target composing space:defaults@dev
asp install     # resolve and materialize bundles under ASP_HOME
asp run dev     # launch Claude with the composed spaces
```

You can also run a local space directory directly, no project setup required:

```bash
asp run ./path/to/my-space
```

## Core Concepts

**Space** — A reusable capability module containing Claude Code plugin components: commands, skills, agents, hooks, and MCP server configs. Spaces live in one of three places: shared under `<agentsRoot>/spaces/<id>/`, project-local under `<projectRoot>/spaces/<id>/`, or agent-local under `<agentRoot>/spaces/<id>/`.

**Run Target** — A named composition profile defined in your project's `asp-targets.toml`. Specifies which spaces to compose for a particular workflow (e.g., `frontend`, `backend`, `architect`), plus harness selection, priming prompts, and per-harness overrides.

**Agent** — A durable identity rooted at `<agentsRoot>/<agentId>/`: `SOUL.md`, `agent-profile.toml`, agent-local spaces, and memory. Targets and scopes bind agents to projects at run time.

**Space refs** — `space:<id>@dev` resolves from the shared agents-root spaces; `space:project:<id>` from the project; `space:agent:<id>` from the agent root; `space:path:<path>@dev` from an explicit path. (Git-registry selectors — dist-tags, semver ranges, `git:<sha>` pins — still parse for legacy lockfiles but the git-backed registry workflow is retired.)

## Harnesses

`asp run` supports multiple harnesses via `--harness`:

- `claude` (default): Claude Code CLI
- `codex` (experimental): OpenAI Codex CLI (app-server + exec)
- `pi`: Pi Coding Agent CLI
- `pi-sdk`: Pi SDK runner (Bun) using `@mariozechner/pi-coding-agent`

For `pi-sdk`, pass models as `provider:model` (for example `anthropic:claude-3-5-sonnet-20240620`). Extensions must be dependency-free or depend on packages available to the harness runtime, since dynamic imports happen inside the runner.

## Project Setup

Create `asp-targets.toml` in your project root:

```toml
schema = 1

[targets.default]
description = "Default development environment"
compose = [
  "space:defaults@dev",          # shared space from the agents root
  "space:project:my-helpers",    # project-local space in ./spaces/my-helpers/
]
priming_prompt_append = """
## Project notes for the agent
"""
```

Then run:

```bash
asp install    # Resolve and lock dependencies
asp run default # Launch Claude with composed spaces
```

## Commands Overview

| Command | Description |
|---------|-------------|
| `asp run <target>` | Launch a coding agent with composed spaces |
| `asp agent <scope> <mode>` | Placement-driven agent execution (query/heartbeat/task/maintenance) |
| `asp init` | Create a new `asp-targets.toml` |
| `asp install` | Resolve targets and generate lock file |
| `asp build` | Materialize plugins without launching |
| `asp add` / `asp remove` | Modify target composition |
| `asp upgrade` / `asp diff` | Update lock pins / preview pending lock changes |
| `asp describe` / `asp explain` | Show composed capabilities / resolution graph and load order |
| `asp lint` | Detect conflicts and issues; `--hygiene` runs agent-hygiene lint |
| `asp list` / `asp path` | List targets and spaces / print a space's path |
| `asp doctor` / `asp gc` | Check system health / collect garbage |
| `asp harnesses` | List available harnesses and their status |
| `asp self` | Introspect this agent's runtime launch, prompts, and memory |
| `asp resources plan` | Compile an agent-authored runtime resources plan |
| `asp token-rent` | Price resident system-prompt sections against real run frequency |

See [docs/cli-reference.md](./docs/cli-reference.md) for the full CLI surface.

## Run Modes

```bash
# Project mode: run a target from asp-targets.toml
asp run frontend

# Global mode: run a shared space directly (no project needed)
asp run space:my-space@dev

# Dev mode: run a local space directory
asp run ./path/to/my-space

# Scope mode: placement-driven execution for a known agent
asp agent alice@demo:T-1 task --prompt "triage the failing build"
```

## Documentation

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — Package boundaries, runtime contracts, and current seams
- [docs/cli-reference.md](./docs/cli-reference.md) — `asp` command reference
- [docs/env-contract.md](./docs/env-contract.md) — Environment variable contract
- [docs/proposals/](./docs/proposals/) — Design proposals (agent roots, agent-authored runtime resources, reproducible compiler)
- [spaces/agent-spaces-manager/skills/space-authoring/SKILL.md](./spaces/agent-spaces-manager/skills/space-authoring/SKILL.md) — Space authoring guide

## Package Layout

```text
packages/
├── agent-scope/              # Canonical ScopeRef/ScopeHandle/SessionRef/SessionHandle helpers
├── spaces-runtime-contracts/ # Cross-plane DTO contracts and schema constants
├── cli-kit/                  # Shared Commander helpers and CLI input validators
├── config/                   # spaces-config: config-time determinism, resolution, locks, materialization
├── runtime/                  # spaces-runtime: harness-agnostic session + context-template contracts
├── execution/                # spaces-execution: run-time orchestration and harness dispatch
├── harness-claude/           # Claude CLI + Agent SDK adapters
├── harness-codex/            # Codex CLI/app-server adapter (experimental)
├── harness-pi/               # Pi CLI adapter
├── harness-pi-sdk/           # Pi SDK adapter and session runtime
├── harness-broker-protocol/  # Broker JSON-RPC NDJSON protocol types and schemas
├── harness-broker-client/    # Typed client for the broker protocol
├── harness-broker/           # Broker process: invocation manager, tmux drivers, event sequencing
├── aspc-protocol/            # ASPC compiler JSON-RPC protocol types
├── aspc/                     # ASPC compiler service, client, and broker facade
├── agent-spaces/             # Public host-facing API and event translation layer
└── cli/                      # `asp` command line interface
```

`agent-scope` owns the canonical identity vocabulary:

- `ScopeRef`: canonical address such as `agent:alice:project:demo:task:T-1:role:reviewer`
- `ScopeHandle`: shorthand such as `alice@demo:T-1/reviewer`
- `SessionRef`: `{ scopeRef, laneRef }`
- `SessionHandle`: shorthand such as `alice@demo:T-1/reviewer~planning`

## Requirements

- [Bun](https://bun.sh/) >= 1.0
- [Claude Code](https://claude.ai/code) CLI installed and accessible
- [OpenAI Codex](https://developers.openai.com/codex/cli/) CLI for `--harness codex` runs
- Pi SDK (`@mariozechner/pi-coding-agent`) for `--harness pi-sdk` runs

## License

MIT
