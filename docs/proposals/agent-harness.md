# Praesidium Agent Harness

- **Status:** accepted; ratified by Daedalus in `hrcchat#20779`
- **Date:** 2026-08-24
- **Author:** cody@agent-spaces
- **Tracking:** T-07542
- **Architecture authority:** `agent-spaces.agent-harness-runtime-boundary`

## Decision

Praesidium will own a first-party Pi runtime whose resources are supplied by a
custom Pi `ResourceLoader`. The direct `agent-harness` path will resolve ASP
agent and space sources and construct a Pi `AgentSessionRuntime`; it will not
consume a compiler-materialized Pi bundle, a generated frontier-harness home,
or a `HarnessAdapter` lowering.

The POC in `~/agent-harness.tar.gz` is the implementation reference for the Pi
host shape: create the loader inside Pi's replaceable runtime factory, await
`reload()` before session construction, create the session from explicit Pi
services, and wrap the result with `createAgentSessionRuntime()`. The POC is not
copied wholesale because it hard-codes agents, model, query mode, roots, and
resource categories. Those values remain ASP-owned.

The resulting system has one direct runtime and two outer execution surfaces:

```text
ASP agent/profile/space sources
            |
            v
resolveAgentResourceSources()       inspectAgentSystemPrompt()
            |                                  |
            +----------------+-----------------+
                             v
               AgentSpacesResourceLoader
                             |
                createAgentHarnessRuntime()
                             |
                  Pi AgentSessionRuntime
                    /                 \
          TUI / print frontend      HRC broker facade
          (`asp run`)               (`agent-harness run`)

External harness selection
            |
            v
compiler + HarnessAdapter -> Claude Code / Codex CLI
```

The canonical selector, executable, and broker driver remain
`agent-harness`. The internal package is renamed from `agent-harness-sdk` to
`agent-harness-runtime` because it owns a complete host runtime rather than a
general-purpose public SDK.

The Earendil Pi dependency is upgraded coherently to exact version `0.84.3`.
That version supplies the typed TUI startup theme and diagnostics used by the
foreground host.

## Why the deployed slice must be replaced

The current `agent-harness-sdk` calls `materializeAgentRuntimeResources()` with
the Pi SDK adapter. That produces a generated `pi-sdk` directory containing a
bundle, settings, auth, context, extensions, hooks, and merged skills. The
session then points Pi's loader at that compiler-produced directory.

That implementation violates the intended direct boundary even though the
session itself runs in process: it still treats the compiler adapter's output
as the source of truth. It also makes `agent-harness` unusable through ordinary
`asp run`: the harness id is catalogued, but there is no `HarnessAdapter`, and
the generic run planner unconditionally asks the adapter registry for one.

Registering a synthetic `agent-harness` adapter is explicitly rejected. It
would preserve the wrong materialization pipeline and misrepresent a
Praesidium-owned runtime as an external-harness lowering.

## Goals

- Make Pi's `ResourceLoader` the sole resource-delivery boundary for the direct
  harness.
- Resolve ASP-authored resources without composing a generated Pi bundle.
- Use one Pi `AgentSessionRuntime` factory for new, resumed, forked, imported,
  and cwd-replaced sessions.
- Launch Pi's interactive TUI when `asp run` targets an agent whose effective
  harness is `agent-harness`.
- Preserve a non-interactive print surface and the existing HRC broker surface.
- Preserve ASP prompt, reminder, skill, environment, model, tool, and placement
  semantics.
- Keep compiler-backed Claude Code and Codex CLI execution working.
- Make the custom loader visibly identifiable through the POC's purple theme
  and mechanically identifiable through assertions and tests.
- Give the TypeScript packages explicit modules rather than monolithic
  `index.ts` implementations.

## Non-goals

- Removing the compiler or existing external-harness adapters.
- Making Pi's filesystem layout equal to a compiled Claude or Codex home.
- Attaching a foreground TUI to an already running HRC broker session.
- Moving scope placement, durable messaging, or supervision authority out of
  HRC.
- Introducing a sandbox, credential broker, content-addressed resource store,
  or new public serialized runtime definition.
- Migrating the separate legacy `@mariozechner/pi-coding-agent` compatibility
  path unless validation proves the Earendil upgrade requires it.
