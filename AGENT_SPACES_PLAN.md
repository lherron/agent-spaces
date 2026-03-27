# agent-spaces implementation plan for host-generic runtime execution and agent-scope

## Status

This document is the implementation plan for evolving the current `agent-spaces` monorepo into:

- a host-generic upstream `agent-spaces` package,
- a new standalone `agent-scope` package,
- a standalone CLI surface that can execute one agent directly,
- and a library/API surface that any host can call without importing host-specific semantics into `agent-spaces`.

Implementers should be able to work from this file alone. It includes the required upstream ownership boundary, target contracts, migration guidance, package-level work, CLI expectations, milestones, and success criteria.

## Why this work exists

The current `agent-spaces` repo already has useful pieces:

- multi-harness materialization,
- provider-typed continuation refs,
- `buildProcessInvocationSpec(...)`,
- project-local spaces via `space:project:<id>`,
- Codex, Claude, Pi, and SDK harness adapters.

But the current public model is still too host-specific and too target-centric:

- the client uses the legacy `cpSessionId` field name,
- requests are centered on `SpaceSpec` and `asp-targets.toml`,
- there is no upstream `RuntimePlacement`,
- there is no upstream runtime-facing `agentRoot` contract,
- there is no upstream `agent-scope` package,
- there is no `space:agent:<id>`,
- reserved files like `SOUL.md` and `HEARTBEAT.md` are not yet normative upstream behavior,
- root-relative refs like `agent-root:///...` and `project-root:///...` are not implemented,
- path safety is incomplete for local-space and root-relative resolution,
- and session-like abstractions are still visible in runtime/execution internals.

The goal is not to throw away the current repo. The goal is to keep the useful resolver/materializer/harness work and change the top-level model so multiple hosts can use it cleanly.

## Non-goals

`agent-spaces` must not absorb host workflow or orchestration semantics.

It must not own:

- durable host session mappings such as `SessionRef -> concrete session id` continuity,
- tmux, ghostty, PTY hosting strategy, or other terminal orchestration,
- bindings or routing,
- heartbeat scheduling or delivery policy,
- task/workflow lifecycle semantics,
- adaptive memory policy or recall auditing,
- cross-agent routing or coordination,
- gateway delivery semantics,
- host-specific agent-id-based aliases such as `agent-home://<agentId>/...`.

## Target ownership boundary

### `agent-scope` owns

- `ScopeRef`
- `LaneRef`
- `SessionRef`
- parse / format / validate helpers
- canonical ancestor derivation

### `agent-spaces` owns

- the runtime-facing filesystem/layout contract under one `agentRoot`
- `agent-profile.toml`
- implicit reserved-file behavior for `SOUL.md` and optional `HEARTBEAT.md`
- local `space:agent:<id>` and `space:project:<id>` resolution
- explicit bundle selection from a host-supplied `RuntimePlacement`
- mode-aware materialization for one agent
- non-interactive SDK execution
- CLI invocation preparation for host-managed or CLI-managed process execution
- provider-typed continuation refs
- root-relative refs `agent-root:///...` and `project-root:///...`
- path normalization and containment checks for files/spaces it resolves itself
- resolved bundle audit metadata

### The host owns

The host may be a server, daemon, CLI, or any other runtime that wants to execute one agent.

The host owns:

- choosing the absolute `agentRoot`
- choosing the absolute `projectRoot` when applicable
- mapping any host-specific semantics into a concrete `RuntimePlacement`
- deciding whether `SessionRef` correlation exists at all
- process hosting, supervision, replay, and cancellation for CLI harnesses
- any higher-level run orchestration

## Deliverables

This workstream must ship all of the following:

1. A new `agent-scope` package that implements the standalone semantic-address contract.
2. A revised `agent-spaces` library API built around `RuntimePlacement`.
3. A revised internal resolution/materialization pipeline that supports:
   - reserved runtime files,
   - `agent-profile.toml`,
   - `space:agent:<id>`,
   - `space:project:<id>`,
   - root-relative refs,
   - mode-aware overlays,
   - resolved bundle audit output.
4. A standalone `asp` CLI surface for:
   - default `ScopeRef`-selected agent execution,
   - mode-as-verb agent execution such as `query`, `task`, `heartbeat`, and `maintenance`,
   - agent-specific resolve/inspect,
   - dry-run / invocation printing.
