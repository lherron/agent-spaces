# Project-Local Agent Config Roots (T-04141, Phase 1 proposal)

**Status:** proposed — awaiting approval from clod@archagent:scopechange (Lance-delegated)
**Date:** 2026-06-10
**Author:** clod@agent-spaces

## Problem

archagent needs a cohort of agent configs (experiment personas, bench variants, daedalus
priming variants, empirical-run roles) that live inside `~/praesidium/archagent`, versioned
with that repo. Today the agents root is a single global directory: `getAgentsRoot()`
(`packages/config/src/store/asp-config.ts:16-24`) resolves **one** root via
`ASP_AGENTS_ROOT` env → `agents-root` in `$ASP_HOME/config.toml` → convention fallback
`~/praesidium/var/agents`, and agentId → config is a bare `join(agentsRoot, agentId)`
(`packages/config/src/store/runtime-placement.ts:155-160`). The only choices today are
forking the whole root or polluting the canonical one.

**Hard constraint (Lance, via C-04049):** daedalus stays canonical in `var/agents` and is
the entry point to archagent capabilities. Canonical→local is the *primary* flow: a
canonical agent running under `@archagent` scopes must be able to reach the project-local
cohort (delegate to local personas, load project-local skills). Do not move or duplicate
daedalus.

## Current semantics (research summary)

Facts established by the Phase 1 survey, with the load-bearing ones for the design:

- **Root resolution** is centralized in `spaces-config` (`asp-config.ts:getAgentsRoot`),
  consumed by both the asp CLI and hrc-runtime (hrc-cli `cli.ts:680-703`, hrcchat-cli
  `resolve-intent.ts:114-118`). hrc computes `agentRoot = join(getAgentsRoot(), agentId)`
  itself before calling `resolveAgentPlacementPaths()`.
- **No registry**: agents are directories; an agent exists iff
  `<agentsRoot>/<agentId>/agent-profile.toml` exists.
- **No projectId→path registry either**: `projectRoot` is resolved by marker walk-up
  (`asp-targets.toml`, bounded by git root) from cwd, or `ASP_PROJECT_ROOT_OVERRIDE`
  (`runtime-placement.ts:162-183`). A project is "in scope" exactly when its root is
  discoverable from the placement.
- **Shared root files** live at the root level: `AGENT_MOTD.md`, `USER.md`,
  `conventions.md`, `context-template.toml`, `context-lock.json`.
- **Materialized homes** are keyed `ASP_HOME/codex-homes/<project>_<agent>/bundles/.versions/<fingerprint>/`
  (`install.ts:640-837`); the fingerprint includes identity (agentId, projectId,
  frontend) and per-artifact content hashes but **not** the agents-root path — bundles
  are already portable across roots. Agent-local components are copied in as a synthetic
  plugin keyed by `basename(agentRoot)` (`install.ts:855-914`).
- **Skills** enter the home via space plugins + the agent-local synthetic plugin;
  `discoverSkills()` (`materialize-refs.ts:301-330`) enforces name uniqueness across all
  plugins of one composed target.
- **Spaces composition** already supports layering: per-target `compose` lists,
  `compose_mode = "merge" | "replace"`, agent-profile `spaces.base`/`byMode`, MCP
  later-wins merge. Space refs are root-independent (resolved via the spaces repo /
  snapshots), so a local agent composing canonical spaces needs no new machinery.
- **Single-root assumptions** (full list in research): the `join(agentsRoot, agentId)`
  lookup; `findProjectMarker`'s agents-root boundary guard (`runtime-placement.ts:85-89`);
  hrc-cli's own join + existsSync (`hrc-runtime/packages/hrc-cli/src/cli.ts:680-693`);
  brain cache keys already include the explicit `agentRoot` path (safe).
- **archagent today** has zero agent infrastructure — it is a run archive driven through
  `clod@archagent:<slug>` scopes; everything agent-shaped lives in `var/agents`.

## Design alternatives

### A. Project-declared overlay root (recommended)

The consuming repo declares its local agents root in the file that already marks it as a
project — `asp-targets.toml`:

```toml
schema = 1
agents-root = "agents"   # relative to the project root
```

Resolution becomes a **search path conditioned on the placement's project**:

```
roots(placement) = [ <projectRoot>/<agents-root>  (iff declared) ,  canonicalAgentsRoot ]
```

`resolveAgentRoot(agentId, placement)` returns the first root containing
`<agentId>/agent-profile.toml`. All agents running under that project's scopes — canonical
or local — see the same search path. That gives the required canonical→local flow with
zero changes to daedalus's config: `daedalus@archagent` delegates to
`bencher@archagent:run-x` and hrc resolves `bencher` from `archagent/agents/` because the
scope's project is archagent; the same handle under `@wrkq` would (correctly) fail.