- Treating the purple theme as sufficient proof of resource correctness.

## Package and source layout

```text
harness/agent-harness-runtime/
  src/
    agent-definition.ts
    agent-resource-loader.ts
    model-resolution.ts
    resource-sources.ts
    runtime-factory.ts
    session-manager.ts
    theme.ts
    types.ts
    index.ts
  test/
    agent-resource-loader.test.ts
    runtime-factory.test.ts
    theme.test.ts

harness/agent-harness/
  src/
    cli.ts
    broker/
      driver.ts
      invocation-session-factory.ts
    foreground/
      print.ts
      tui.ts
    index.ts
  test/
    cli.test.ts
    broker-session.test.ts
    foreground.test.ts
```

Both `index.ts` files are export-only barrels. CLI dispatch, runtime
construction, broker mapping, theme construction, and resource loading must not
be implemented in a package root barrel.

The public executable remains `agent-harness`. Its top-level dispatcher owns
three explicit modes:

```text
agent-harness tui    # foreground Pi InteractiveMode
agent-harness print  # foreground Pi print mode
agent-harness run    # existing harness-broker service transport
```

Existing broker utility subcommands continue to be forwarded to the broker CLI
without changing their protocol.

## Shared ASP source resolution

Add a non-materializing ASP configuration operation, conceptually:

```ts
resolveAgentResourceSources(options): Promise<ResolvedAgentResourceSources>
```

It owns the shared semantic work required by both direct and compatibility
paths:

1. Resolve and validate the agent/project placement.
2. Resolve the effective profile, model, reasoning level, and selected spaces.
3. Resolve the lock and ordered closure.
4. Populate missing immutable registry snapshots when required.
5. Filter spaces with `isHarnessSupported(..., 'agent-harness')`.
6. Return ordered source roots and semantic metadata without calling
   `materializeSpace()`, `materializeTarget()`, a harness adapter, or compiler
   lowering.

Immutable snapshots are permitted source acquisition. They preserve locked
registry content and are not a merged harness runtime. Mutable `@dev` spaces
remain rooted in their declared local sources. The result identifies source
kind and ordered precedence so diagnostics and parity projection can attribute
every selected resource.

Conceptually, the result contains:

```ts
interface ResolvedAgentResourceSources {
  placement: RuntimePlacement;
  agentRoot: string;
  projectRoot?: string;
  cwd: string;
  aspHome: string;
  effectiveConfig: {
    model?: string;
    reasoning?: string;
  };
  orderedSpaces: Array<{
    ref: SpaceRefString;
    root: string;
    source: "mutable" | "immutable-snapshot";
  }>;
  skillRoots: ResourceRoot[];
  extensionRoots: ResourceRoot[];
  promptTemplateRoots: ResourceRoot[];
  environment: NodeJS.ProcessEnv;
  warnings: string[];
}
```

The exact internal DTO may vary, but the following are fixed:

- It is an in-memory result, not a wire contract.
- Ordered roots preserve canonical ASP composition and agent-local override
  semantics.
- It never contains the path of a generated merged Pi bundle.
- It performs no ambient Pi, Codex, or Claude resource discovery.
- It does not make placement decisions; callers supply the resolved semantic
  placement inputs.
- Invalid/missing locked content, unsupported spaces, duplicate-resolution
  failures, and dynamic context failures propagate visibly.

The compiler may call the same underlying lock, closure, prompt, context,
environment, and resource-source helpers before performing external-harness
lowering. It does not call the direct runtime package.

## `AgentSpacesResourceLoader`

`AgentSpacesResourceLoader` implements Pi's `ResourceLoader` interface. It is
constructed with resolved semantic inputs, not an ASPC output directory.

`reload()` must:

1. Re-resolve source roots for the current cwd and placement context.
2. Call `inspectAgentSystemPrompt()` with agent, project, task, lane, run mode,
   environment, and any pinned resolver context.
3. Load skills and other supported resources from the explicit ASP roots using
   Pi's canonical parsers/loaders.
4. Apply ASP composition and agent-local precedence deterministically.
5. Store diagnostics and a complete in-memory snapshot used by the synchronous
   `ResourceLoader` getters.

No synchronous getter performs filesystem or network I/O. Every getter fails
clearly if `reload()` has not completed.

Prompt mapping is exact:

- ASP `replace` content is returned by `getSystemPrompt()`.
- ASP `append` content is the first entry returned by
  `getAppendSystemPrompt()`.
- A present reminder follows the append prompt as a separate append entry.
- Source getters return the authored template/SOUL source and a distinct
  reminder attribution.
- Absent and present-empty reminders remain distinguishable internally and in
  parity observations.

Resource mapping is exact:

- Skills are parsed from explicit ASP skill roots with Pi's skill loader.
- Extensions are loaded only from explicit ASP extension roots and explicit
  broker-supplied factories.
- Prompt templates and agent/context files are empty unless ASP explicitly
  selects them.
- Ambient `~/.pi`, project `.pi`, Codex, and Claude resources are disabled.
- `extendResources()` may add only runtime-authorized explicit roots; it cannot
  enable ambient discovery or change ASP precedence silently.
- Duplicate names follow ASP's established winner. Pi diagnostics must report
  collisions whose resolution differs from that winner.

The loader exposes inspection metadata for tests and diagnostics, including
reload count, source attribution, prompt inspection, selected skills, and Pi
resource diagnostics. This metadata remains internal to the runtime package.

## Pi runtime construction

The primary runtime API is conceptually:

```ts
createAgentHarnessRuntime(options): Promise<AgentSessionRuntime>
```

The factory follows the POC structure:

1. Create Pi `ModelRuntime` with the resolved auth store path and resolve the
   requested model without enabling an unbounded network catalog refresh.
2. Build a `CreateAgentSessionRuntimeFactory`.
3. Inside that factory, construct `SettingsManager` and a fresh
   `AgentSpacesResourceLoader` for the supplied cwd.
4. Await the loader's `reload()`.
5. Call `createAgentSessionFromServices()` with explicit services, selected
   model, thinking level, tools, and session manager.
6. Assert that the returned session uses `AgentSpacesResourceLoader` and
   contains the resolved prompt/reminder.
7. Return `createAgentSessionRuntime(factory, initialOptions)`.

Constructing the loader inside Pi's replacement-session factory is mandatory.
Pi can replace the active session during `/new`, `/resume`, `/fork`, imported
sessions, and cwd transitions. Capturing one loader outside that factory would
silently fall back to stale resources after a replacement.

The runtime owns disposal. All TUI, print, error, interrupt, and broker shutdown
paths await `runtime.dispose()` exactly once.

## Session and authentication ownership

Foreground session history is isolated per agent:

```text
${ASP_HOME}/agent-harness/sessions/<agent-id>/
```

Pi continues to filter/select sessions by cwd within that agent-specific
directory.

Session selection maps as follows:

| Request                 | Pi session manager                                                          |
| ----------------------- | --------------------------------------------------------------------------- |
| no resume option        | `SessionManager.create(cwd, sessionDir)`                                    |
| bare `--resume`         | `SessionManager.continueRecent(cwd, sessionDir)`                            |
| `--resume <path-or-id>` | resolve within the agent session directory, then `SessionManager.open(...)` |

Explicit resume identifiers must not escape the selected agent's session
directory after realpath normalization. A missing or ambiguous identifier
fails visibly; the direct path does not open a different agent's session.

Model credentials use the existing Pi auth resolution contract. Authentication
is bound before model lookup or session construction, at the Pi APIs that
actually own it:

1. The caller supplies the resolved `authMode`, `authPath`, and `providerId`
   together with the composed runtime environment.
2. Follow the working POC and construct `ModelRuntime` with
   `ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false,
allowModelNetwork: false })`. Foreground execution uses the POC's
   agent-directory `auth.json`; broker execution substitutes the auth path that
   the broker already resolved. This binds OAuth to the caller-selected store.
3. Resolve the model provider and require it to equal the authenticated
   provider.
4. For API-key mode, resolve the provider credential from the composed
   environment and await `modelRuntime.setRuntimeApiKey(providerId, credential)`
   before `getModel()` and before any session factory invocation.
5. Pass the already authenticated `ModelRuntime` through
   `AgentSessionServices`; do not attempt to pass auth to
   `createAgentSessionFromServices()`, which has no auth parameter.

