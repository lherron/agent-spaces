# Agent-Owned Personal Tools — Revised Proposal

Date: 2026-05-08  
Status: Approved direction / recreated from revised proposal and implementation spec

## Purpose

Agent Spaces already supports agent-owned instructions and prompt capabilities through an agent root: `SOUL.md`, optional `HEARTBEAT.md`, `agent-profile.toml`, agent-local `spaces/`, `skills/`, and `commands/`.

The missing primitive is agent-owned executable tooling: deterministic commands that belong to one agent, are available only to that agent at harness runtime, and can keep durable state across projects and runs.

The motivating example is `project-minder`. Today it must repeatedly infer shell checks from skill text. A command such as `project-hygiene check . --json` can instead perform deterministic checks for a justfile, hooks, gitleaks, lint/typecheck/test config, README quality, and runtime hygiene, then write durable findings in a predictable agent-owned state directory.

## Recommendation

Add a small v1 feature: when the active agent root contains `<agentRoot>/tools/bin`, validate those entries, prepend that directory to the harness runtime `PATH`, and expose agent/project state directories through `ASP_AGENT_*` and `ASP_PROJECT_*` environment variables.

Keep the first slice deliberately simple:

- Agent-local tools only.
- No space-contributed tools.
- No package-manager install lifecycle.
- No copied or content-addressed tools bundle.
- No harness-specific adapter changes for tool bundle shapes.
- File-based state under `<agentRoot>/var`.

This achieves the goal with minimal surface area. Tools are ordinary source files owned by the agent, available only while that agent is active, and validated immediately before launch.

## Recommended Agent Directory Layout

Use `tools/` for agent-owned source and `tools/bin/` for executable entrypoints.

```text
<agentRoot>/
  SOUL.md
  HEARTBEAT.md
  agent-profile.toml
  skills/                 # existing agent-local prompt/capability material
  commands/               # existing agent-local slash commands
  spaces/                 # existing agent-local spaces
  tools/
    bin/                  # executable entrypoints exposed on PATH
      project-hygiene
      check-deps
    lib/                  # support code, not exposed on PATH
      project-hygiene.ts
    package.json          # optional; not auto-installed in v1
  var/
    state/
    cache/
    logs/
```

Only `<agentRoot>/tools/bin` is exposed on `PATH`. Do not expose `tools/lib`, `tools/scripts`, `tools/node_modules/.bin`, or arbitrary files under `tools/`.

Do not use a bare root-level `<agentRoot>/bin`; `tools/bin` makes ownership and purpose explicit while leaving room for libraries, fixtures, templates, and tests under `tools/`.

## Runtime Contract

When an active agent has a real directory at `<agentRoot>/tools/bin`, launch the harness with this env overlay:

```text
PATH=<agentRoot>/tools/bin:<existing PATH>
ASP_AGENT_ROOT=<agentRoot>
ASP_AGENT_NAME=<basename(agentRoot)>
ASP_AGENT_TOOLS_DIR=<agentRoot>/tools
ASP_AGENT_TOOLS_BIN=<agentRoot>/tools/bin
ASP_AGENT_VAR_DIR=<agentRoot>/var
ASP_AGENT_STATE_DIR=<agentRoot>/var/state
ASP_AGENT_CACHE_DIR=<agentRoot>/var/cache
ASP_AGENT_LOG_DIR=<agentRoot>/var/logs
```

When a project root is known, also set:

```text
ASP_PROJECT_ROOT=<projectRoot>
ASP_PROJECT_ID=<project-slug-hash>
ASP_PROJECT_STATE_DIR=<agentRoot>/var/state/projects/<project-slug-hash>
```

`ASP_PROJECT_ID` should reuse the existing Agent Spaces project storage slug/hash algorithm rather than introducing a second ID scheme.

Before launch, ensure these directories exist:

```text
<agentRoot>/var/state
<agentRoot>/var/cache
<agentRoot>/var/logs
<agentRoot>/var/state/projects/<project-id>   # only when projectRoot is known
```

For `project-minder`, durable files might look like:

```text
$ASP_PROJECT_STATE_DIR/tools/project-hygiene/last-run.json
$ASP_PROJECT_STATE_DIR/tools/project-hygiene/findings.json
$ASP_AGENT_CACHE_DIR/tools/project-hygiene/gitleaks-version.json
$ASP_AGENT_LOG_DIR/tools/project-hygiene/2026-05-08.log
```

## PATH Precedence

Inside Agent Spaces, the tool overlay should be applied last so the active agent’s tools are available even if adapter/request env set `PATH`.

