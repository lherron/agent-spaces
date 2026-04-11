# `hrc run` — Convenience command for agent session lifecycle

## Problem

`asp run` launches a harness directly — fire-and-forget, no session persistence. HRC manages persistent sessions via tmux, but using it today requires manually orchestrating `session resolve` + `runtime ensure` + `attach`. There is no single command that creates (or reattaches to) a managed agent session.

## Solution

Add `hrc run` — a convenience command that parses an agent-scope handle, builds a `RuntimePlacement` + `HrcRuntimeIntent`, calls `ensureAppSession`, and exec's into the tmux session.

## Target format

Uses the existing `agent-scope` session handle grammar (same as `asp agent`):

```
hrc run <scope> [prompt]
```

| Input | Parsed |
|-------|--------|
| `rex@agent-spaces:T-00123` | agent=rex, project=agent-spaces, task=T-00123, lane=main |
| `rex@agent-spaces:T-00123~repair` | same, lane=repair |
| `rex@agent-spaces` | agent=rex, project=agent-spaces, lane=main |
| `agent:rex:project:agent-spaces:task:T-00123` | canonical ScopeRef form |

The grammar is defined in `packages/agent-scope/src/scope-handle.ts` (shorthand) and `packages/agent-scope/src/session-handle.ts` (with `~lane` suffix). The `asp agent` command in `packages/cli/src/commands/agent/index.ts:159-178` has a `resolveInput()` function that handles all three forms.

## CLI surface

```
hrc run <scope> [prompt]
  --label <text>        Human-readable session label (default: scope handle)
  --force-restart       Force-restart runtime even if session exists
  --no-attach           Print session JSON instead of exec-ing into tmux
```

### Hardcoded defaults (flags deferred to later)

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `appId` | `'hrc-cli'` | Identifies sessions owned by this command |
| `appSessionKey` | `{canonicalScopeRef}/lane:{laneRef}` | Idempotent: same scope = same session |
| `provider` | `'anthropic'` → claude-code | Default harness |
| `model` | `undefined` | Let harness pick |
| `runMode` | `'task'` | Matches `createDefaultRuntimeIntent` in cli.ts |
| `restartStyle` | `'fresh_pty'` | Always clean slate |
| `harness.interactive` | `true` | User is attaching |
| `bundle kind` | `'agent-project'` if agent-profile.toml exists, else `'agent-default'` | Same logic as `asp agent` |

### Flags deferred for later implementation

| Flag | Default when omitted |
|------|---------------------|
| `--project <path>` | `getProjectsRoot() + projectId` from scope handle |
| `--run-mode <mode>` | `'task'` |
| `--provider <p>` | `'anthropic'` |
| `--model <model>` | `undefined` (harness default) |
| `--app <appId>` | `'hrc-cli'` |
| `--key <key>` | Derived from canonical scope + lane |
| `--restart-style <s>` | `'fresh_pty'` |
| `--env <K=V>` | `{}` |
| `--path-prepend <dir>` | `[]` |

## Architecture

`hrc-cli` does NOT call `agent-spaces` or resolve placements itself. It builds an `HrcRuntimeIntent` (containing `RuntimePlacement`) and passes it to `ensureAppSession`. The **server** already handles placement → invocation via `cli-adapter.ts` → `agent-spaces` client.

```
hrc-cli                          hrc-server
  │                                  │
  ├─ parse scope handle              │
  ├─ resolve agentRoot/projectRoot   │
  │   (getAgentsRoot/getProjectsRoot)│
  ├─ build RuntimePlacement          │
  ├─ build HrcRuntimeIntent          │
  │   (with initialPrompt)           │
  ├─ ensureAppSession(intent) ──────►├─ handleEnsureAppSession
  │                                  │    ├─ thread initialPrompt into runtimeIntent
  │                                  │    ├─ ensureRuntimeForSession
  │                                  │    │    └─ buildCliInvocation(intent)
  │                                  │    │         ├─ pass intent.initialPrompt as req.prompt
  │                                  │    │         └─ agent-spaces client
  │                                  │    │              └─ buildPlacementInvocationSpec
  │                                  │    │              └─ prompt → runOptions → adapter.buildRunArgs → argv
  │                                  │    │              └─ system prompt from SOUL.md (priming prompt)
  │                                  │    └─ launch via tmux.sendKeys(launchCommand)
  │◄── session + runtime ───────────┤
  ├─ attachAppSession() ────────────►├─ tmux attach descriptor
  └─ exec(tmux attach)              │
```

