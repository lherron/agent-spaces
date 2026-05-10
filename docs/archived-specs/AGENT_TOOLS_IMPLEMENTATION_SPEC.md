# Agent-Owned Personal Tools — Implementation Spec

Date: 2026-05-08  
Status: Approved for implementation  
Source proposal: `AGENT_TOOLS_PROPOSAL.md` revised direction: agent-local source-path tools on `PATH`, no materialized tools bundle in v1.

## 1. Objective

Add agent-owned executable tools to Agent Spaces as a runtime environment feature.

When an active agent root contains `<agentRoot>/tools/bin`, Agent Spaces must validate that directory, prepend it to the harness runtime `PATH`, and expose stable agent/project state directories through `ASP_AGENT_*` and `ASP_PROJECT_*` environment variables.

This first slice is deliberately small:

- agent-local tools only;
- no space-contributed tools;
- no package-manager install lifecycle;
- no copied or content-addressed tools bundle;
- no changes to harness adapter bundle shapes;
- file-based state under `<agentRoot>/var`.

The goal is for an agent such as `project-minder` to invoke deterministic commands like `project-hygiene` without re-deriving shell snippets from skills on every run.

## 2. Existing repo context

Relevant existing seams:

- `packages/config/src/core/types/agent-local.ts`
  - defines `AgentLocalComponents` for agent-local `skills/` and `commands/`.
- `packages/execution/src/run/agent-profile.ts`
  - exports `detectAgentLocalComponents(agentRoot)`.
- `packages/config/src/orchestration/install.ts`
  - `materializeTarget()` appends agent-local skills/commands as a synthetic plugin artifact.
  - `materializeAgentLocalComponents()` currently ignores tools, which should remain true for v1.
- `packages/config/src/orchestration/materialize-refs.ts`
  - `materializeFromRefs()` threads `agentRoot`, `projectRoot`, and `agentLocalComponents` into resolution/materialization for explicit ref runs.
- `packages/agent-spaces/src/client-materialization.ts`
  - `materializeSpec()` currently passes agent-local context through for `kind: 'spaces'` but not for `kind: 'target'`.
- `packages/execution/src/run.ts`
  - direct `asp run` detects agent-local components and calls `executeHarnessRun()`.
- `packages/execution/src/run/execute.ts`
  - central direct harness process spawn path.
- `packages/agent-spaces/src/client.ts`
  - placement `buildProcessInvocationSpec()` builds CLI env.
  - placement SDK/non-interactive paths apply scoped process env overlays before session execution.
- `packages/hrc-server/src/agent-spaces-adapter/cli-adapter.ts`
  - HRC `launch.pathPrepend` already prepends to `PATH` after Agent Spaces returns its base env.

Do not add tools to `ComposedTargetBundle`, `TargetMaterializationResult`, `MaterializedSpec`, or harness adapter-specific bundle types in v1.

## 3. Directory contract

An agent root may contain:

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
    package.json          # optional; not installed automatically in v1
  var/
    state/
    cache/
    logs/