5. Compatibility wrappers only where necessary to keep the migration incremental.

## Implementation strategy

### Recommended repo strategy

Implement `agent-scope` as a new package inside the existing Bun workspace first:

- `packages/agent-scope`

It must behave as if it were already standalone:

- no dependency on any host-specific package,
- no dependency on `spaces-config`, `spaces-runtime`, or `spaces-execution`,
- its tests must exercise only its own contract.

After the package is stable, it can be extracted to its own repo without behavior changes.

### Recommended package responsibilities in the current monorepo

- `packages/agent-scope`
  - new semantic-address package
- `packages/config`
  - deterministic runtime profile parsing
  - local-space resolution
  - bundle selection
  - root-relative ref resolution
  - path safety
  - resolved bundle audit metadata
- `packages/runtime`
  - keep only harness-facing runtime primitives that are still needed internally
  - stop treating “session registry” as part of the upstream conceptual model
- `packages/execution`
  - harness registry
  - SDK turn execution adapters
  - invocation helpers for CLI frontends
- `packages/agent-spaces`
  - thin public client surface over placement resolution + harness execution/invocation
- `packages/cli`
  - standalone host UX using the new placement API

## Required upstream contracts

### 1. `agent-scope` contract

#### Purpose

`agent-scope` is the canonical upstream package for semantic agent session addressing.

It must remain:

- transport-agnostic,
- host-agnostic,
- cheap to parse,
- and small enough to embed everywhere.

#### Canonical token grammar

All identifier tokens use:

- regex: `[A-Za-z0-9._-]+`
- length: `1..64`

This applies to:

- `agentId`
- `projectId`
- `taskId`
- `roleName`
- `laneId`

#### Canonical `ScopeRef` forms

Valid:

- `agent:<agentId>`
- `agent:<agentId>:project:<projectId>`
- `agent:<agentId>:project:<projectId>:role:<roleName>`
- `agent:<agentId>:project:<projectId>:task:<taskId>`
- `agent:<agentId>:project:<projectId>:task:<taskId>:role:<roleName>`

Invalid:

- `project:<projectId>`
- any transport-derived channel/thread/conversation/message ids
- any embedded `sessionId`
- task or role segments without an explicit project segment

#### Canonical `LaneRef` forms

Valid:

- `main`
- `lane:<laneId>`

Rules:

- omitted lane normalizes to `main`
- lane meaning is continuity only

#### Required `agent-scope` APIs

```ts
type ScopeKind =
  | 'agent'
  | 'project'
  | 'project-role'
  | 'project-task'
  | 'project-task-role'

type ParsedScopeRef = {
  kind: ScopeKind
  agentId: string
  projectId?: string
  taskId?: string
  roleName?: string
  scopeRef: string
}

type LaneRef = 'main' | `lane:${string}`

type SessionRef = {
  scopeRef: string
  laneRef: LaneRef
}

parseScopeRef(scopeRef: string): ParsedScopeRef
formatScopeRef(parsed: ParsedScopeRef): string
validateScopeRef(scopeRef: string): { ok: true } | { ok: false; error: string }
normalizeLaneRef(laneRef?: string): LaneRef
validateLaneRef(laneRef: string): { ok: true } | { ok: false; error: string }
normalizeSessionRef(input: { scopeRef: string; laneRef?: string }): SessionRef
ancestorScopeRefs(scopeRef: string): string[]
```

#### `ancestorScopeRefs(...)` behavior

Must return least-specific to most-specific ancestry.

Examples:

- `agent:alice`
  - `["agent:alice"]`
- `agent:alice:project:demo`
  - `["agent:alice", "agent:alice:project:demo"]`
- `agent:alice:project:demo:task:t1:role:tester`
  - `["agent:alice", "agent:alice:project:demo", "agent:alice:project:demo:task:t1", "agent:alice:project:demo:task:t1:role:tester"]`

### 2. `agent-spaces` placement contract

#### Core types