- Versioned with the repo, self-contained, no global config edits, no env churn.
- Scope-conditioned visibility falls out of the existing placement model: the local root
  activates exactly when `projectRoot` is resolvable (marker walk-up / override) — the
  same precondition project targets already have.

### B. Layered roots via env path-list (`ASP_AGENTS_ROOTS=dir1:dir2`)

Global ordered list of roots, searched first-hit.

- Rejected as the primary mechanism: visibility is not project-conditioned (archagent's
  experiment personas would be resolvable from every project), the config is not
  versioned with the consuming repo, and every shell/plist/launchd surface needs the env
  set consistently (the hrc-server plist would silently miss it).

### C. Per-project agent registry manifest (explicit `[agents]` table)

`asp-targets.toml` lists each local agent explicitly, optionally with per-agent source
paths or `extends = "canonical-agent"` inheritance.

- More expressive (per-agent extension/override of a canonical profile) but strictly more
  machinery: a second declaration surface that can drift from the directory truth, a new
  inheritance semantics to define and validate, and nothing archagent needs now requires
  it. The cohort composes shared behavior the same way canonical agents do — via spaces.
- Deferred, not rejected: Alternative A's `agents-root` key leaves room to add an
  `[agents]` table later if per-agent `extends` becomes a real need.

### D. hrc-side projectId→root mapping (ACP project registry or hrc config)

hrc resolves a per-project root from its own config; ASP stays single-root.

- Rejected: splits the truth across repos — `asp` CLI used directly inside archagent
  would not see the local agents; every ASP surface (doctor, list, agent, self) would
  disagree with hrc. Root resolution belongs in `spaces-config` where both consumers
  already get it.

## Recommended design (A) — full specification

### Declaration

- New optional key in `asp-targets.toml`: `agents-root = "<path>"`, relative to the
  project root (absolute and `~` allowed but discouraged). Parsed in `ProjectManifest`
  (`targets.ts`), ignored by older readers (additive, schema stays 1).
- The directory mirrors the canonical layout: `<agentId>/agent-profile.toml` (+ optional
  `SOUL.md`, `skills/`, `memory/`), and may carry root-level shared files.

### Precedence and conflict rules

1. **Whole-agent atomic shadowing.** An agent resolves entirely from the first root in
   the search path whose `<agentId>/agent-profile.toml` exists. No per-file merging
   across roots for agent dirs — a local `clod/` would shadow canonical clod completely
   for that project's scopes. This keeps "which file am I running" answerable.
2. **Local wins, with diagnostics.** `asp doctor` (and `asp list`) report shadowed
   agents: `agent 'clod' resolved from <project>/agents (shadows var/agents/clod)`.
   Shadowing canonical agents is legal but loud. archagent simply does not create a
   `daedalus/` dir, satisfying the daedalus constraint by construction.
3. **Root-level shared files resolve per-file, local → canonical.** `AGENT_MOTD.md`,
   `USER.md`, `conventions.md`, `context-template.toml` fall back to the canonical root
   when absent locally, so a local root does not have to copy platform boilerplate.
   (Agent dirs atomic, shared files per-file: agent config is identity, shared files are
   platform substrate.)
4. **Extension is via spaces, not roots.** A local agent composes shared capability the
   same way canonical agents do (`spaces.base = ["space:defaults@dev", ...]`). No
   `extends` between agent profiles in v1.

### Skills resolution

- A local agent's `skills/` rides the existing agent-local synthetic plugin
  (`materializeAgentLocalComponents`) untouched — it already takes an arbitrary
  `agentRoot`. `basename(agentRoot)` remains the agentId, so plugin keying is unchanged.
- Canonical agent loading project-local skills (daedalus@archagent): use the existing
  project-target layer — archagent's `asp-targets.toml` declares
  `[targets.daedalus] compose_mode = "merge"` adding project-local spaces (project-class
  spaces are already a supported space classification in `materializeSpaceEntry`). This
  is existing machinery; the proposal adds nothing here beyond documenting the pattern.
- Skill name collisions across plugins keep failing loudly via `discoverSkills()`.

### Materialized runtime homes

- No layout change. Homes stay `codex-homes/<project>_<agent>/bundles/.versions/<fp>/`;
  the scope already includes the project, so `archagent_bencher` cannot collide with any
  other project's `bencher`. Fingerprints already hash content + identity, not root
  paths, so local-vs-canonical configs naturally produce distinct versions.
- GC/pruning untouched: ASP_HOME remains single; only agent *sources* gain a second root.
- `AGENTCHAT_ID = basename(agentRoot)` (`prepare-cli-runtime.ts:362`) still equals
  agentId. Compiled plans (`assemblePlan`) carry bundle paths, not root paths — no
  contract change to `agent-runtime-plan/v1`, lockedEnv, or dispatchEnv.