```

Only `<agentRoot>/tools/bin` is exposed on `PATH`. Do not expose `tools/lib`, `tools/scripts`, `tools/node_modules/.bin`, or arbitrary files under `tools/`.

A root-level `<agentRoot>/bin` is not part of this feature.

`var/` is runtime state, not a discoverable component. An agent that only has `var/` should not produce `AgentLocalComponents`.

## 4. Runtime contract

When an active agent has a real directory at `<agentRoot>/tools/bin`, Agent Spaces must launch the harness with this effective env overlay:

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

`<project-slug-hash>` must use the same slug/hash helper already used for ASP project bundle storage. Export that helper from `spaces-config` rather than duplicating the algorithm.

Before launch, ensure these directories exist:

```text
<agentRoot>/var/state
<agentRoot>/var/cache
<agentRoot>/var/logs
<agentRoot>/var/state/projects/<project-id>   # only when projectRoot is known
```

Tools should write durable project-specific state under `$ASP_PROJECT_STATE_DIR`, for example:

```text
$ASP_PROJECT_STATE_DIR/tools/project-hygiene/last-run.json
$ASP_PROJECT_STATE_DIR/tools/project-hygiene/findings.json
$ASP_AGENT_CACHE_DIR/tools/project-hygiene/gitleaks-version.json
$ASP_AGENT_LOG_DIR/tools/project-hygiene/2026-05-08.log
```

When an agent root is a git repo, the implementation should not modify `.gitignore` automatically, but documentation/tests may assume the user ignores `var/`.

## 5. PATH precedence

For direct Agent Spaces launches, final effective env ordering should be:

1. base project/correlation env such as `ASP_PROJECT` and `AGENTCHAT_ID`;
2. caller/request env overrides;
3. adapter env from `adapter.getRunEnv()`;
4. agent tool env overlay, including `PATH`.

The tool overlay must be last inside Agent Spaces so the active agent's tools are available even if an adapter or request env sets `PATH`.

For HRC launches, Agent Spaces returns the base env containing agent tools. HRC then applies `launch.env`, `launch.unsetEnv`, and `launch.pathPrepend`. Existing HRC behavior should therefore produce:

```text
HRC launch.pathPrepend entries
<agentRoot>/tools/bin
inherited/request PATH
```

No HRC code change should be necessary beyond tests if current `mergeEnv()` behavior remains intact.

## 6. Type and path-helper changes

### 6.1 Extend `AgentLocalComponents`

Update `packages/config/src/core/types/agent-local.ts`:

```ts
export interface AgentLocalComponents {
  /** Absolute path to the agent root directory. */
  agentRoot: string
  /** Basename of agentRoot. */
  agentName: string

  /** Whether <agentRoot>/skills is a directory. */
  hasSkills: boolean
  /** Whether <agentRoot>/commands is a directory. */
  hasCommands: boolean
  /** Whether <agentRoot>/tools/bin is a directory. */
  hasTools: boolean

  /** Absolute path to <agentRoot>/skills. */
  skillsDir: string
  /** Absolute path to <agentRoot>/commands. */
  commandsDir: string
  /** Absolute path to <agentRoot>/tools. */
  toolsDir: string
  /** Absolute path to <agentRoot>/tools/bin. */
  toolsBinDir: string
  /** Absolute path to <agentRoot>/var. */
  agentVarDir: string
}
```

Existing consumers that only need skills/commands should keep working by ignoring the new fields.

### 6.2 Update detection

Update `packages/execution/src/run/agent-profile.ts`:

- Detect directories with `stat().isDirectory()`, not simple existence.
- Check:
  - `<agentRoot>/skills`
  - `<agentRoot>/commands`
  - `<agentRoot>/tools/bin`
- Return `undefined` only when all three are absent.
- Do not return components solely because `<agentRoot>/var` exists.

Expected behavior:

```ts
const components = await detectAgentLocalComponents(agentRoot)
// tools-only agent root returns a defined object with hasTools: true
// var-only agent root returns undefined
```

### 6.3 Export project storage id helper

`packages/config/src/store/paths.ts` currently has an internal `getProjectStorageId(projectPath: string)`. Export it and re-export from:

- `packages/config/src/store/index.ts`
- root `spaces-config` export path through existing `export * from './store/index.js'`

Keep the existing algorithm unchanged:

```text
sanitize basename -> lowercase slug + '-' + first 8 hex chars of sha256(resolve(projectPath))
```

Add/adjust tests in `packages/config/src/store/paths.test.ts` to assert that `getProjectStorageId('/work/My Project')` matches `my-project-[0-9a-f]{8}` and is used by `getProjectDataPath()`.

## 7. Agent tool runtime helper

Add a new runtime helper in:

```text
packages/execution/src/run/agent-tools.ts
```

Export it from `packages/execution/src/run.ts` and `packages/execution/src/index.ts` so `agent-spaces` can import it from `spaces-execution`.

### 7.1 Public helper shape

```ts
import type { AgentLocalComponents } from 'spaces-config'