```ts
type RunMode = 'query' | 'heartbeat' | 'task' | 'maintenance'

type RunScaffoldPacket = {
  slot: string
  content?: string
  ref?: string
  contentType?: 'markdown' | 'json' | 'text'
  version?: string
}

type RuntimeBundleRef =
  | { kind: 'agent-default' }
  | { kind: 'agent-target'; target: string }
  | { kind: 'project-target'; projectRoot: string; target: string }
  | { kind: 'compose'; compose: SpaceRefString[] }

type HostCorrelation = {
  hostSessionId?: string
  runId?: string
  sessionRef?: SessionRef
}

type RuntimePlacement = {
  agentRoot: string
  projectRoot?: string
  cwd?: string
  runMode: RunMode
  bundle: RuntimeBundleRef
  scaffoldPackets?: RunScaffoldPacket[]
  correlation?: HostCorrelation
}
```

#### Semantics

- `agent-spaces` resolves `RuntimePlacement` into one effective runtime bundle.
- `projectRoot` alone must not imply a project target.
- `sessionRef` is optional semantic correlation metadata only.
- `hostSessionId` is optional host correlation metadata only.
- `runMode` shapes materialization only; it does not create host workflow semantics.

### 3. Runtime-facing filesystem contract

#### `agentRoot`

Reserved runtime-facing layout:

```text
<agentRoot>/
  SOUL.md
  HEARTBEAT.md
  agent-profile.toml
  spaces/
    <spaceId>/
      space.toml
      ...
```

Rules:

- `SOUL.md` is required.
- `HEARTBEAT.md` is optional.
- `agent-profile.toml` is optional.
- `<agentRoot>/spaces/<id>/` is the agent-local space namespace.
- other directories may exist, but they are not implicitly injected into runtime context.

#### `projectRoot`

Project-local files may include:

```text
<projectRoot>/
  asp-targets.toml
  spaces/
    <spaceId>/
      space.toml
      ...
```

Rules:

- `<projectRoot>/spaces/<id>/` is the project-local space namespace.
- `<projectRoot>/asp-targets.toml` remains the named project-target manifest.
- `projectRoot` itself does not choose a target; the host must choose one explicitly.

#### Concrete example layout

```text
/srv/agents/alice/
  SOUL.md
  HEARTBEAT.md
  agent-profile.toml
  spaces/
    private-ops/
      space.toml
      AGENTS.md
    task-worker/
      space.toml
      AGENTS.md

/srv/projects/demo/
  asp-targets.toml
  spaces/
    repo-defaults/
      space.toml
      AGENTS.md
    task-scaffolds/
      space.toml
      AGENTS.md
  src/
  docs/
```

Example ref mapping:

- `space:agent:private-ops` -> `/srv/agents/alice/spaces/private-ops`
- `space:agent:task-worker` -> `/srv/agents/alice/spaces/task-worker`
- `space:project:repo-defaults` -> `/srv/projects/demo/spaces/repo-defaults`
- `space:project:task-scaffolds` -> `/srv/projects/demo/spaces/task-scaffolds`

### 4. `agent-profile.toml` contract

Implement this schema:

```ts
type HarnessSettings = {
  model?: string
  sandboxMode?: string
  approvalPolicy?: string
  profile?: string
}

type AgentRuntimeProfile = {
  schemaVersion: 1

  instructions?: {
    additionalBase?: string[]
    byMode?: Partial<Record<RunMode, string[]>>
  }

  spaces?: {
    base?: SpaceRefString[]
    byMode?: Partial<Record<RunMode, SpaceRefString[]>>
  }

  targets?: Record<
    string,
    {
      compose: SpaceRefString[]
    }
  >

  harnessDefaults?: HarnessSettings
  harnessByMode?: Partial<Record<RunMode, HarnessSettings>>
}
```

Rules:

- `instructions.additionalBase` is additive to implicit `SOUL.md`
- `instructions.byMode.heartbeat` is additive to implicit `HEARTBEAT.md`
- instruction refs may use `agent-root:///...`, `project-root:///...`, or allowed external refs
- `targets` defines named agent-local bundles

### 5. Project target manifest contract

Keep the current `asp-targets.toml` concept as the project-target manifest.

The minimum requirement is:

- named targets with `compose` lists
- existing harness hints may remain

The key behavioral rule is:

- a `project-target` selection must come from an explicit `RuntimeBundleRef`
- the existence of `projectRoot` must never auto-select a target

### 6. Root-relative refs

Upstream runtime refs must support:

