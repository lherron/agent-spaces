# Agent Scaffolding: `asp agents` Command Group

**Status:** proposed — awaiting Lance review
**Date:** 2026-07-08
**Author:** mable@agent-spaces

## Problem

The toolkit can scaffold a *space* (`asp repo new-space`, `asp spaces init` — both
registry-bound and legacy) but not an *agent*. Creating a new agent home today means
hand-copying an existing one under `~/praesidium/var/agents/<id>/` and editing it until it
works. The v2 agent-root contract is shipped and enforced (`validateAgentRoot` requires
`SOUL.md`, parses `agent-profile.toml` schemaVersion 1/2, allows optional `HEARTBEAT.md`),
but nothing user-facing *emits* a conforming root. Onboarding knowledge lives outside the
repo (`var/agents/AGENT_ONBOARDING.md`), and the only executable example is a test fixture
(`packages/config/src/__fixtures__/v2/agent-root/`).

Consequences: every new agent is folklore-driven, project-local agent roots (T-04141) have
no paved adoption path, and "build an agent" — the toolkit's headline verb — has no CLI
entry point.

## Proposal

Add an `asp agents` command group (plural — `asp agent` is taken by the positional
`<scope> <mode>` execution command and cannot grow subcommands without ambiguity).

### `asp agents init <agentId>`

Scaffold a valid v2 agent root and refuse to leave an invalid one behind.

- Placement: `--agents-root <path>` override; default is the canonical agents root. With
  `--project`, place under `<projectRoot>/agents/<agentId>/` (requires the `agents-root`
  key in `asp-targets.toml`, per T-04141).
- Emits:
  - `SOUL.md` — from a template (`--soul-template <path>` to override); identity, mission,
    and operating-notes sections with TODO markers.
  - `agent-profile.toml` — schemaVersion 2 minimal: `[identity]`, `priming_prompt` stub,
    `harnessDefaults` seeded from `--harness <id>` (default claude).
  - `spaces/` — empty agent-local spaces dir.
  - `HEARTBEAT.md` — only with `--with-heartbeat`.
- Exit path runs `validateAgentRoot` + profile parse on the result; failure deletes the
  partial scaffold and reports why.
- `--dry-run` prints the file plan without writing.
- Prints next steps: wire a target in `asp-targets.toml` or run
  `asp agent <id>@<project>:<task> query --dry-run`; note that ACP default-agent
  registration is a separate `acp project default-agent` step.

### `asp agents list`

Enumerate agent homes across the resolved search path
(`[<projectRoot>/agents, canonicalAgentsRoot]`), marking which root each resolves from and
flagging shadowed homes. `--json` for machine output.

### `asp agents validate <agentId|path>`

User-facing wrapper over `validateAgentRoot` + `agent-profile.toml` parse, with
`--hygiene` to chain into the existing `asp lint --hygiene <agentRoot>` pass. Today this
validation only fires deep inside resolution; surfacing it makes "is my agent well-formed?"
a one-liner and gives CI a hook.

### `asp agents where <agentId>`

Print the resolved agent root and which search-path entry won (debugging aid for
project-local shadowing).

## Implementation notes

- Single source of truth: the scaffold templates must be validated by the same code that
  gates runtime (`packages/config/src/resolver/agent-root.ts`,
  `core/config/agent-profile-toml.ts`). A round-trip test (scaffold → validate → resolve
  placement) prevents template drift.
- Template basis: promote the v2 fixture shapes into a `scaffold/` module in
  `spaces-config` (fixtures stay test-only); CLI command is a thin registrar in
  `packages/cli/src/commands/agents/`.
- `list`/`where` reuse the existing agents-root search-path resolution
  (`store/runtime-placement.ts`) — no new resolution logic.
- Tests: unit (scaffold output validity, force/exists behavior, project placement gating),
  integration-tests suite entry, CLI smoke via `--dry-run`.
- Docs: README "Hello World" gains the agent leg (`asp agents init`); cli-reference gains
  the group; space-authoring skill gets a sibling agent-authoring section or skill.

## Non-goals

- ACP registration (`acp project default-agent` remains the authoritative surface).
- HRC provisioning (first `hrcchat` turn provisions; `hrc start` headless is retired).
- Migration/normalization of existing agent homes (a later `asp agents validate --fix`
  could grow into this).
- Registry-based agent distribution.

## Open questions

1. Should `init` seed state dirs (`brain/`, `var/`) that real homes have but the contract
   doesn't require? Recommendation: no — emit only contract-required files; state dirs are
   runtime-owned.
2. Should `validate` fold hygiene lint in by default rather than behind `--hygiene`?
   Recommendation: opt-in first; flip after W4xx noise is measured on the live fleet.
3. Does the SOUL.md template live in-repo or resolve from
   `agents-root:///references/templates/` so the fleet's live conventions win?
   Recommendation: in-repo default with `--soul-template` escape hatch, revisit once
   template churn is observed.