export interface AgentToolRuntimeContext {
  agentRoot: string
  projectRoot?: string | undefined
  components: AgentLocalComponents
}

export interface AgentToolEnvResult {
  /** Env vars to merge over the current launch env. Includes PATH when tools are enabled. */
  env: Record<string, string>
  /** Paths prepended to PATH. For v1 this is either [] or [toolsBinDir]. */
  pathPrepend: string[]
  /** Non-blocking warnings, e.g. executable text file without shebang. */
  warnings: string[]
}

export async function prepareAgentToolRuntime(
  context: AgentToolRuntimeContext,
  baseEnv?: Record<string, string>
): Promise<AgentToolEnvResult>
```

Also export a validation helper for focused tests:

```ts
export async function validateAgentTools(
  components: AgentLocalComponents
): Promise<string[]>
```

`validateAgentTools()` returns warnings and throws on hard errors.

### 7.2 Helper responsibilities

`prepareAgentToolRuntime()` must:

1. If `context.components.hasTools` is false, return `{ env: {}, pathPrepend: [], warnings: [] }`.
2. Validate `<agentRoot>/tools/bin` using the rules in §8.
3. Ensure state/cache/log directories from §4.
4. Build the env vars from §4.
5. Compute `PATH` by prepending `components.toolsBinDir` to `baseEnv.PATH ?? process.env.PATH ?? ''`.
6. Return warnings from validation.

Use `path.delimiter` instead of a literal `:` when constructing `PATH`, even though the current deployment target is POSIX-like.

Pseudo-code:

```ts
export async function prepareAgentToolRuntime(context, baseEnv = {}) {
  const { components, projectRoot } = context
  if (!components.hasTools) {
    return { env: {}, pathPrepend: [], warnings: [] }
  }

  const warnings = await validateAgentTools(components)

  const agentVarDir = components.agentVarDir
  const stateDir = join(agentVarDir, 'state')
  const cacheDir = join(agentVarDir, 'cache')
  const logDir = join(agentVarDir, 'logs')

  await mkdir(stateDir, { recursive: true })
  await mkdir(cacheDir, { recursive: true })
  await mkdir(logDir, { recursive: true })

  const env: Record<string, string> = {
    ASP_AGENT_ROOT: components.agentRoot,
    ASP_AGENT_NAME: components.agentName,
    ASP_AGENT_TOOLS_DIR: components.toolsDir,
    ASP_AGENT_TOOLS_BIN: components.toolsBinDir,
    ASP_AGENT_VAR_DIR: agentVarDir,
    ASP_AGENT_STATE_DIR: stateDir,
    ASP_AGENT_CACHE_DIR: cacheDir,
    ASP_AGENT_LOG_DIR: logDir,
  }

  if (projectRoot) {
    const projectId = getProjectStorageId(projectRoot)
    const projectStateDir = join(stateDir, 'projects', projectId)
    await mkdir(projectStateDir, { recursive: true })
    env.ASP_PROJECT_ROOT = projectRoot
    env.ASP_PROJECT_ID = projectId
    env.ASP_PROJECT_STATE_DIR = projectStateDir
  }

  const currentPath = baseEnv.PATH ?? process.env.PATH ?? ''
  env.PATH = currentPath
    ? `${components.toolsBinDir}${delimiter}${currentPath}`
    : components.toolsBinDir

  return { env, pathPrepend: [components.toolsBinDir], warnings }
}
```

## 8. Tool validation policy

Validation runs immediately before launch when `hasTools` is true.

### 8.1 Entries

For each direct child of `<agentRoot>/tools/bin`:

- accept a regular executable file;
- accept a symlink only if it resolves under `<agentRoot>/tools` and points to a regular executable file;
- reject directories;
- reject sockets, FIFOs, devices, and other non-file entries;
- reject broken symlinks.

Use `realpath()` for symlink resolution. Compare against the real path of `<agentRoot>/tools`, not the raw string. A resolved path is safe if it is exactly the tools root or starts with `<toolsRootReal><path.sep>`.

### 8.2 Names

Tool names must match:

```text
^[a-z][a-z0-9._-]*$
```

This rejects path separators, whitespace, shell metacharacters, leading dots, empty names, and uppercase names.

### 8.3 Denylist

Hard-error if the tool name is in this v1 denylist:

```text
sh bash zsh env sudo su
node npm npx bun bunx python python3 pip pip3 ruby perl go cargo
claude codex pi hrc hrcchat acp asp wrkq stackctl
agentchat git gh curl wget jq sed awk grep find xargs make just
```

Do not dynamically reject every executable already present on the inherited `PATH` in v1. Dynamic shadowing can become a lint warning later, but it should not block this first slice.

### 8.4 Executable bit

Hard-error if the resolved file is not executable by owner/group/other:

```ts
(stats.mode & 0o111) !== 0
```

Do not `chmod` source files automatically.

### 8.5 Shebang warning

Warn, but do not fail, when an executable text file does not start with `#!`.