- `agent-root:///<relative-path>`
- `project-root:///<relative-path>`

Rules:

- resolve against declared absolute roots
- normalize before access
- reject `..` escapes
- reject symlink or alias escapes outside the declared root
- interpret fragments format-specifically

Do not implement `agent-home://...` in upstream `agent-spaces`.

### 7. Local-space refs and dependency rules

Support:

- `space:agent:<id>`
- `space:project:<id>`

Resolution:

- `space:agent:<id>` -> `<agentRoot>/spaces/<id>/`
- `space:project:<id>` -> `<projectRoot>/spaces/<id>/`

Allowed dependency edges:

- registry -> registry
- agent-local -> registry
- agent-local -> agent-local within the same `agentRoot`
- project-local -> registry
- project-local -> project-local within the same `projectRoot`

Disallowed dependency edges:

- registry -> agent-local
- registry -> project-local
- agent-local -> project-local
- project-local -> agent-local

If a host wants both agent-local and project-local spaces active, it must compose them at the top level through `RuntimeBundleRef`.

### 8. Instruction and space precedence

#### Instruction layering order

This order is normative:

1. implicit `SOUL.md`
2. `agent-profile.toml -> instructions.additionalBase`
3. implicit `HEARTBEAT.md` when `runMode = heartbeat` and the file exists
4. `agent-profile.toml -> instructions.byMode[runMode]`
5. host `scaffoldPackets` in request order

#### Space composition order

This order is normative:

1. `agent-profile.toml -> spaces.base`
2. `agent-profile.toml -> spaces.byMode[runMode]`
3. spaces from the selected `RuntimeBundleRef`

If the same resolved space appears more than once, deduplicate by resolved space key.

### 9. CWD rules

- if `placement.cwd` is supplied, it wins
- otherwise, if `bundle.kind = 'project-target'`, default `cwd = projectRoot`
- otherwise, default `cwd = agentRoot`

All `cwd` values must be absolute.

### 10. Materialization model

Implement two layers:

#### Base bundle

A cached base bundle derived from:

- selected `RuntimeBundleRef`
- resolved spaces and integrities
- implicit reserved files
- `agent-profile.toml`
- harness defaults relevant to materialization

#### Per-run overlay

A run-specific overlay derived from:

- `runMode`
- mode-specific instructions/spaces
- scaffold packets
- per-run host overrides

The implementation may evolve, but the behavior must follow this split. Different run modes against the same underlying placement must produce different effective instruction bundles without forcing unnecessary full re-resolution.

### 11. Audit output

Every successful resolution must be able to return:

```ts
type ResolvedInstruction = {
  slot: string
  ref: string
  contentHash: string
}

type ResolvedSpace = {
  ref: SpaceRefString
  resolvedKey: string
  integrity: string
}

type ResolvedRuntimeBundle = {
  bundleIdentity: string
  runMode: RunMode
  cwd: string
  instructions: ResolvedInstruction[]
  spaces: ResolvedSpace[]
}
```

This metadata should be returned from:

- explicit resolve/inspect paths,
- `runTurnNonInteractive(...)`,
- `buildProcessInvocationSpec(...)`.

### 12. Correlation env vars

When `placement.correlation.sessionRef` is present, `buildProcessInvocationSpec(...)` may include:

- `AGENT_SCOPE_REF`
- `AGENT_LANE_REF`

When `placement.correlation.hostSessionId` is present, it may also include:

- `AGENT_HOST_SESSION_ID`

These vars are advisory only.

### 13. Provider typing

Provider ownership is explicit:

- `agent-sdk`, `claude-code` -> `anthropic`
- `pi-sdk`, `codex-cli` -> `openai`

Continuation keys must not cross providers.

## Target public API

The old `cpSessionId + SpaceSpec + cwd` request shape is superseded.

### Client construction

Move store/cache/registry configuration out of `RuntimePlacement` and into client creation.

Recommended shape:

```ts
type AgentSpacesClientOptions = {
  aspHome?: string
  registryPath?: string
}

createAgentSpacesClient(options?: AgentSpacesClientOptions): AgentSpacesClient
```

`ASP_HOME` remains valid as the default backing store/cache location, but it is host config, not placement data.

### Request/response surface

