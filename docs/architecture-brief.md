# agent-spaces: architecture brief

agent-spaces turns declarative agent configuration into a ready-to-launch agent. An agent's
behaviour (its skills, commands, prompts, hooks, MCP servers and system prompt) is authored as
composable *spaces*. agent-spaces resolves which spaces an agent gets and pins them. It then
materializes them into the concrete home directory a particular harness (Claude Code, Codex,
Muse, or the in-house agent-harness) expects, and launches that harness or hands a launch plan
to the runtime that will. It owns *what* an agent is made of and *how* that becomes a harness
home. It does not own *where* or *when* an agent runs; that belongs to HRC.

## Core concepts

- **Space.** A versioned unit of agent capability. A space directory has a `space.toml`
  (schema 1): identity, its dependencies on other spaces, and which harnesses it supports. It
  also holds content folders: `skills/`, `commands/`, `agents/`, `hooks/`, `mcp/`, and an
  `AGENTS.md` prompt fragment. Shared spaces live under `var/agents/spaces/<id>/`. Agents and
  projects can also carry local spaces.
- **Agent home.** `var/agents/<id>/` describes one agent. `agent-profile.toml` (v4) declares
  its base spaces plus per-mode additions and provisioning. `SOUL.md` is the agent's identity
  prompt. `context-template.toml` shapes the runtime context block. The home may also carry
  agent-local `skills/` and `spaces/`.
- **Project target.** A project root's `asp-targets.toml` (schema 2) declares named targets.
  Each target is a composition of spaces plus priming and provisioning. A target composition
  either replaces or merges with the agent profile's composition.
- **Harness.** The agent program that will run the result. The public vocabulary is exactly
  `agent-harness | claude | codex | muse`. Names like `pi`, `pi-sdk` and `codex-cli` are
  internal adapter ids, not user-facing choices.
- **Composition / closure.** The ordered set of spaces an agent receives: roots from the profile
  and target, expanded through each space's dependencies, deps first (a DFS postorder). Space
  references take the forms `space:<id>@<selector>`, `project:`, `agent:` and `path:`. Some
  locality edges are forbidden (for example, a shared space may not depend on a project-local
  one).

## Layers

The code is a Bun monorepo. Dependencies point inward: apps → harness → compiler → drivers →
core → contracts. One exception: the compiler root may not import drivers
(`scripts/lib/import-graph.ts`). `harness/aspc` and the CLI inject the driver plane through
`AgentSpacesClientOptions.runtime`.