To avoid warning on native binaries, inspect a small prefix, e.g. 4096 bytes. If the prefix contains a NUL byte, treat it as binary and do not warn. If it looks textual and does not start with `#!`, emit a warning like:

```text
Agent tool "project-hygiene" is executable text but has no shebang
```

Warnings should be returned from `prepareAgentToolRuntime()` and surfaced through direct-run and placement warning arrays where those already exist.

### 8.6 Suggested error messages

Use stable, grep-friendly messages:

```text
Invalid agent tool name "<name>": expected /^[a-z][a-z0-9._-]*$/
Agent tool "<name>" is reserved and cannot be used
Agent tool "<name>" must be a regular file or safe symlink
Agent tool "<name>" symlink resolves outside <agentRoot>/tools: <resolvedPath>
Agent tool "<name>" must be executable
```

Tests should assert message substrings, not exact full text, to keep implementation flexible.

## 9. Materialization behavior

Tools are not materialized in v1.

Keep `materializeAgentLocalComponents()` limited to `skills/` and `commands/`:

```ts
if (!components || (!components.hasSkills && !components.hasCommands)) {
  return undefined
}
```

A tools-only agent root should still produce `AgentLocalComponents`, but `materializeAgentLocalComponents()` should return `undefined` because there is no prompt/capability artifact to compose.

Fix the existing pass-through gap in `packages/agent-spaces/src/client-materialization.ts` for every branch of `materializeSpec()`:

- `spec.kind === 'target'`;
- `spec.kind === 'spaces' && refs.length === 0`;
- `spec.kind === 'spaces' && refs.length > 0`.

In the target branch, pass `agentRoot`/`agentPath` and `agentLocalComponents` into both resolution and materialization. `resolveSpecToLock()` should accept enough options to pass `agentPath: options.agentRoot` into `resolveTarget()` for target specs. `materializeTarget()` should receive:

```ts
{
  projectPath: spec.targetDir,
  aspHome,
  registryPath,
  harness: harnessId,
  ...(options?.agentRoot ? { agentPath: options.agentRoot } : {}),
  ...(options?.agentLocalComponents ? { agentLocalComponents: options.agentLocalComponents } : {}),
}
```

In both spaces branches, continue passing `agentRoot`, `projectRoot`, and `agentLocalComponents` to `materializeFromRefs()`. This matters even for empty refs because a placement with no composed spaces may still need agent-local skills/commands materialized as the synthetic plugin artifact.

This pass-through fix is required for existing agent-local skills/commands and agent-local spaces in project-target placement paths. It is not a tools materialization feature, but it must be fixed in the same implementation because placement tools depend on the same agent-root detection flow.

Also update direct `asp run` in `packages/execution/src/run.ts`: when it falls through to `configInstall(...)` rather than `materializeFromRefs(...)`, pass `agentPath` and `agentLocalComponents` when an agent profile exists. Current explicit-ref materialization already threads these values.