```ts
type RunTurnNonInteractiveRequest = {
  placement: RuntimePlacement

  frontend: 'agent-sdk' | 'pi-sdk'
  model?: string

  continuation?: HarnessContinuationRef

  env?: Record<string, string>
  prompt: string
  attachments?: string[]
  callbacks: SessionCallbacks
}

type RunTurnNonInteractiveResponse = {
  continuation?: HarnessContinuationRef
  provider: ProviderDomain
  frontend: 'agent-sdk' | 'pi-sdk'
  model?: string
  result: RunResult
  resolvedBundle?: ResolvedRuntimeBundle
}

type BuildProcessInvocationSpecRequest = {
  placement: RuntimePlacement

  provider: ProviderDomain
  frontend: 'claude-code' | 'codex-cli'
  model?: string

  interactionMode: 'interactive' | 'headless'
  ioMode: 'pty' | 'inherit' | 'pipes'

  continuation?: HarnessContinuationRef
  env?: Record<string, string>
  artifactDir?: string
}

type BuildProcessInvocationSpecResponse = {
  spec: ProcessInvocationSpec
  resolvedBundle?: ResolvedRuntimeBundle
  warnings?: string[]
}
```

### Compatibility guidance

The repo may keep a temporary compatibility wrapper that accepts the old request shape and converts it into `RuntimePlacement`, but:

- the new placement-based surface is the only target shape,
- new docs and tests must use the placement-based surface,
- the compatibility adapter must not become the main design.

## Current repo reuse and planned changes

### Reuse directly

- current harness adapters and model/provider mapping
- current `buildProcessInvocationSpec(...)` split between SDK and CLI frontends
- current lock/integrity/materialization machinery where it remains valid
- current `space:project:<id>` support as the starting point for local-space work
- current CLI `--dry-run` and print-command UX patterns

### Change substantially

- replace `SpaceSpec` as the primary public selector with `RuntimePlacement`
- replace `cpSessionId` naming with `hostSessionId` in correlation
- add `agent-profile.toml`, `SOUL.md`, `HEARTBEAT.md`
- add `space:agent:<id>`
- add root-relative refs
- move from target-centric public resolution to placement-centric resolution
- quarantine or internalize long-lived “session registry” concepts
- improve path safety for local-space and root-relative resolution

## Milestones

### Milestone 0: repo prep and test scaffolding

#### Work

- Add fixtures for:
  - sample `agentRoot`
  - sample `projectRoot`
  - reserved files
  - `agent-profile.toml`
  - agent-local spaces
  - project-local spaces
  - project target manifest
- Add test helpers for root containment and local-space fixtures.
- Document the breaking-change direction in the repo root docs.

#### Exit criteria

- fixtures exist for all four harness frontends
- tests can resolve an `agentRoot` and optional `projectRoot` without any external host implementation

### Milestone 1: build `agent-scope`

#### Work

- Create `packages/agent-scope`
- Implement the grammar, validation, formatting, normalization, and ancestor derivation described above.
- Add exhaustive unit tests for valid and invalid forms.
- Ensure the package has no dependency on any other workspace package.

#### Exit criteria

- all required `agent-scope` APIs exist
- canonical valid/invalid forms behave exactly as specified
- `ancestorScopeRefs(...)` test coverage is complete

### Milestone 2: path safety and local-space completion

#### Work

- Extend current `space:project:<id>` support to satisfy the new explicit-ref contract end to end.
- Add `space:agent:<id>` and thread `agentRoot` through closure, manifest reads, integrity hashing, and materialization.
- Enforce the allowed/disallowed dependency edges.
- Implement root-relative path safety:
  - normalize paths,
  - reject `..`,
  - use realpath-based containment where the filesystem is consulted,
  - reject symlink or alias escapes.

#### Exit criteria

- `space:agent:<id>` resolves correctly
- `space:project:<id>` works in explicit compose paths, not only project target manifests
- disallowed cross-root dependency edges fail deterministically
- path escape tests pass

### Milestone 3: reserved files and runtime profile resolution

#### Work

- Implement the runtime-facing `agentRoot` contract:
  - `SOUL.md`
  - optional `HEARTBEAT.md`
  - optional `agent-profile.toml`
- Add parsers and validators for `agent-profile.toml`.
- Support `agent-root:///...` and `project-root:///...` refs in instruction slots.
- Keep `asp-targets.toml` as the project-target manifest.