### Initial prompt sequencing

The initial prompt must arrive **after** the priming/system prompt. The existing pipeline handles this correctly:

1. `BuildProcessInvocationSpecRequest.prompt` (line 154 of `packages/agent-spaces/src/types.ts`)
2. → `buildPlacementInvocationSpec()` at `packages/agent-spaces/src/client.ts:1567` merges: `req.prompt ?? defaultRunOptions.prompt ?? effectiveConfig?.priming_prompt`
3. → `adapter.buildRunArgs(bundle, runOptions)` puts it into harness argv as `--prompt "..."`
4. The harness (claude-code) loads its system prompt first, then processes `--prompt` as the first user turn

**The gap today**: `buildCliInvocation` in `packages/hrc-server/src/agent-spaces-adapter/cli-adapter.ts:193-204` does NOT pass `prompt` to the `BuildProcessInvocationSpecRequest`. It needs to be threaded through.

## Changes required

### Change 1: `hrc-core` — add `initialPrompt` to types

**File:** `packages/hrc-core/src/contracts.ts` (line 49)

```typescript
export type HrcRuntimeIntent = {
  placement: RuntimePlacement
  harness: HrcHarnessIntent
  execution?: HrcExecutionIntent | undefined
  launch?: HrcLaunchEnvConfig | undefined
  initialPrompt?: string | undefined  // ← ADD
}
```

**File:** `packages/hrc-core/src/http-contracts.ts` (line 211)

```typescript
export type EnsureAppSessionRequest = {
  selector: HrcAppSessionRef
  spec: HrcAppSessionSpec
  label?: string | undefined
  metadata?: Record<string, unknown> | undefined
  restartStyle?: RestartStyle | undefined
  forceRestart?: boolean | undefined
  initialPrompt?: string | undefined  // ← ADD
}
```

### Change 2: `hrc-server` — thread `initialPrompt` through

**File:** `packages/hrc-server/src/agent-spaces-adapter/cli-adapter.ts` (line 193)

Pass `intent.initialPrompt` as `prompt` in the spec request:
```typescript
const placementReq: BuildProcessInvocationSpecRequest = {
  placement: intent.placement,
  provider: intent.harness.provider,
  frontend,
  model: intent.harness.model,
  interactionMode: 'interactive',
  ioMode: 'pty',
  prompt: intent.initialPrompt,  // ← ADD
  aspHome: '',
  spec: { spaces: [] },
  cwd: '/',
}
```

**File:** `packages/hrc-server/src/index.ts` (in `handleEnsureAppSession`, around line 603)

When `body.initialPrompt` is set and `spec.kind === 'harness'`, merge it into `spec.runtimeIntent.initialPrompt` before passing to `ensureRuntimeForSession`.

### Change 3: `hrc-cli` — add `cmdRun` command

**File:** `packages/hrc-cli/package.json`

Add dependencies:
```json
"agent-scope": "*",
"spaces-config": "*"
```

**File:** `packages/hrc-cli/src/cli.ts`

Add `cmdRun()` handler (~80 lines). Key steps:

1. **Parse scope** — inline `resolveInput()` pattern from `packages/cli/src/commands/agent/index.ts:159-178`:
   - If input contains `~` → `parseSessionHandle(input)` → extract scopeRef + laneRef
   - Else try `validateScopeHandle(input)` → `parseScopeHandle` → `formatScopeRef`
   - Else try `validateScopeRef(input)` → use as-is
   - All from `agent-scope` package

2. **Resolve roots** — `getAgentsRoot()` and `getProjectsRoot()` from `spaces-config`:
   - `agentRoot = join(agentsRoot, parsed.agentId)`
   - `projectRoot = join(projectsRoot, parsed.projectId)` (if projectId present)

3. **Build bundle ref** — inline `buildBundleRef()` logic from `packages/cli/src/commands/agent/shared.ts:24-53`:
   - Check `existsSync(join(agentRoot, 'agent-profile.toml'))`
   - If exists → `{ kind: 'agent-project', agentName: parsed.agentId, projectRoot }`
   - Else → `{ kind: 'agent-default' }`