- **contracts/**: wire and data contracts shared across the estate. These are the ASPC
  protocol (`aspc-protocol`), the harness-broker protocol and client, agent scope refs, the HRC
  join client and the runtime contracts. They contain no behaviour.
- **core/config**: the spaces pipeline, covering parse, merge, closure, lock and materialize.
  It also owns the ASP_HOME store layout, including lock files, snapshots, the cache and
  composed bundles.
- **core/runtime**: runtime-side helpers. The main one is building the system prompt from the
  context template, `SOUL.md` and priming.
- **drivers/harness-***: one adapter per harness family (`harness-claude`, `harness-codex`,
  `harness-muse`, `harness-pi`, `harness-pi-sdk`). An adapter knows how to detect its harness
  binary. It also knows how to materialize one space into that harness's native layout and how
  to compose the per-space artifacts into one target home.
- **drivers/execution**: running a composed target. `run()` decides whether an install is
  needed, loads the bundle, builds the system prompt and argv/env, and spawns. It also contains
  harness-specific preparation such as `prepareCodexRuntimeHome`.
- **compiler/agent-spaces**: the harness catalog and selection resolver, and
  `compileRuntimePlan`. Selection follows a fixed precedence (request > directive > target >
  profile > catalog default) and yields exactly one recipe, or a typed refusal. The compiler
  turns a selection into an `agent-runtime-plan/v2`: a dispatch request plus the locked
  environment, artifacts and a plan hash.
- **harness/**: long-running processes and facades.
  - `aspc` / `aspc-facade`: the single public compile RPC, `aspc.compileHarnessInvocation`,
    served by the `aspd` daemon on a unix socket.
  - `harness-broker`: the process launcher that HRC talks to. `harness-broker-pi-sdk` is its
    driver for the embedded Pi SDK.
  - `agent-harness` and `agent-harness-runtime`: the in-house Pi-based harness. In the
    foreground it reads space sources directly and needs no materialized bundle.
- **apps/**: the `asp` CLI (`run`, `install`, `build`, `describe`, `explain`, `lint`, `add`,
  `remove`, `upgrade`, `diff`, `agent`, `harnesses`, `doctor`, `gc`), the shared cli-kit and a
  turn runner.

## How a space becomes a running agent

**Resolve and pin.** The inputs are merged: the agent profile (base + mode), the project
target, and any request overrides. The merged roots are expanded into a closure, and every
referenced space is found and validated. The result is written to a lock. The lock records a
sha256 integrity for each space and, per target, the compose list, the load order and an
environment hash. Foreground project runs write `<project>/asp-lock.json`. Compiler and global
runs write `$ASP_HOME/global-lock.json`. Parse errors, missing spaces, dependency cycles,
disallowed locality edges and bad selectors all fail here, before anything is written.

**Materialize.** Each space in the closure is materialized through the harness adapter into
per-space artifacts. Mutable spaces are always re-materialized. Git-pinned spaces go through
immutable `snapshots/<sha256>/` and then a `cache/<key>/` entry, so a cache hit skips the work.
A hygiene gate runs next: skill names must be unique across the composition, and agent-local
plugins load last and win. Then the adapter composes the artifacts into one target bundle,
staged and published atomically. Bundles are content-addressed by fingerprint under
`$ASP_HOME/codex-homes/<project>_<agent>/bundles/.versions/<fp>/<target>/<harness>/`. If a
bundle with that fingerprint is already complete, it is reused as-is. `ASP_HOME` defaults to
`~/.asp`. In the praesidium estate it is `var/spaces-repo`, which is now purely a store, not a
source of spaces. The old git mirror at `$ASP_HOME/sources/spaces-repo` survives only for
git-pinned lock entries.

**What each adapter produces.**
- Claude: numbered plugin directories (`plugins/NNN-<space>/` with `.claude-plugin`), plus
  `settings.json` and `mcp.json`.
- Codex: a template `codex.home/` containing a merged `AGENTS.md`, `config.toml`, `skills/`,
  `prompts/`, `hooks.json` and `mcp.json`.
- Muse: a workspace with `AGENTS.md`, `skills/` and `settings.json`.
- agent-harness (Pi): `extensions/*.js`, skills, hook bridges and settings. It is used for
  install/build only, since the foreground runtime reads sources directly.

**Launch: two entry paths that share the middle.**
- *Foreground*: an operator runs `asp run <target>` in a project or agent directory. The CLI
  works out the run mode (space ref, space directory, project or agent profile), validates the
  harness, resolves selection, installs if needed, builds the system prompt (context template
  + `SOUL.md` + priming), and spawns the harness. The child's exit code becomes asp's. If the
  selected harness is agent-harness, most of the install path is skipped.
- *Managed*: HRC decides placement and allocates runtime and invocation ids. It then calls
  ASPC (`aspc.compileHarnessInvocation`) over the aspd socket. The compiler resolves selection,
  materializes under the global lock, prepares the system prompt and any harness-specific home,
  and returns a plan. HRC then asks the harness-broker to `invocation.start` with that plan.
  The broker builds the child's environment as the disjoint union of ambient env, credentials,
  the plan's locked env and HRC's dispatch env. A key that appears in two channels fails
  dispatch validation rather than silently winning. The broker then spawns the harness
  process.

**Codex specifics.** Codex keeps session state in its home, so the composed template is never
used directly. `prepareCodexRuntimeHome` builds a per-target runtime `CODEX_HOME` at
`$ASP_HOME/codex-homes/<project>_<target>/`. It copies `AGENTS.md`, `config.toml`, hooks and
MCP config, and symlinks skills and prompts to the managed versions. It keeps the
`~/.codex/auth.json` credentials symlink, which the Codex adapter creates at compose time, trusts
the project path and re-trusts hooks. A fingerprint
over template, target, cwd, interactivity, hook events, context and config lets an unchanged
home be reused. The system prompt reaches Codex through a delimited `praesidium-context` block
in `AGENTS.md`, not as a prepended message. Under HRC the process is a headless
`codex app-server` speaking JSON-RPC over stdio, with the Codex TUI optionally attaching over a
unix websocket inside tmux. Codex hooks call back into HRC through `HRC_LAUNCH_HOOK_CLI`.

## Boundaries with neighbouring systems

- **HRC (hrc-runtime)** owns placement, authentication, terminal leases, lifecycle, credentials
  and reattach. It allocates ids but never chooses a harness. It depends on agent-spaces only
  through the ASPC compile RPC and the harness-broker protocol. agent-spaces publishes a
  coherent versioned package set, and HRC's lock is synced to it.
- **Agent sources (`var/agents/`)** are read-only inputs: agent homes and shared spaces.
  agent-spaces never writes to them. Generated homes and bundles are outputs, never edited by
  hand.
- **agent-control-plane** pins agent-spaces and HRC versions as operator-managed producer
  tuples and advances them only in a governed deployment window. agent-spaces installs do not
  move it.

## Invariants worth knowing

- One harness recipe per compile, or a typed refusal. Never a silent default after a failure.
- Locks pin content by hash. The same lock plus the same sources gives the same bundle
  fingerprint.
- Bundle publication is atomic, and a complete fingerprint directory is reused rather than
  rebuilt.
- Environment channels must be disjoint at launch.
- Source inputs are read-only. Every generated home is an output.