#### Exit criteria

- missing `SOUL.md` causes resolution failure
- missing `HEARTBEAT.md` is allowed
- profile instructions/spaces resolve correctly
- root-relative refs are safe and functional

### Milestone 4: placement-driven resolution and audit metadata

#### Work

- Introduce `RuntimePlacement`, `RuntimeBundleRef`, `RunMode`, `RunScaffoldPacket`, `HostCorrelation`, and `ResolvedRuntimeBundle` in the public package.
- Build a placement resolver that:
  - chooses the base bundle from `RuntimeBundleRef`,
  - merges reserved files and profile defaults,
  - applies mode-aware overlays and scaffold packets,
  - resolves effective `cwd`,
  - emits `ResolvedRuntimeBundle`.
- Ensure `projectRoot` alone never selects a project target.

#### Exit criteria

- one placement resolves to one deterministic effective bundle
- `project-target` requires explicit target selection
- successful resolution returns audit metadata

### Milestone 5: public API cutover

#### Work

- Replace `SpaceSpec`-based public requests with placement-based requests.
- Rename `cpSessionId` to `hostSessionId` in correlation metadata.
- Wire optional `sessionRef` from `agent-scope`.
- Return `resolvedBundle` from execution and invocation APIs.
- Preserve provider mismatch checks and continuation typing.

#### Exit criteria

- new client API matches the target contract in this plan
- provider mismatch checks still work
- continuation refs still behave correctly
- public docs and tests use the new request shape

### Milestone 6: CLI surface for standalone agent execution

#### Work

Implement placement-based agent subcommands described below.

The CLI becomes a standalone host:

- for SDK frontends it calls `runTurnNonInteractive(...)`
- for CLI frontends it calls `buildProcessInvocationSpec(...)` and then spawns the process locally

Do not repurpose existing non-agent `asp run` semantics.

Required CLI direction:

- keep existing `asp run`, `asp install`, `asp build`, `asp explain`, and related target/space-oriented commands for current agent-spaces usage
- add a distinct `asp agent ...` subcommand family for placement-driven single-agent execution
- do not make `asp run` a compatibility wrapper over the new agent model
- do not require existing non-agent users to learn `RuntimePlacement` just to keep using current target execution flows

#### Exit criteria

- standalone operator can resolve, dry-run, and run one agent without any external orchestration layer
- CLI dry-run output is produced entirely from the new placement pipeline
- CLI can use agent-local spaces, project-local spaces, agent targets, and project targets
- existing non-agent `asp run` behavior remains intact

### Milestone 7: cleanup and release hardening

#### Work

- Remove or quarantine public references to long-lived session registries and legacy host-specific terminology.
- Update docs, examples, and smoke plans.
- Verify all tests and dry-runs across frontends.

#### Exit criteria

- no public docs describe `agent-spaces` as the owner of durable sessions
- no primary docs use host-specific request terminology as the primary surface
- validation commands pass

## Expected standalone CLI surface

The standalone CLI must be host-generic and placement-driven for agent execution, while preserving the existing non-agent agent-spaces CLI surface.

### Existing CLI surface that must remain

These commands keep their current meaning:

- `asp run <target-or-space>`
- `asp install`
- `asp build`
- `asp explain`
- `asp add`
- `asp remove`
- `asp upgrade`
- `asp lint`
- `asp doctor`
- `asp repo ...`

These commands remain target/space-oriented agent-spaces functionality.

### New agent-oriented command family

The new placement-driven surface lives under `asp agent`.

Primary execution uses positional `ScopeRef` selection and the run mode as the verb:

- `asp agent <scope-ref> query <prompt>`
- `asp agent <scope-ref> task <prompt>`
- `asp agent <scope-ref> heartbeat`
- `asp agent <scope-ref> maintenance`

Diagnostic commands may still exist under explicit subcommands:

- `asp agent resolve <scope-ref>`
- optional `asp agent inspect <scope-ref>`

CLI parsing rule:

- after `asp agent`, if the first positional token parses as a `ScopeRef`, the second positional token is the execution mode
- reserved non-`ScopeRef` first-position tokens may include `resolve`, `inspect`, `help`, and `version`
- `--scope-ref` may exist only as a temporary compatibility alias; it should not be the documented primary surface