4. **Assemble placement**:
   ```typescript
   const placement: RuntimePlacement = {
     agentRoot,
     projectRoot,
     cwd: projectRoot,
     runMode: 'task',
     bundle,
     correlation: {
       sessionRef: { scopeRef: canonicalScopeRef, laneRef: typedLaneRef },
     },
   }
   ```

5. **Build intent + ensure session**:
   ```typescript
   const intent: HrcRuntimeIntent = {
     placement,
     harness: { provider: 'anthropic', interactive: true },
     execution: { preferredMode: 'interactive' },
     initialPrompt: prompt,  // from positional arg
   }
   const result = await client.ensureAppSession({
     selector: { appId: 'hrc-cli', appSessionKey },
     spec: { kind: 'harness', runtimeIntent: intent },
     label: label ?? scopeInput,
     restartStyle: 'fresh_pty',
     forceRestart,
     initialPrompt: prompt,
   })
   ```

6. **Attach or print**:
   - `--no-attach` → `printJson(result)`
   - Otherwise → `client.attachAppSession({ appId: 'hrc-cli', appSessionKey })` → bind Ghostty surface if `GHOSTTY_SURFACE_UUID` is set → `Bun.spawnSync(descriptor.argv, { stdio: 'inherit' })`

7. **Wire into main dispatch** and **update `printUsage()`**

## Key reference files

| File | Role |
|------|------|
| `packages/hrc-cli/src/cli.ts` | HRC CLI entry point — add `cmdRun` here |
| `packages/hrc-core/src/contracts.ts:49` | `HrcRuntimeIntent` type — add `initialPrompt` |
| `packages/hrc-core/src/http-contracts.ts:211` | `EnsureAppSessionRequest` — add `initialPrompt` |
| `packages/hrc-server/src/agent-spaces-adapter/cli-adapter.ts:183` | `buildCliInvocation` — thread `initialPrompt` as `prompt` |
| `packages/hrc-server/src/index.ts:603` | `handleEnsureAppSession` — thread `initialPrompt` into intent |
| `packages/cli/src/commands/agent/index.ts:159-178` | `resolveInput()` — pattern to inline |
| `packages/cli/src/commands/agent/shared.ts:24-53` | `buildBundleRef()` — pattern to inline |
| `packages/agent-scope/src/scope-handle.ts` | Scope handle parsing |
| `packages/agent-scope/src/session-handle.ts` | Session handle parsing (with `~lane`) |
| `packages/config/src/store/asp-config.ts:17,28` | `getAgentsRoot()`, `getProjectsRoot()` |
| `packages/config/src/core/types/placement.ts:36` | `RuntimePlacement` type |
| `packages/agent-spaces/src/client.ts:1567` | Where `req.prompt` flows into `runOptions` |
| `packages/agent-spaces/src/types.ts:138-159` | `BuildProcessInvocationSpecRequest` — already has `prompt` field |

## Existing patterns to follow

- **CLI command pattern**: `cmdAppSessionEnsure` in `cli.ts:950` — uses `parseFlag`, `hasFlag`, `requireArg`, `createClient`, `printJson`
- **Attach pattern**: `cmdAttach` in `cli.ts:539` — gets descriptor, binds Ghostty surface, prints JSON (we extend this to exec)
- **No existing code exec's into tmux** — `hrc run` will be the first command to do `Bun.spawnSync(descriptor.argv, { stdio: 'inherit' })` instead of just printing JSON

## Verification plan

1. **Unit test**: mock `HrcClient`, verify `rex@agent-spaces:T-00123` → `EnsureAppSessionRequest` with correct `appSessionKey`, `RuntimePlacement`, `initialPrompt`
2. **E2E**: `hrc run rex@agent-spaces:T-00123 --no-attach` → session JSON with `status: 'created'`
3. **Prompt E2E**: `hrc run rex@agent-spaces:T-00123 "Fix the bug" --no-attach` → verify `initialPrompt` in response
4. **Manual**: `hrc run rex@agent-spaces:T-00123` → drops into tmux-attached claude-code with system prompt loaded
5. **Reattach**: run same command again → reattaches to existing session (not create new)
6. **Force restart**: `hrc run rex@agent-spaces:T-00123 --force-restart` → new session