### Env-var story

- **`ASP_HOME` unchanged** — it is the store (snapshots/cache/codex-homes), not the
  agents root; it never had agent-identity semantics to lose.
- **`ASP_AGENTS_ROOT` stays** with its exact current meaning: override for the
  *canonical* root. It does not become a path list.
- **No new env var** in the happy path. The project-local root is declared in the repo
  and activated by placement. (Test escape hatch: existing `--agent-root` flag and
  explicit `agentRoot` plumbing already bypass resolution.)

### Implementation surface (blast radius)

agent-spaces (`spaces-config` + CLI), the entire intended change:

- `asp-config.ts`: add `getAgentRootsForProject(projectRoot?)` returning the ordered
  search path (reads the project manifest's `agents-root`; falls back to
  `[getAgentsRoot()]`).
- `runtime-placement.ts`: `resolveAgentPlacementPaths()` resolves `agentRoot` through the
  search path instead of one join (it already receives `projectId`/`projectRoot`/`cwd`).
  `findProjectMarker`'s boundary guard treats **every** root in the path as a
  non-crossable boundary (a local agents dir inside the repo must not be mistaken for a
  project root; note the guard must except the project root itself, which *contains* the
  local agents dir).
- Shared-file loading (`self`/context assembly): per-file fallback local → canonical.
- CLI surfaces: `asp list`/`agent`/`doctor` enumerate the union (dedup by agentId,
  local-first) and print provenance + shadow warnings.
- `targets.ts`: parse + validate the new `agents-root` key.

hrc-runtime (small, mostly deletion):

- hrc-cli `cli.ts:680-693` and hrcchat-cli `resolve-intent.ts` currently do their own
  `join(getAgentsRoot(), agentId)` + existsSync before calling
  `resolveAgentPlacementPaths`. Fix: stop pre-joining; pass `agentId` (+ projectId/cwd)
  and let the shared resolver return the winning `agentRoot`. The not-found error message
  lists all searched roots.
- Everything downstream already keys on the explicit `agentRoot` path (brain cache
  `hostSessionId\0scopeRef\0agentRoot`, placement, bundle refs) — no key-shape changes.
- Ships via the normal Verdaccio dev-publish loop (`sync:asp`, no version pinning).
- hrc-server plist needs no change (no new env).

ACP / gateway: none — handles and scopeRefs are unchanged; only which directory backs an
agentId for a given project scope changes.

### Failure modes considered

- **Same agentId active in both roots under one project**: precedence picks local;
  doctor warns. Deterministic, observable.
- **Local root declared but missing**: doctor error; resolution skips to canonical with a
  warning (declared-but-absent should not brick canonical agents).
- **projectRoot not derivable** (cwd outside the project, no override): local root simply
  doesn't activate — identical to today's behavior for project targets. Documented, not
  silent: hrc's agent-not-found error names the roots it searched.
- **Worktrees** (`under-construction/*`): marker walk-up finds the worktree's own
  `asp-targets.toml`, so a worktree of archagent sees its *own* checked-out cohort —
  desirable for experiments on the cohort itself.

### Migration

- Fully backward compatible: no project declares `agents-root` → search path is
  `[canonical]`, byte-identical behavior. No action for existing single-root users.
- archagent adoption: add `agents-root = "agents"` to a new `archagent/asp-targets.toml`
  (also upgrades archagent from implicit-git-root project to explicit marker), create
  `archagent/agents/<persona>/agent-profile.toml` per cohort member.
- Rollback: delete the key; local agents become invisible to resolution.

### Open questions (for the approval reply)

1. Should a local root be able to declare root-level shared-file *overrides* (e.g. a
   project-specific `AGENT_MOTD.md`) in v1, or is per-file fallback (read-through only,
   no local override) enough to start? Proposal as written allows local override since
   it falls out of per-file local-first resolution; flagging in case read-through-only is
   preferred for v1.
2. `asp agent new --project` convenience for scaffolding local agents — v1 or follow-up?

## Acceptance trace (task requirements → sections)

- precedence/conflict rules → "Precedence and conflict rules"
- skills resolution → "Skills resolution"
- materialized runtime homes → "Materialized runtime homes"
- env story / ASP_HOME fate → "Env-var story" (ASP_HOME unchanged, ASP_AGENTS_ROOT
  retained, no path-list env)
- migration → "Migration"
- hrc-runtime blast radius → "Implementation surface" (two call sites simplified, no
  key-shape or plist changes, ships via Verdaccio loop)
- canonical→local primary flow (C-04049) → search path is scope-conditioned for ALL
  agents in the project; daedalus untouched in var/agents