Broker-supplied `PiSdkAuthResolution` remains authoritative for broker sessions:
its path/provider/mode and the broker-composed environment are passed unchanged
to this binding step. The foreground path first calls the existing Pi auth
resolver against its agent-scoped/configured auth store and then uses the same
binding function. No broker session may fall back to the foreground agent store.
Missing credentials, provider mismatch, or unreadable/mistyped OAuth state fail
before session creation. Secrets are never copied into resource trees or
printed by `--dry-run`/`--print-command`.

## Foreground `asp run`

`agent-harness` is a discriminated direct runtime strategy, not a
`HarnessAdapter`.

Project-target planning returns one of two shapes:

```ts
type ProjectTargetRuntimePlan =
  | {
      kind: "external-harness";
      harnessId: HarnessId;
      adapter: HarnessAdapter; /* ... */
    }
  | {
      kind: "agent-harness";
      harnessId: "agent-harness";
      agentProfile: AgentProfile; /* ... */
    };
```

The direct branch is valid only for a resolved agent target with an agent
profile. A global/dev space or arbitrary project target cannot select
`agent-harness` without an agent identity and fails with a specific diagnostic.

The run orchestrator branches on the plan before adapter lookup, bundle
installation, prompt materialization, or compiler invocation. It prepares the
semantic invocation and launches the installed `agent-harness` entrypoint with
inherited stdin/stdout/stderr. The ASP installation/package contract must make
the matching coherent-set executable resolvable; tests inject its path rather
than searching an uncontrolled ambient PATH.

Default behavior:

```text
asp run <agent>
  -> agent-harness tui --agent-id <agent> --project-id <project> ...
```

The semantic invocation carries agent id/root, project id/root, cwd, ASP home,
run mode, scope/lane correlation, selected model/reasoning, safe environment
overrides, resume selector, and optional initial prompt. It does not carry a
compiled bundle path.

CLI behavior:

- Interactive is the default and requires a real TTY.
- A positional prompt becomes `InteractiveMode.initialMessage`.
- `--resume` follows the session-selection table above.
- `--no-interactive` requires a prompt and calls Pi `runPrintMode()` using the
  same runtime factory.
- `--dry-run` and `--print-command` print the direct semantic launch without
  resolving/loading resources, creating sessions, or writing generated homes.
- Unsupported compiler/debug-only options fail rather than being silently
  ignored.
- Child exit status and errors propagate through `asp run`.

The TUI is local foreground execution. It does not attach to or take ownership
of an existing HRC runtime, scope binding, durable inbox, or broker session.

## HRC broker path

HRC continues to invoke:

```text
agent-harness run --transport stdio|unix ...
```

The broker invocation still supplies semantic `spec.agent` placement values,
auth, permission extension, structured-output tool, continuation, locked
environment, and dispatch environment.

The `agent-harness` package adapts `AgentSessionRuntime.session` to the narrow
`PiSdkSession` interface expected by `spaces-harness-broker-pi-sdk`. The facade
owns and awaits runtime disposal. The broker package may widen its session
`dispose()` type to `void | Promise<void>` and must await it; it does not learn
about ASP source resolution or depend on `agent-harness-runtime`.

This preserves the dependency direction:

```text
agent-harness -> agent-harness-runtime
agent-harness -> spaces-harness-broker-pi-sdk
agent-harness-runtime -> ASP semantic libraries + Pi
spaces-execution -X-> agent-harness-runtime
```

HRC retains placement, lifecycle, supervision, routing, durable messaging, and
reconnect authority. The runtime executes sessions and maps their events.

## Pi `0.84.3` upgrade

All Earendil coding-agent consumers move together to exact `0.84.3`:

- `drivers/harness-pi-sdk`
- `harness/harness-broker-pi-sdk`
- `harness/agent-harness-runtime`
- `harness/agent-harness`, which directly owns `InteractiveMode`,
  `runPrintMode()`, and Pi runtime/session facade types
- `spaces-integration-tests`, which calls `formatSkillsForPrompt()` on skills
  returned by the production loader
- the coherent Bun lock entries for `@earendil-works/pi-*`

Mixed `0.84.1`/`0.84.3` installations are not supported. Pi session, theme,
runtime, resource-loader, extension, and tool objects cross package boundaries;
multiple versions risk both TypeScript identity errors and runtime
`instanceof`/behavior mismatches.

