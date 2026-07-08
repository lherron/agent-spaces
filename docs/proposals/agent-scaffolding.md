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
- Emits (contract-required files only by default):
  - `SOUL.md` — from a template (`--soul-template <path>` to override); identity, mission,
    and operating-notes sections with TODO markers.
  - `agent-profile.toml` — schemaVersion 2 minimal: `[identity]`, `priming_prompt` stub,
    `harnessDefaults` seeded from `--harness <id>` (default claude).
  - `spaces/` — empty agent-local spaces dir.
- Opt-in build-out flags:
  - `--with-heartbeat` — emit `HEARTBEAT.md`.
  - `--with-skills` — emit `skills/` with an example `SKILL.md`.
  - `--with-starter-space` — scaffold an example agent-local space under
    `spaces/<agentId>-ops/`.
- Never emits `brain/` or a `[brain]` profile section — decommissioned (T-04978 Phase 4;
  the profile parser rejects `[brain]` as an unknown key).
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

User-facing wrapper over `validateAgentRoot` + `agent-profile.toml` parse. Hygiene lint
(`asp lint --hygiene <agentRoot>`) runs by default; `--no-hygiene` skips it. Today this
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

## Resolved questions (Lance, 2026-07-08)

1. **State dirs:** emit contract-required files only, with `--with-*` flags for optional
   build-out (see `init` spec above). `brain/` is decommissioned and must never be
   scaffolded.
2. **Hygiene lint in `validate`:** default-on from the start; `--no-hygiene` to skip.
3. **Template placement:** in-repo default with `--soul-template` escape hatch.

## Anticipated change: SOUL → persona naming

Lance plans to rename the soul concept to *persona* (consistent with the existing
`asp self memory` persona target). The scaffolder should keep the reserved filename in one
shared constant with `validateAgentRoot` so the rename lands in a single place, and the
template/flag naming (`--soul-template`) should be revisited when that change ships.