Agent-local skills and commands are mutable source material. Direct `asp run` should force re-materialization when `agentLocalComponents.hasSkills || agentLocalComponents.hasCommands` is true, even if the lock and output bundle already exist. Tools alone do not require re-materialization because they are read directly from `<agentRoot>/tools/bin`, but they still require validation before every launch.

Suggested `needsInstall` addition:

```ts
const hasMutableAgentPromptMaterial =
  agentLocalComponents?.hasSkills === true || agentLocalComponents?.hasCommands === true

const needsInstall =
  options.refresh ||
  !lockExists ||
  !(await pathExists(harnessOutputPath)) ||
  composeChanged ||
  hasMutableAgentPromptMaterial
```

## 10. Integration points

### 10.1 Direct `asp run`

Files:

- `packages/execution/src/run.ts`
- `packages/execution/src/run/execute.ts`
- new `packages/execution/src/run/agent-tools.ts`

Changes:

1. Compute `agentLocalComponents` as today, now including tools.
2. Pass `agentPath` and `agentLocalComponents` through all install/materialize branches as described in §9.
3. Extend `executeHarnessRun()` options with optional agent tool context:

```ts
agentToolRuntime?: AgentToolRuntimeContext | undefined
```

4. In `executeHarnessRun()`, after constructing the base `harnessEnv`, call `prepareAgentToolRuntime()` when context is present, merge the returned env last, and include warnings in the return value.

Suggested shape:

```ts
export interface ExecuteHarnessResult {
  exitCode: number
  invocation?: RunInvocationResult | undefined
  command: string
  displayCommand: string
  warnings: string[]
  systemPrompt?: string | undefined
  systemPromptMode?: 'replace' | 'append' | undefined
}
```

5. Use the final env for `formatEnvPrefix()` and spawn.
6. In dry-run mode, `command` and `displayCommand` must show the final env prefix, including the tool `PATH`, when tools are enabled.
7. In `run()`, include `execution.warnings` in `build.warnings` by mapping strings to `LintWarning` objects, e.g. `code: 'W401'`, `severity: 'warning'`, `message`.

Call-site example:

```ts
const execution = await executeHarnessRun(adapter, detection, bundle, runOptions, {
  env: options.env,
  dryRun: options.dryRun,
  reminderContent,
  pagePrompts: options.pagePrompts,
  ...(agentProfile && agentLocalComponents?.hasTools
    ? {
        agentToolRuntime: {
          agentRoot: agentProfile.agentRoot,
          projectRoot: options.projectPath,
          components: agentLocalComponents,
        },
      }
    : {}),
})
```

### 10.2 Placement CLI invocation

File:

- `packages/agent-spaces/src/client.ts`, `buildPlacementInvocationSpec()`

Changes:

1. Detect `agentLocalComponents` as already done.
2. Materialize as today, after the `materializeSpec()` target-branch fix.
3. Build the env in the existing order: adapter env, correlation env, agentchat env, request env, `ASP_HOME`.
4. If `agentLocalComponents?.hasTools`, call `prepareAgentToolRuntime()` with:

```ts
{
  agentRoot: placement.agentRoot,
  projectRoot: placement.projectRoot,
  components: agentLocalComponents,
}
```

5. Merge the returned env last.
6. Append returned warnings to the response warnings array.
7. Prefer using the final env in `displayCommand`; at minimum, `spec.env.PATH` must be authoritative and test-covered.

Pseudo-code:

```ts
let env: Record<string, string> = {
  ...adapterEnv,
  ...correlationEnv,
  ...agentchatEnv,
  ...(req.env ?? {}),
  ASP_HOME: aspHome,
}

if (agentLocalComponents?.hasTools) {
  const toolRuntime = await prepareAgentToolRuntime(
    {
      agentRoot: placement.agentRoot,
      projectRoot: placement.projectRoot,
      components: agentLocalComponents,
    },
    env
  )
  env = { ...env, ...toolRuntime.env }
  warnings.push(...toolRuntime.warnings)
}
```