The upgrade is accepted only after build/type validation and real external Pi,
broker, and TUI smokes. The legacy Mariozechner Pi dependency is a separate
compiler-compatibility surface and does not move unless those checks require
it.

## Purple loader-validation theme

The runtime copies the POC theme under the stable name:

```ts
export const RESOURCE_LOADER_THEME_NAME = "praesidium-loader";
```

The exact foreground palette is:

```ts
{
  accent: '#22d3ee', border: '#a855f7', borderAccent: '#22d3ee',
  borderMuted: '#6b21a8', success: '#86efac', error: '#fca5a5',
  warning: '#fde047', muted: '#c4b5fd', dim: '#a78bfa', text: '#f8fafc',
  thinkingText: '#c4b5fd', searchMatchText: '#ffffff',
  userMessageText: '#ffffff', customMessageText: '#ffffff',
  customMessageLabel: '#67e8f9', toolTitle: '#ffffff', toolOutput: '#cffafe',
  mdHeading: '#67e8f9', mdLink: '#c4b5fd', mdLinkUrl: '#a5f3fc',
  mdCode: '#67e8f9', mdCodeBlock: '#d8b4fe', mdCodeBlockBorder: '#22d3ee',
  mdQuote: '#e9d5ff', mdQuoteBorder: '#a855f7', mdHr: '#6b21a8',
  mdListBullet: '#22d3ee', toolDiffAdded: '#86efac',
  toolDiffRemoved: '#fca5a5', toolDiffContext: '#c4b5fd',
  syntaxComment: '#a5b4fc', syntaxKeyword: '#67e8f9',
  syntaxFunction: '#d8b4fe', syntaxVariable: '#f8fafc',
  syntaxString: '#a7f3d0', syntaxNumber: '#fde68a', syntaxType: '#c4b5fd',
  syntaxOperator: '#67e8f9', syntaxPunctuation: '#f8fafc',
  thinkingOff: '#6b21a8', thinkingMinimal: '#7e22ce', thinkingLow: '#9333ea',
  thinkingMedium: '#a855f7', thinkingHigh: '#c084fc',
  thinkingXhigh: '#22d3ee', thinkingMax: '#67e8f9', bashMode: '#22d3ee'
}
```

The exact background palette is:

```ts
{
  selectedBg: '#0e7490', scrollbarThumb: '#22d3ee',
  searchMatchBg: '#7e22ce', userMessageBg: '#6d28d9',
  customMessageBg: '#581c87', toolPendingBg: '#155e75',
  toolSuccessBg: '#166534', toolErrorBg: '#991b1b'
}
```

Construct it as a truecolor Pi `Theme` with a packaged-module `sourcePath`,
expose it from `AgentSpacesResourceLoader.getThemes()`, and select it with
`InteractiveMode({ initialThemeSetting: 'praesidium-loader' })`.

The TUI also emits a startup diagnostic naming the agent and session. Tests
assert the loader class, prompt/reminder inclusion, theme name, and palette;
the visible purple/cyan rendering is an operator smoke signal, not the sole
test oracle.

## Failure and side-effect contract

The direct path fails visibly on:

- unresolved agent/profile/project placement;
- unsupported space/harness combinations;
- missing immutable snapshots that cannot be populated;
- prompt/context resolution failure;
- resource parse/load failure required for correctness;
- unsupported model or missing authentication;
- non-TTY interactive launch;
- invalid/escaping resume selection;
- session creation, replacement, or disposal failure; and
- child/front-end nonzero exit.

Warnings that Pi classifies as non-fatal remain attributed and visible in
startup diagnostics. Required ASP resource loss is never downgraded to a
warning.

Direct startup may populate locked immutable snapshots, create agent-scoped
auth/settings/session state, and perform normal workspace tool writes after a
turn begins. It must not create compiler target output, merged Pi resource
directories, `bundle.json`, or `.asp-materialized.json`.

## Verification

### Focused automated checks

- The source resolver returns ordered mutable/snapshot roots without invoking
  any adapter or target materializer.
- Prompt replace/append/reminder mapping is exact.
- Skills from composed and agent-local sources use the declared ASP winner and
  Pi parser.
- Ambient Pi/project/user resources remain excluded.
- Loader getters require successful reload and perform no I/O.
- New/resume/fork/session replacement creates and reloads a fresh custom loader
  for the active cwd.