For direct launches, the effective order should be:

1. base project/correlation env;
2. caller/request env overrides;
3. adapter env;
4. agent tool env overlay, including `PATH`.

For HRC launches, Agent Spaces should return env with `<agentRoot>/tools/bin` already prepended. Existing HRC `launch.pathPrepend` then remains the last-mile operational override, giving final order:

```text
HRC launch.pathPrepend entries
<agentRoot>/tools/bin
inherited/request PATH
```

## Detection and Shared Runtime Helper

Extend `AgentLocalComponents` to include tool and state paths:

```ts
export interface AgentLocalComponents {
  agentRoot: string
  agentName: string

  hasSkills: boolean
  hasCommands: boolean
  hasTools: boolean

  skillsDir: string
  commandsDir: string
  toolsDir: string
  toolsBinDir: string
  agentVarDir: string
}
```

`detectAgentLocalComponents(agentRoot)` should detect directories, not simple path existence:

- `<agentRoot>/skills`
- `<agentRoot>/commands`
- `<agentRoot>/tools/bin`

Return components when any of those three exist. Do not return components solely because `<agentRoot>/var` exists.

Add one shared helper for runtime setup, for example `prepareAgentToolRuntime(...)`, that:

- returns no env when `hasTools` is false;
- validates `tools/bin`;
- creates state/cache/log directories;
- computes project state paths when a project root is known;
- prepends `tools/bin` to `PATH` using `path.delimiter`;
- returns soft warnings, such as executable text files without a shebang.

This avoids scattering tool-specific logic across harness adapters.

## Validation Policy

Run validation immediately before launch when `hasTools` is true.

### Entries

Each direct child of `<agentRoot>/tools/bin` must be a regular executable file or a safe symlink to a regular executable file. Reject directories, sockets, FIFOs, devices, broken symlinks, and symlinks that resolve outside `<agentRoot>/tools`.

### Names

Tool names must match:

```text
^[a-z][a-z0-9._-]*$
```

This rejects path separators, whitespace, shell metacharacters, leading dots, empty names, and uppercase names.

### Reserved names

Hard-error on a small reserved set rather than dynamically rejecting every command already present on `PATH`:

```text
sh bash zsh env sudo su
node npm npx bun bunx python python3 pip pip3 ruby perl go cargo
claude codex pi hrc hrcchat acp asp wrkq stackctl
agentchat git gh curl wget jq sed awk grep find xargs make just
```

A broad dynamic shadowing policy is likely noisy in v1. Keep dynamic shadowing as a future lint warning if needed.

### Executability and shebangs

Hard-error when the resolved file is not executable by owner/group/other:

```ts
(stats.mode & 0o111) !== 0
```

Warn, but do not fail, when an executable text file does not start with `#!`. Avoid warning on native binaries by checking a small prefix for NUL bytes.

Do not `chmod` source files automatically.

## Materialization Behavior

Do not materialize tools in v1.

Continue materializing agent-local `skills/` and `commands/` as the existing synthetic plugin-shaped artifact, because those are harness-visible prompt/capability material.

A tools-only agent root should still produce `AgentLocalComponents`, but `materializeAgentLocalComponents()` should return `undefined` because there is no prompt/capability artifact to compose.

Also fix the current agent-local pass-through gap: project-target materialization paths should receive `agentRoot`/`agentPath` and `agentLocalComponents`, not only explicit space-ref paths. This matters for existing agent-local skills, commands, and spaces, and it keeps placement behavior consistent.

Direct `asp run` should re-materialize when mutable agent-local skills or commands exist, even if the lock and harness output already exist. Tools alone do not require re-materialization because they are read directly from `<agentRoot>/tools/bin`, but they must be validated before every launch.

## Integration Points

### Direct `asp run`

Detect agent-local components as today, now including tools. Pass agent-local context through all install/materialization branches. After constructing the base harness env, call the shared tool runtime helper and merge the returned env last. Dry-run output should show the final env prefix, including the tool `PATH`, when tools are enabled.

### Placement CLI invocation

In placement `buildProcessInvocationSpec()`, detect agent-local components, materialize as today, build the usual adapter/correlation/request env, then call the shared tool runtime helper and merge its env last. Return any validation warnings in the existing warning surface.

### SDK-backed/non-interactive placement paths

Build the scoped process env overlay before session creation, include tool env in that overlay, then restore `process.env` in `finally` as today. This ensures SDK sessions and their child processes inherit the active agent’s tools without permanent process env mutation.

