# Praesidium Agent Harness

- **Status:** draft; Cody's unratified proposal
- **Date:** 2026-08-24
- **Author:** cody@agent-spaces

## Thesis

Praesidium should replace the live ASP compiler-to-frontier-harness path with a
Praesidium-owned agent harness built on Pi's coding-agent SDK.

The compiler exists largely because agent-spaces translates its own agent model
into layouts and launch conventions owned by Codex, Claude, Pi, and other
harnesses. Once Praesidium owns the harness, that translation is unnecessary.
The harness can read the existing ASP agent configuration, construct a Pi
session directly, and expose that session to HRC.

The proposed execution path is:

```text
ASP agent configuration
    -> agent-harness-sdk
    -> Pi coding-agent session
    -> agent-harness
    -> HRC
```

There is no required compiled runtime plan, generated frontier-harness home, or
serialized intermediate definition between ASP configuration and the Pi
session. Normal resolved values inside the SDK are sufficient.

## Goals

- Give ASP/HRC one first-party execution path instead of a matrix of frontier
  harness adapters.
- Use the existing ASP agent specification and directory structure directly.
- Remove live ASPC compilation, generated harness homes, route selection, and
  harness-specific process planning from agent startup.
- Preserve HRC's ownership of runtime lifecycle and session routing.
- Reuse the working Pi integration already present in agent-spaces.
- Keep the first implementation small enough to dogfood with a real agent.

## Non-goals

- Reproduce every feature of every frontier harness before cutover.
- Establish a new sandbox, credential system, provenance system, or package
  manager.
- Preserve incidental compiler output or byte-for-byte compiler behavior.
- Make the current broker protocol or process topology permanent.
- Freeze a broad public SDK API before the first-party harness settles.

## Proposed components

### `agent-harness-sdk`

`agent-harness-sdk` is the ASP-aware adapter around Pi's coding-agent session
API. It turns the existing agent configuration into a working Pi session.

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

| Component                   | Owns                                                                              |
| --------------------------- | --------------------------------------------------------------------------------- |
| ASP configuration libraries | Agent profiles, space composition, prompt/context assembly, and validation        |
| `agent-harness-sdk`         | Construction and operation of a Pi-backed agent session                           |
| `agent-harness`             | The executable turn surface presented to HRC                                      |
| HRC                         | Runtime placement, lifecycle, session routing, supervision, and durable messaging |

HRC should pass semantic agent and runtime inputs rather than an ASPC-produced
frontier-harness process plan. The harness should execute the selected agent; it
should not decide where an established scope lives or assume responsibility for
cross-node routing.

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

## What remains of the compiler

The live compiler path can disappear while useful configuration logic survives
as ordinary libraries. The harness still needs:

- Agent and space resolution.
- Prompt assembly.
- Context-template evaluation.
- Configuration validation.
- Inspection and diagnostics.

The harness and `asp inspect`-style commands should call the same underlying
logic. Keeping that logic does not require preserving the runtime compiler or
its process-plan contract.

The retirement target is:

- Harness route selection.
- Frontier-harness compatibility profiles.
- Generated harness homes and bundles.
- Harness-specific argv and environment plans.
- Compiler service calls in the launch path.
- Drivers for harnesses Praesidium no longer intends to run.

## Migration

### 1. Extract the proven Pi session integration

Move the working Pi session construction from the current broker Pi driver into
`agent-harness-sdk`. Preserve behavior while establishing the new package
boundary.

### 2. Load ASP configuration directly

Replace the compiled bundle input with direct calls to the existing ASP
configuration, prompt, context, and skill libraries. Do not add a serialized
replacement for the compiled plan unless implementation demonstrates a need.

### 3. Build the executable

Build `agent-harness` around the SDK. Reuse the existing broker connection for
the first HRC integration so the work does not simultaneously redesign session
transport.

### 4. Dogfood a real agent

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

### 5. Cut over and delete

Make the first-party harness the default execution path. Remove live compiler
and frontier-driver machinery after the installed path has been exercised in
real use. Retain configuration and inspection functions that still have users.

## Risks

### Recreating the compiler inside the SDK

The largest risk is replacing the current compiler with manifests, snapshots,
intermediate schemas, compatibility layers, and migration gates under a new
package name. The SDK should directly compose existing ASP resolution with Pi
session construction.

### Expanding the first cut into harness parity

Trying to reproduce every extension, command, hook, MCP, and TUI feature before
dogfooding would delay the evidence that matters: whether a real ASP/HRC agent
can work effectively through the owned harness.

### Coupling the design to unfinished Pi abstractions

The generic Pi harness API is not yet a sufficient base. Depending on the
working coding-agent API behind a small local adapter keeps the project moving
without designing around unfinished surfaces.

### Losing useful inspection with the compiler

Deleting the compiler package must not accidentally delete the only way to
explain the resolved agent. Inspection should consume the same configuration
logic as the harness, without requiring a compiled launch plan.

## Recommendation

Build both proposed components.

`agent-harness-sdk` should directly turn ASP configuration into a Pi session.
`agent-harness` should make that session operable by HRC. Reuse the current
broker only as the shortest integration path, then simplify it separately if
the running system shows that doing so is valuable.

The first milestone is not a comprehensive harness platform. It is one real ASP
agent completing real multi-turn work through HRC without a live compiler or a
frontier-harness adapter.

## Relationship to the active invariant

This document is Cody's unratified proposal. It intentionally removes several
constraints from the current
`agent-spaces.agent-harness-runtime-boundary` invariant. It does not revise or
supersede that invariant. If this proposal is accepted, durable architecture
records should be reconciled in a separate action.