### 10.3 Placement SDK/non-interactive paths

File:

- `packages/agent-spaces/src/client.ts`, `runPlacementTurnNonInteractive()` and any adjacent placement SDK/session path that executes with `applyEnvOverlay()`.

Current code builds `harnessEnv`, applies it to `process.env`, then materializes and creates an SDK session. Update this so the tool env is included in the scoped overlay before session creation and turn execution.

Recommended simple flow:

1. Resolve placement context and cwd.
2. Build correlation/request/`ASP_HOME` env.
3. Detect `placementAgentLocalComponents` before applying the env overlay.
4. If tools are present, call `prepareAgentToolRuntime(..., harnessEnv)` and merge returned env into `harnessEnv`.
5. Apply `applyEnvOverlay(harnessEnv)` once.
6. Materialize, create the session, run the turn, then restore env in `finally`.

This avoids permanent `process.env` mutation while ensuring child processes spawned by SDK-backed sessions inherit the agent tool environment.

### 10.4 Non-placement public client paths

The non-placement `buildProcessInvocationSpec()` path takes an arbitrary `spec` and `cwd` but no `agentRoot`, so it does not enable agent tools. Leave it unchanged unless a caller later passes a placement/agent-root contract.

## 11. Warnings surface

Keep v1 simple:

- Hard validation errors throw before launch/materialization completes.
- Soft validation warnings are returned from `prepareAgentToolRuntime()`.
- Direct `asp run` should expose them through `RunResult.build.warnings` by mapping each string to a `LintWarning`-shaped object, for example `{ code: 'W401', severity: 'warning', message }`. This does not require adding an `asp lint` rule.
- `buildProcessInvocationSpec()` already has an optional string `warnings` field; append tool warning strings there.
- SDK/non-interactive placement paths may emit warnings as event logs only if there is already a convenient log path. Do not create a new event type just for this feature.
- Do not implement `asp lint` rules for tools in this slice.

## 12. Tests

Use Bun tests consistent with the repo.

### 12.1 Detection tests

Update `packages/execution/src/run.test.ts` existing agent-local discovery tests:

- skills-only returns new fields with `hasTools: false`;
- commands-only returns new fields with `hasTools: false`;
- skills+commands returns new fields;
- tools-only agent root returns defined components with `hasTools: true`;
- var-only agent root returns `undefined`;
- `tools/bin` must be a directory, not just a file.

### 12.2 Runtime helper tests

Add `packages/execution/src/run/agent-tools.test.ts`:

- no tools returns empty env/path/warnings;
- valid executable in `tools/bin` prepends `PATH` and sets all `ASP_AGENT_*` vars;
- project root sets `ASP_PROJECT_ROOT`, `ASP_PROJECT_ID`, and `ASP_PROJECT_STATE_DIR`;
- state/cache/log/project-state directories are created;
- invalid names fail;
- denylisted names fail;
- directory inside `tools/bin` fails;
- non-executable file fails;
- symlink to `tools/lib/...` succeeds if target is executable;
- symlink escape outside `<agentRoot>/tools` fails;
- broken symlink fails;
- executable text file without shebang warns;
- binary-like executable without shebang does not warn.

### 12.3 Direct run tests

Update or add tests in `packages/execution/src/run.test.ts`:

- dry-run with agent tools includes `<agentRoot>/tools/bin` at the front of `PATH` in the generated command/env;
- direct run still works when an agent has tools only and no skills/commands;
- direct run `configInstall(...)` branch passes `agentPath` and `agentLocalComponents` when agent profile exists. A source/structural test is acceptable if runtime fixture setup is too expensive.
- direct run treats agent-local skills/commands as mutable and re-materializes when either exists, even if the harness output path already exists.

### 12.4 Placement/materialization pass-through tests