### HRC

No major HRC change should be necessary if current env merging preserves `launch.pathPrepend` ahead of returned Agent Spaces `PATH`. Add a focused precedence test if not already covered.

## Project-Minder Example

Current `project-minder` guidance references many hygiene skills:

```text
/validate-agent-md
/validate-agent-spaces
/validate-githooks
/validate-gitignore
/validate-gitleaks
/validate-justfile
/validate-linting
/validate-readme
/validate-runtime
/validate-tests
/validate-typechecking
```

With personal tools, those skills can become interpretation and remediation policy while deterministic checks live in one CLI:

```bash
project-hygiene check . --json
project-hygiene check --cwd . --write-status
project-hygiene explain checks
```

Example output:

```json
{
  "projectRoot": "/Users/lherron/praesidium/agent-spaces",
  "checks": [
    { "id": "justfile.exists", "status": "pass" },
    { "id": "gitleaks.binary", "status": "pass", "version": "8.24.0" },
    { "id": "hooks.pre-commit.gitleaks", "status": "fail", "detail": "missing" }
  ],
  "summary": {
    "passed": 2,
    "failed": 1,
    "skipped": 0
  }
}
```

The agent can then interpret the deterministic result, fix issues when appropriate, and write project-local reporting such as `HYGIENE_STATUS.md`.

## Alternatives Considered

### Materialized tools bundle under target output

A harness-neutral bundle such as `<target-output>/agent-tools/{bin,src,manifest.json}` is attractive for future snapshotting, remote execution, and manifest introspection. It also avoids putting mutable source paths directly on `PATH`.

For v1, it adds unnecessary work: copy/symlink policy, manifest format, bundle result types, and more materialization invalidation logic. Source-path `tools/bin` is simpler and adequate for local agent-owned tools. If launch snapshots or remote execution become concrete requirements, add a sidecar bundle later behind the same runtime-helper contract.

### Space-contributed tools

Spaces could eventually contribute `tools/bin` the same way they contribute skills or commands. That raises contributor manifests, cross-source collision policy, and precedence questions. Defer until agent-local tools prove useful. Shell command shadowing is higher risk than skill/command precedence, so future cross-source collisions should be hard errors unless explicitly configured.

### Package install lifecycle

Do not add `asp agent tools install`, package-manager hooks, or automatic dependency installation in v1. Tools can use system `bun`, `node`, shell, or vendored source. Add dependency lifecycle only once a real tool needs it.

### SQLite, MCP state service, or KV store

File-based state under `<agentRoot>/var` is enough for v1. Structured storage can be implemented by a tool itself or added later as a separate capability.

## Deferred Work

Do not implement these in the first slice:

- copied/materialized tools bundle under target output;
- `tools/manifest.json`;
- space-contributed tools;
- per-tool configuration in `agent-profile.toml`;
- dependency installation or package-manager lifecycle;
- dynamic PATH shadowing policy beyond the static denylist;
- `asp lint` rules for tools;
- automatic `.gitignore` mutation for `var/`.

## Acceptance Criteria

The feature is complete when:

1. A tools-only agent root is detected as having agent-local components.
2. Tools-only agents do not create synthetic plugin artifacts.
3. Direct `asp run` launches with `<agentRoot>/tools/bin` prepended to `PATH`.
4. Placement invocation env includes tool `PATH`, `ASP_AGENT_*`, and project state vars when applicable.
5. SDK-backed placement turns run inside a scoped env overlay containing the same tool env.
6. HRC `launch.pathPrepend` remains ahead of agent tools in final `PATH`.
7. Invalid names, reserved names, non-files, non-executable files, and symlink escapes hard-fail before launch.
8. Executable text files without shebangs warn rather than fail.
9. Project state IDs reuse the existing Agent Spaces project storage slug/hash algorithm.
10. Project-target and space-ref materialization paths no longer drop agent-local context.
11. Direct `asp run` refreshes mutable agent-local skills/commands instead of reusing stale synthetic plugin material.
12. No harness adapter bundle types or materialization result types are expanded for tools.
13. No package install lifecycle, MCP state service, SQLite store, or space-contributed tools are added.

## Summary

Add agent-owned personal tools as reserved `tools/bin` entrypoints in the agent root. Validate them before launch, prepend `tools/bin` to `PATH`, and provide stable file-based state directories under `<agentRoot>/var`.

This keeps the first implementation agent-scoped, deterministic, inspectable, and compatible with the existing Agent Spaces runtime model without introducing new harness bundle shapes, package management, or state services.