### Required commands

#### `asp agent <scope-ref> <mode>`

Purpose:

- execute one standalone run for any frontend
- make `ScopeRef` the default selector for agent execution
- make the mode itself the verb instead of introducing an additional `run` subcommand

Positionals:

- `<scope-ref>` required
- `<mode>` is one of `query`, `heartbeat`, `task`, `maintenance`
- `<prompt>` is positional for `query` and `task`

Required flags:

- `--agent-root <abs>`
- `--frontend agent-sdk|pi-sdk|claude-code|codex-cli`

Bundle selection flags:

- if omitted, default bundle selection is `agent-default`
- explicit bundle selectors override the default:
  - `--bundle agent-default`
  - `--agent-target <name>`
  - `--project-target <name>` together with `--project-root <abs>`
  - repeated `--compose <spaceRef>`

Optional flags:

- `--project-root <abs>`
- `--cwd <abs>`
- `--host-session-id <id>`
- `--run-id <id>`
- `--lane-ref <LaneRef>`
- `--scaffold-file <json>`
- `--model <model>`
- `--prompt <text>`
- `--prompt-file <path>`
- repeated `--attachment <path>`
- `--continue-provider anthropic|openai`
- `--continue-key <key>`
- `--interaction interactive|headless`
- `--io pty|pipes|inherit`
- repeated `--env KEY=VALUE`
- `--dry-run`
- `--print-command`
- `--json`

Behavior:

- defaults bundle selection to `agent-default` when no explicit selector is provided
- defaults `laneRef` to `main` when `--lane-ref` is omitted
- `projectRoot` alone must not imply a project target
- positional `<prompt>`, `--prompt`, and `--prompt-file` are mutually exclusive input sources
- `query` and `task` require one prompt source
- `heartbeat` and `maintenance` may omit a prompt entirely
- for `agent-sdk` and `pi-sdk`, execute in-process via `runTurnNonInteractive(...)`
- for `claude-code` and `codex-cli`, build invocation via `buildProcessInvocationSpec(...)` and spawn locally
- `--dry-run` must not spawn; it prints invocation details and the resolved bundle
- `--print-command` is UX-only; `argv` remains authoritative

#### `asp agent resolve <scope-ref>`

Purpose:

- resolve a placement without executing it
- print the effective `RuntimePlacement`
- print the `ResolvedRuntimeBundle`

Positionals:

- `<scope-ref>` required

Required flags:

- `--agent-root <abs>`
- `--mode query|heartbeat|task|maintenance`

Bundle selection flags:

- if omitted, default bundle selection is `agent-default`
- explicit bundle selectors override the default:
  - `--bundle agent-default`
  - `--agent-target <name>`
  - `--project-target <name>` together with `--project-root <abs>`
  - repeated `--compose <spaceRef>`

Optional flags:

- `--project-root <abs>`
- `--cwd <abs>`
- `--host-session-id <id>`
- `--run-id <id>`
- `--lane-ref <LaneRef>`
- `--scaffold-file <json>`
- `--json`

Behavior:

- validates and prints the resolved effective bundle
- defaults bundle selection to `agent-default` when no explicit selector is provided
- defaults `laneRef` to `main` if `--lane-ref` is omitted

#### `asp agent inspect <scope-ref>`

Purpose:

- optional debug surface for inspecting effective instructions, spaces, harness defaults, and warnings

This command is useful but not critical to the first cut. If time is limited, `asp agent resolve <scope-ref> --json` may satisfy this role.

### Required standalone CLI examples

#### Query an agent using the default bundle selector

```bash
asp agent "agent:alice" query "What is your name?" \
  --agent-root /srv/agents/alice \
  --frontend codex-cli \
  --interaction interactive \
  --io pty
```

#### Query an agent in project context with an explicit project target

```bash
asp agent "agent:alice:project:demo" query "Summarize the repo status." \
  --agent-root /srv/agents/alice \
  --project-root /srv/projects/demo \
  --project-target dev \
  --frontend codex-cli \
  --lane-ref main \
  --interaction interactive \
  --io pty
```

#### Run a standalone SDK heartbeat turn