- Runtime construction asserts loader identity and prompt/reminder inclusion.
- OAuth and API-key broker auth bind to the shared `ModelRuntime` before model
  and session creation, with no foreground-store fallback.
- Theme name and every POC color remain exact.
- Broker facade forwards operations/events and awaits runtime disposal.
- `asp run` planning never requests an adapter for `agent-harness`.
- Direct dry-run produces a TUI/print launch and creates no materialized bundle.

### Real installed foreground smoke

After `just install`, use Ghostty/ghostmux with a real agent and terminal:

1. `asp run <agent>` opens Pi's TUI.
2. Purple/cyan `praesidium-loader` is active and visible in theme diagnostics.
3. The startup diagnostic identifies the correct agent and session.
4. The agent's prompt identity, reminder, composed skills, and local skills are
   present.
5. An initial positional prompt executes.
6. A real tool call succeeds.
7. `/new`, `/resume`, and `/fork` retain the custom loader and resources.
8. Exit and interrupt dispose the runtime cleanly.
9. Bare and explicit `asp run --resume` select only that agent's sessions.
10. `asp run --no-interactive <agent> <prompt>` completes in print mode.

### Broker and compatibility smoke

- Run the real harness-broker MATRIX from Ghostty/ghostmux because the broker
  session/disposal contract changes.
- Exercise real HRC prompt, multi-turn, steer, interrupt, structured result,
  event, stop, and reconnect behavior through `agent-harness run`.
- Run agent-resource parity for all fleet agents and modes.
- Run an explicitly selected Codex CLI agent and Claude Code agent through the
  retained compiler path.
- Run build, typecheck, lint, boundary, manifest, test, cross-repo pack, and CLI
  package smoke gates.

## Migration sequence

1. Add the non-materializing ASP resource-source resolver and tests.
2. Upgrade all Earendil Pi consumers to exact `0.84.3` in one lockfile change.
3. Replace `agent-harness-sdk` with `agent-harness-runtime` and implement the
   custom loader, theme, session selection, and runtime factory.
4. Move `agent-harness` into explicit CLI, broker, TUI, and print modules.
5. Adapt the broker session facade and validate the full broker MATRIX.
6. Add the discriminated direct plan and `asp run` foreground launch.
7. Rewrite the parity verifier's SDK observer to observe the custom loader.
8. Install and complete the real TUI, broker, parity, and compatibility smokes.
9. Remove obsolete generated-bundle seams used only by the old direct harness;
   retain materialization required by external harnesses and legacy Pi SDK
   compatibility.

## Acceptance criteria

The revision is implemented only when:

1. `agent-harness-runtime` contains the POC-shaped custom loader and Pi runtime
   factory, with export-only barrels and no compiler adapter dependency.
2. Direct agent startup consumes only ASP semantic/source resolution and Pi's
   `ResourceLoader`; no generated Pi bundle is produced or read.
3. `asp run` launches the real Pi TUI by default for an `agent-harness` agent,
   and print/resume/dry-run behavior follows this proposal.
4. The exact `praesidium-loader` theme is loaded by the custom loader and is the
   initial TUI theme.
5. All Earendil Pi consumers resolve exact `0.84.3` from one coherent lock.
6. Broker OAuth/API-key inputs bind to `ModelRuntime` before session creation,
   and foreground and broker auth stores cannot substitute for one another.
7. Pi session replacement paths retain fresh ASP resources.
8. HRC broker behavior remains operational through the shared runtime.
9. Compiler-backed Claude Code and Codex CLI selections remain operational.
10. Parity, broker MATRIX, package, build, static, and real installed smoke gates
    pass with no direct-path materialization residue.

## Relationship to the active invariant

This revision reopened `agent-spaces.agent-harness-runtime-boundary` because the
deployed slice contradicted its no-generated-home predicate and because a TUI
is now a required product capability rather than a deferred option. Daedalus
approved the corrected design in `hrcchat#20779`; the amended active record was
ratified and pushed in commit `ef6dfaa`. It fixes the custom Pi
`ResourceLoader`, `AgentSessionRuntime`, caller-selected auth binding,
foreground TUI/print surface, exact Pi upgrade cohort, and validation
obligations established here.
