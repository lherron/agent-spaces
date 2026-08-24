# Praesidium Agent Harness

- **Status:** accepted; initial direct-harness implementation in progress
- **Date:** 2026-08-24
- **Author:** cody@agent-spaces

## Thesis

Praesidium should make a Praesidium-owned agent harness built on Pi's
coding-agent SDK the primary execution path while retaining the compiler for
agents that intentionally run through Claude Code or Codex CLI.

The compiler exists largely because agent-spaces translates its own agent model
into layouts and launch conventions owned by Codex, Claude, Pi, and other
harnesses. That translation remains useful for external harness compatibility,
but it is unnecessary when Praesidium owns the harness. Both paths should share
the same ASP configuration, composition, prompt, context, and skill logic.

The expected operating split is roughly 95% of agents using `agent-harness` and
5% using the compiler-backed Claude Code or Codex CLI paths. Those percentages
describe the intended shape of the system, not a routing quota.

The proposed execution paths are:

```text
ASP agent configuration
    -> shared ASP resolution
        |-> agent-harness-sdk -> Pi session -> agent-harness  (default)
        `-> compiler -> Claude Code or Codex CLI              (compatibility)
    -> HRC-operated runtime
```

There is no required compiled runtime plan, generated frontier-harness home, or
serialized intermediate definition between ASP configuration and the Pi
session. Normal resolved values inside the SDK are sufficient. The compiler may
continue producing those artifacts where an external harness requires them.

## Goals

- Give ASP/HRC a first-party execution path for the large majority of agents.
- Use the existing ASP agent specification and directory structure directly.
- Remove live ASPC compilation and generated harness homes from the default
  agent startup path.
- Retain compiler-backed Claude Code and Codex CLI execution for agents that
  explicitly select those harnesses.
- Share agent resolution, space composition, prompt/context assembly, and skill
  discovery between the direct and compiler-backed paths.
- Preserve HRC's ownership of runtime lifecycle and session routing.
- Reuse the working Pi integration already present in agent-spaces.
- Keep the first implementation small enough to dogfood with a real agent.

## Non-goals

- Reproduce every feature of every frontier harness before cutover.
- Eliminate the compiler or force every agent onto the first-party harness.
- Establish a new sandbox, credential system, provenance system, or package
  manager.
- Preserve incidental compiler output or byte-for-byte compiler behavior.
- Make the current broker protocol or process topology permanent.
- Freeze a broad public SDK API before the first-party harness settles.

## Proposed components

### `agent-harness-sdk`

`agent-harness-sdk` is the ASP-aware adapter around Pi's coding-agent session
API. It turns the existing agent configuration into a working Pi session.

Configuration resolution should live in shared ASP libraries rather than in the
SDK itself. The SDK and compiler should call the same code for agent profiles,
space composition, prompts, context, skills, and common provisioning values.
They should diverge only where they lower that shared meaning into different
execution environments. Code sharing should follow genuinely shared semantics;
it should not force Claude Code, Codex CLI, and Pi into a false lowest-common-
denominator model.

Its responsibilities are:

- Resolve the agent profile, project placement inputs, and selected spaces
  through existing ASP configuration libraries.
- Assemble the system prompt, project context, and reminder through existing
  ASP prompt/context logic.
- Make the resolved skills available to Pi.
- Configure the selected model, authentication, tools, and session behavior.
- Create or resume a Pi session.
- Expose the prompt, follow-up, steering, interrupt, and event operations needed
  by the executable.
- Translate Pi events into the harness-facing event model.

It should not generate configurations for Codex, Claude, or other harnesses. It
should not own HRC placement, runtime lifecycle, or durable messaging. It should
not reimplement configuration parsing already supplied by ASP packages.

Pi's mature coding-agent `createAgentSession` surface is the appropriate base
today. Pi's newer generic `AgentHarness` abstraction is currently incomplete for
important operations. This is a present implementation choice, not a permanent
architectural commitment. Keeping Pi usage concentrated in the SDK is useful
package design because it limits dependency churn, but it does not need to be a
durable platform law.

The initial SDK API should remain small. Conceptually it needs only operations
equivalent to:

```ts
loadAgent(options): ResolvedAgent
createSession(agent, options): AgentSession
```

The names and exact intermediate types should emerge from implementation. A
serialized `RuntimeDefinition`, content manifest, or public abstraction is not
required.

### `agent-harness`

`agent-harness` is the executable HRC launches or controls to run agent turns.
It should:

- Accept the agent identity and runtime inputs needed to load an agent.
- Create or resume an SDK session.
- Accept turns and follow-up input.
- Forward assistant, tool, status, and terminal events.
- Support steering, interruption, and shutdown as required by HRC.

The fastest implementation path is to compose the executable with the existing
harness broker because HRC already understands that integration. The broker is
migration scaffolding, not an architectural requirement. Once the direct
harness is working, its wire protocol and process topology can be simplified if
that produces a better system while preserving required HRC behavior.

A long-lived process is convenient for Pi sessions and continuation, but
process lifetime should remain an implementation choice. The product contract
is that HRC can operate the agent session, not that one specific process must
live for one specific duration.

## Ownership boundary

| Component                   | Owns                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------- |
| ASP configuration libraries | Agent profiles, space composition, prompt/context assembly, and validation         |
| `agent-harness-sdk`         | Construction and operation of a Pi-backed agent session                            |
| `agent-harness`             | The executable turn surface presented to HRC                                       |
| Compiler                    | Lowering shared ASP semantics into Claude Code or Codex CLI artifacts and launches |
| HRC                         | Runtime placement, lifecycle, session routing, supervision, and durable messaging  |

The direct harness path should receive semantic agent and runtime inputs rather
than an ASPC-produced frontier-harness process plan. The compatibility path may
continue receiving a compiled process plan because that translation is its
purpose. In both cases, the selected harness executes the agent; it does not
decide where an established scope lives or assume responsibility for cross-node
routing.

## Resource handling

Resource handling should use the simplest representation accepted by Pi:

- Pass system prompts directly as strings.
- Pass skill definitions or source directories directly when possible.
- Materialize temporary files only when Pi or a skill actually requires a
  filesystem layout.
- Fetch, cache, or install resources when existing ASP behavior or a concrete
  product requirement calls for it.
- Use the normal authentication mechanism appropriate to the selected model,
  including environment-based credentials when practical.
- Permit normal session-state and workspace writes.

No content-addressed resource store, sorted manifest, resource hash, provenance
record, immutable generation snapshot, or read-only startup rule is required by
this proposal.

A session will naturally receive some resolved prompt, skills, and configuration
when it is created. That is sufficient until a real requirement demonstrates the
need for hot reload, stronger snapshot behavior, caching, or resource identity.
Those features can be added in response to observed behavior rather than in
anticipation of it.

Duplicate resources should follow ASP's established composition and precedence
semantics. The harness should not introduce a new duplicate-name failure rule.
Pi's independent default discovery should not accidentally override ASP
composition, but ASP may intentionally include project-level, user-level, or
otherwise ambient resources when its specification defines that behavior.

These choices govern the direct Pi path. The compatibility compiler remains
free to materialize the files and directories required by Claude Code or Codex
CLI, using the same resolved ASP semantics as its input.

## Permissions and security

This project should not invent a new security boundary.

The harness runs with the privileges HRC gives it and preserves permission
behavior the product already exposes. Pi's normal tools can be used directly
unless a concrete requirement calls for mediation. Environment variables are a
valid credential transport when they fit the installed runtime.

This proposal does not require:

- An OS sandbox.
- Custom replacements for Pi tools.
- A new credential broker.
- Fail-closed resource acquisition.
- Additional audit or provenance machinery.
- Restrictions on runtime writes beyond existing platform and operating-system
  permissions.

Pi is not a sandbox. That becomes an actionable concern only if Praesidium
adopts a requirement to execute untrusted code inside a stronger containment
boundary. Such a threat model should be designed and validated separately
rather than approximated with restrictions that do not provide containment.

## Initial feature scope

The first useful implementation likely needs:

- System prompt and project context.
- Skills.
- Pi's normal tools.
- Model authentication.
- Multi-turn continuation.
- Steering and interrupt.
- Structured results.
- HRC-visible events.

Extensions, hooks, MCP, slash commands, and an interactive TUI do not need to
block the first real deployment. They are deferred capabilities, not forbidden
ones. Each should be added when a concrete agent or operator workflow needs it.

## Compiler compatibility path

The compiler should remain a supported execution path for the minority of
agents that explicitly use Claude Code or Codex CLI. Its durable purpose is
external-harness lowering: turning shared ASP semantics into the files,
directories, arguments, environment, and process description required by those
harnesses.

The compiler and direct harness should share ordinary libraries for:

- Agent and space resolution.
- Prompt assembly.
- Context-template evaluation.
- Skill discovery and composition.
- Common provisioning values.
- Configuration validation.
- Inspection and diagnostics.

The harness, compiler, and `asp inspect`-style commands should reuse the same
underlying logic wherever they need the same answer. Compiler-specific code
should begin where Claude Code or Codex CLI requires a different representation
or launch mechanism.

The reduction target is redundant or obsolete compiler machinery, not the
compiler itself:

- The primary `agent-harness` path no longer calls the compiler.
- Common ASP semantics are not independently implemented in the compiler and
  SDK.
- Compatibility profiles and drivers remain only for supported external
  harnesses.
- Generated homes, bundles, argv, and environment plans remain only where the
  selected external harness needs them.
- Drivers for harnesses Praesidium no longer intends to support can be removed.

## Migration

### 1. Extract shared ASP resolution

Identify the configuration, composition, prompt, context, skill, and common
provisioning logic currently embedded in the compiler. Move only that shared
meaning into ordinary ASP libraries consumed by both execution paths.

### 2. Extract the proven Pi session integration

Move the working Pi session construction from the current broker Pi driver into
`agent-harness-sdk`. Preserve behavior while establishing the new package
boundary.

### 3. Load ASP configuration directly

Replace the SDK's compiled bundle input with direct calls to the shared ASP
libraries. Keep the compiler on those same libraries, followed by its
Claude/Codex-specific lowering. Do not add a serialized replacement for the
compiled plan to the direct path unless implementation demonstrates a need.

### 4. Build the executable

Build `agent-harness` around the SDK. Reuse the existing broker connection for
the first HRC integration so the work does not simultaneously redesign session
transport.

### 5. Dogfood a real agent

Run Cody through the new executable using the real agent profile, real project
context, real skills, real tools, and real model authentication.

Validate outcomes:

- The intended prompt and project context reach the model.
- The intended skills are available.
- Tool execution works.
- Multiple turns retain usable context.
- Steering and interruption work.
- Structured results and runtime events reach HRC correctly.
- HRC can start, stop, and reconnect according to current product behavior.

The migration does not require byte-for-byte prompt parity, resource hashes, or
preservation of incidental compiler behavior. Intentional improvements are not
migration failures.

### 6. Make the direct harness the default

Make the first-party harness the default for ordinary agents after the installed
path has been exercised in real use. Keep explicit Claude Code and Codex CLI
selections on the compiler path. Delete duplicated resolution code and
unsupported drivers, while continuing to maintain the compiler behavior needed
by the expected minority of external-harness agents.

## Risks

### Recreating the compiler inside the SDK

The largest risk is recreating the compiler's intermediate machinery with
manifests, snapshots, compatibility layers, and migration gates under a new
package name. The SDK should directly compose existing ASP resolution with Pi
session construction.

### Semantic drift between the two paths

The direct and compiler-backed paths will drift if each owns its own prompt,
space, skill, or provisioning interpretation. Shared ASP resolution is the most
important code-sharing boundary in this proposal. Tests should exercise that
shared logic once, then separately test Pi, Claude Code, and Codex CLI lowering.

### Expanding the first cut into harness parity

Trying to reproduce every extension, command, hook, MCP, and TUI feature before
dogfooding would delay the evidence that matters: whether a real ASP/HRC agent
can work effectively through the owned harness.

### Coupling the design to unfinished Pi abstractions

The generic Pi harness API is not yet a sufficient base. Depending on the
working coding-agent API behind a small local adapter keeps the project moving
without designing around unfinished surfaces.

### Coupling shared semantics to external-harness output

Sharing code does not mean making the SDK consume compiler plans or making the
compiler the canonical representation of an agent. Shared libraries should
express ASP semantics; each execution path should own its own lowering from
those semantics.

## Recommendation

Build both proposed components.

`agent-harness-sdk` should directly turn ASP configuration into a Pi session.
`agent-harness` should make that session operable by HRC. Reuse the current
broker only as the shortest integration path, then simplify it separately if
the running system shows that doing so is valuable.

Keep the compiler as the compatibility path for agents that explicitly select
Claude Code or Codex CLI. Both paths should share ASP resolution code wherever
the underlying semantics are actually the same. The system should optimize for
the expected 95% direct-harness majority without degrading the supported 5%
external-harness minority.

The first milestone is not a comprehensive harness platform. It is one real ASP
agent completing real multi-turn work through HRC without a live compiler or a
frontier-harness adapter, while an existing Claude Code or Codex CLI agent still
runs through the compiler-backed compatibility path.

## Relationship to the active invariant

This proposal was ratified by `hrcchat#20722` and is governed by the active
`agent-spaces.agent-harness-runtime-boundary` invariant. The initial direct
implementation preserves the broker as HRC transport scaffolding while moving
ASP resolution and Pi session construction behind the first-party SDK boundary.