```bash
asp agent "agent:alice" heartbeat \
  --agent-root /srv/agents/alice \
  --bundle agent-default \
  --frontend agent-sdk \
  --scaffold-file ./heartbeat-scaffold.json
```

#### Run a task using a task-scoped `ScopeRef`

```bash
asp agent "agent:alice:project:demo:task:bugfix-142" task "Fix bug #142. Reproduce it, patch it safely, and report what changed." \
  --agent-root /srv/agents/alice \
  --project-root /srv/projects/demo \
  --project-target task \
  --frontend agent-sdk \
  --host-session-id hs_bugfix_142_main \
  --lane-ref main
```

#### Dry-run a standalone Codex CLI execution

```bash
asp agent "agent:alice:project:demo" query "Investigate failing CI" \
  --agent-root /srv/agents/alice \
  --project-root /srv/projects/demo \
  --project-target dev \
  --frontend codex-cli \
  --interaction interactive \
  --io pty \
  --dry-run \
  --print-command
```

#### Resolve an explicit composed bundle without executing it

```bash
asp agent resolve \
  "agent:alice:project:demo" \
  --agent-root /srv/agents/alice \
  --project-root /srv/projects/demo \
  --compose "space:agent:private-ops" \
  --compose "space:project:repo-defaults" \
  --mode task \
  --json
```

## Testing requirements

Add or update tests for all of the following:

### `agent-scope`

- valid scope forms
- invalid scope forms
- valid lane forms
- lane defaulting to `main`
- canonical formatting
- ancestor derivation

### `agent-spaces` library

- reserved files:
  - missing `SOUL.md` fails
  - missing `HEARTBEAT.md` is allowed
- `agent-profile.toml` parsing and precedence
- instruction layering by `runMode`
- `space:project:<id>` on explicit compose path
- `space:agent:<id>` on explicit compose path
- disallowed cross-root dependency edges
- `projectRoot` not implying a project target
- root-relative ref path escape rejection
- continuation provider mismatch rejection
- `sessionRef` -> env propagation
- `hostSessionId` -> env propagation
- resolved bundle audit metadata returned from successful resolution
- CLI invocation building without spawning

### CLI integration

- existing `asp run <target-or-space>` flows still behave as they did before this work
- `asp agent resolve <ScopeRef>` for:
  - agent-default
  - agent-target
  - project-target
  - explicit compose
- `asp agent <ScopeRef> query --dry-run` for:
  - `claude-code`
  - `codex-cli`
- `asp agent <ScopeRef> query|task|heartbeat` SDK path for:
  - `agent-sdk`
  - `pi-sdk`

### Validation commands

The finished work must pass:

- `bun run build`
- `bun run typecheck`
- `bun run test`
- `bun run lint`

## Final success criteria

This work is complete only when all of the following are true:

1. `agent-scope` exists, is standalone, and fully implements the contract in this file.
2. `agent-spaces` public APIs are placement-based, not `SpaceSpec`-based.
3. `agent-spaces` no longer requires host-specific legacy terminology in its primary surface.
4. `SOUL.md`, optional `HEARTBEAT.md`, and `agent-profile.toml` are implemented as upstream runtime behavior.
5. `space:agent:<id>` and `space:project:<id>` both work in explicit compose paths.
6. root-relative refs are implemented and safe.
7. `ResolvedRuntimeBundle` is returned from successful resolution/execution/invocation paths.
8. CLI harnesses support invocation-only behavior at the library layer.
9. The standalone `asp agent` CLI surface uses positional `ScopeRef` selection, mode verbs such as `query` and `task`, and can resolve, dry-run, and run one agent directly without any external orchestration layer.
10. `projectRoot` never implicitly selects a project target.
11. provider mismatch checks still protect continuation reuse.
12. the full build, typecheck, test, and lint suite passes.
13. existing non-agent `asp run` behavior remains available and unchanged in meaning.

## Release guidance

This should ship as a breaking change in `agent-spaces`.

Recommended release order:

1. land `agent-scope`
2. land internal placement/profile work
3. land placement-based public API with temporary compatibility wrapper if needed
4. land standalone `asp agent` placement-based CLI
5. remove or de-emphasize legacy target-first docs

The final published story should be:

- `agent-scope` is the upstream semantic-address package
- `agent-spaces` is the upstream single-agent runtime package
- any host can consume both