Update `packages/agent-spaces/src/__tests__/phase4-harness-adapter-integration.test.ts` or add a focused client-materialization test:

- `materializeSpec()` target branch passes `agentRoot` as `agentPath` to `resolveTarget()`/`materializeTarget()`;
- `materializeSpec()` target branch passes `agentLocalComponents` to `materializeTarget()`;
- existing spaces branch behavior remains unchanged.

### 12.5 Placement invocation env tests

Add or update `packages/agent-spaces/src/__tests__/placement-correlation-env.test.ts` or a new focused test:

- placement `buildProcessInvocationSpec()` with a tools-only agent returns `spec.env.PATH` beginning with `<agentRoot>/tools/bin`;
- returned env includes `ASP_AGENT_ROOT`, `ASP_AGENT_TOOLS_BIN`, `ASP_AGENT_STATE_DIR`, and project state vars when `placement.projectRoot` is set;
- existing correlation env vars remain present;
- request env `PATH` is preserved after the tools prefix.

### 12.6 HRC PATH precedence test

Existing `mergeEnv()` behavior likely already covers this. Add a focused test only if not already present:

```ts
const finalEnv = mergeEnv(
  { PATH: '/agent/tools/bin:/usr/bin' },
  { pathPrepend: ['/hrc/bin'] }
)
expect(finalEnv.PATH).toBe('/hrc/bin:/agent/tools/bin:/usr/bin')
```

### 12.7 Store path helper tests

Update `packages/config/src/store/paths.test.ts` to cover exported `getProjectStorageId()`.

## 13. Verification commands

Run targeted tests first:

```bash
bun test packages/execution/src/run/agent-tools.test.ts
bun test packages/execution/src/run.test.ts
bun test packages/config/src/store/paths.test.ts
bun test packages/agent-spaces/src/__tests__/placement-correlation-env.test.ts
```

Then run typecheck/build for touched packages:

```bash
bun run --filter spaces-config typecheck
bun run --filter spaces-execution typecheck
bun run --filter agent-spaces typecheck
bun run --filter hrc-server typecheck
```

Finally run the repo’s faster aggregate test target if time permits:

```bash
bun run test:fast
```

## 14. Acceptance criteria

The implementation is complete when all of these are true:

1. An agent root containing only `tools/bin/<tool>` is detected as having agent-local components.
2. A tools-only agent does not create or append a synthetic plugin artifact.
3. Direct `asp run` launches with `<agentRoot>/tools/bin` prepended to `PATH` when the active agent has tools.
4. Placement `buildProcessInvocationSpec()` returns env with tool `PATH` and `ASP_AGENT_*`/`ASP_PROJECT_*` vars when the placement has tools.
5. SDK-backed placement turns run under a scoped env overlay containing the same tool env.
6. HRC `launch.pathPrepend` remains ahead of agent tools in final `PATH`.
7. Invalid names, reserved names, non-files, non-executable files, and symlink escapes hard-fail before launch.
8. Executable text files without shebang produce warnings, not failures.
9. Project state directory IDs match the existing ASP project storage slug/hash algorithm.
10. `materializeSpec()` target, empty-spaces, and non-empty-spaces branches no longer drop agent-local context.
11. Direct `asp run` refreshes mutable agent-local skills/commands instead of reusing stale synthetic plugin material.
12. No harness adapter bundle types or materialization result types were expanded for tools.
13. No package install, MCP state server, SQLite state store, or space-contributed tools were added.

## 15. Deferred work

Do not implement these in this slice:

- copied/materialized tools bundle under target output;
- `tools/manifest.json`;
- space-contributed tools;
- per-tool configuration in `agent-profile.toml`;
- dependency installation or package-manager lifecycle;
- dynamic PATH shadowing policy beyond the static denylist;
- `asp lint` rules for tools;
- automatic `.gitignore` mutation for `var/`.

If launch snapshots or remote execution become concrete requirements, add a harness-neutral sidecar later behind the same `prepareAgentToolRuntime()` contract rather than changing every harness adapter.
