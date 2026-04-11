# ScopeRef Cleanup: Remove `app:` Prefix, Split Agent Sessions from Managed Windows

## Problem

HRC's data model forces every host context through a single scope-bearing session
model. Non-agent windows (scratchpad terminals, TUIs) get synthetic
`scopeRef = app:${appId}` values because `sessions` requires `scope_ref` +
`lane_ref`. This violates the acp-spec, which defines exactly 5 canonical
`ScopeRef` forms — all `agent:`-prefixed — and explicitly excludes app-scoped
identifiers from routing.

The practical consequence: when `hrc run larry` launches a session under
`scopeRef: app:hrc-cli`, and animata looks for larry under
`scopeRef: app:animata:animata:<hash>`, they find different sessions despite
targeting the same agent. The agent's actual runtime is invisible to other
consumers.

## Design Principles

1. All `scopeRef` values MUST be canonical agent-scope refs (`agent:...`).
   No `app:`, no synthetic prefixes, no exceptions.
2. Non-agent windows (scratchpad terminals, TUIs, command sessions) are NOT
   agent sessions. They must not have a `scopeRef` at all.
3. `appManagedSessions` remains as an alias/ownership layer for agent sessions
   only (kind: `harness`). Command flows move to managed windows.
4. No backward compatibility with `app:` scopeRefs. Hard fail on any
   non-canonical stored scopeRef (not just `app:` — any form that fails
   `validateScopeRef()` from `agent-scope`).

## Architecture: Two Distinct Models

### Agent Sessions (canonical identity)

- `HrcSessionRecord` always carries a validated canonical `sessionRef`
  from agent-scope.
- `hrc-core/selectors.ts` validates scopeRefs via `validateScopeRef()` from
  the `agent-scope` package.
- `appManagedSessions` is an alias/ownership layer for agent sessions only.
  Multiple aliases (from different apps) can point at the same canonical
  session via `activeHostSessionId`.
- Alias creation MUST check canonical continuity first — if a host session
  already exists for that `sessionRef`, create the alias pointing at the
  existing `activeHostSessionId` instead of creating a new host session.
- Conflict rule: if an existing alias already points at host session A, but
  the caller ensures with a `sessionRef` that resolves to host session B,
  return 409.
- After the split, `HrcManagedSessionKind` for `appManagedSessions` is
  `harness`-only. `command` is no longer a valid kind here.

### Managed Windows (new first-class concept)

- Separate model keyed by `(appId, windowKey)`.
- No `scopeRef`, no `laneRef`, no agent-scope validation.
- Used for command/scratchpad/TUI terminals.
- Own spec, status, generation lifecycle.
- References a `host_contexts` row (see Shared Substrate) for runtime support.
- Full operational surface: ensure, remove, list, capture, attach,
  literal-input, interrupt, terminate, clear-context/relaunch.
- **Clear-context semantics:** For windows, clear-context restarts the
  runtime within the same `host_context_id`. No identity rotation. Windows
  do not have canonical continuity semantics, so a stable host context is
  simpler for bridges/surfaces/runtime history. (Agent sessions continue to
  rotate to a new host session + continuity entry on clear-context.)

### Shared Substrate: `host_contexts`

The current schema has all runtime infrastructure FK through
`sessions(host_session_id)`, and `sessions` requires non-null `scope_ref` +
`lane_ref`. This means managed windows cannot host runtimes without either
fake scope refs or a substrate refactor.

Solution: introduce a `host_contexts` table as the canonical-neutral
substrate that runtimes, launches, runs, events, local bridges, and surface
bindings FK to. Both `sessions` and `managed_windows` reference a
`host_context_id`.

```
host_contexts
  └─> runtimes        (FK host_context_id)
  └─> launches        (FK host_context_id)
  └─> runs            (FK host_context_id)
  └─> events          (FK host_context_id)
  └─> local_bridges   (FK host_context_id)
  └─> surface_bindings (FK host_context_id)

sessions              (FK host_context_id, has scope_ref + lane_ref)
managed_windows       (FK host_context_id, no scope_ref)
```

This preserves the invariant that agent sessions always have canonical scope
identity, while windows get runtime support without fake scope refs.

### Core Type Implications

`HrcRuntimeSnapshot` and `HrcEventEnvelope` currently require non-null
`scopeRef` + `laneRef`. With the substrate split:

- Agent runtimes/events: `scopeRef` + `laneRef` populated from the owning
  session.
- Window runtimes/events: `scopeRef` + `laneRef` are `null` / absent.

These fields become optional on the core types. The alternative (separate
agent-runtime vs window-runtime types) is cleaner but higher churn. The
optional-field approach is pragmatic for the initial cut.

## Shared-Alias Lifecycle (required for MVP)

The motivating bug IS "animata can't find larry's session launched by
hrc-cli." That requires alias sharing to work from day one.

- **Create:** `ensureAppSession` with `sessionRef` checks canonical
  continuity. If a host session exists for that `sessionRef`, the new alias
  points at it. No duplicate host sessions for the same canonical identity.
- **Clear-context:** Rotating a host session updates ALL aliases bound to
  that `activeHostSessionId`, not just one inferred alias.
- **Remove:** Removing one alias does NOT tear down the runtime if other
  active aliases still reference the same host session. Only tear down when
  no active aliases remain (or caller explicitly requests destruction).

## Deployment Model

Phases 1-6 are an **atomic cutover**, not independently shippable
increments. Phase 3 makes `sessionRef` required on app-session creation,
which breaks command callers. Phase 5e introduces the replacement window
API. These must land together. The phases below are logical ordering for
implementation within a single branch, not separate releases.

Phase 7 (cleanup) can ship independently after the cutover.

---

## Phase 1: Substrate Refactor — `host_contexts` Table

**Goal:** Decouple runtime infrastructure from scope-bearing sessions so
that both agent sessions and managed windows can host runtimes.

### 1a: New `host_contexts` Table

- `packages/hrc-store-sqlite/src/migrations.ts`
  - New migration: `CREATE TABLE host_contexts`:
    ```sql
    CREATE TABLE host_contexts (
      host_context_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,  -- 'session' | 'window'
      created_at TEXT NOT NULL
    );
    ```
  - `kind` indicates what owns this context. Informational, not a hard
    routing key.

**Ownership cardinality:** A `host_context_id` is owned by exactly one
canonical session OR one managed window, never both. Enforce via UNIQUE
constraints:
- `sessions.host_context_id` — UNIQUE
- `managed_windows.host_context_id` — UNIQUE

This prevents the substrate from becoming another aliasing layer.

### 1b: Retarget Runtime Infrastructure FKs

- Same migration (or follow-up migration):
  - Add `host_context_id` column to `runtimes`, `launches`, `runs`,
    `events`, `local_bridges`, `surface_bindings`.
  - Populate `host_context_id` from existing `host_session_id` values
    (for existing data, `host_context_id = host_session_id`).
  - For each existing session, insert a corresponding `host_contexts` row.
  - Once populated, make `host_context_id` NOT NULL.
  - **Make legacy columns nullable:** `host_session_id`, `scope_ref`, and
    `lane_ref` on substrate tables (`runtimes`, `runs`, `events`, etc.)
    must become nullable in this migration. Without this, window-backed
    rows cannot be persisted — they have no session identity. Agent-backed
    rows continue to populate these columns; window-backed rows leave them
    NULL.
  - Keep `host_session_id` on these tables during transition for backward
    compat within the atomic branch. Remove in Phase 7.

### 1c: Core Type Updates

- `packages/hrc-core/src/contracts.ts`
  - `HrcRuntimeSnapshot`: make `scopeRef` and `laneRef` optional
    (`scopeRef?: string`, `laneRef?: string`).
  - `HrcEventEnvelope`: make `scopeRef` and `laneRef` optional.
  - Add `hostContextId: string` to both types.

- `packages/hrc-store-sqlite/src/repositories.ts`
  - `RuntimeRepository`, `LaunchRepository`, `RunRepository`,
    `EventRepository`: add `hostContextId` to inserts/queries.
  - Bridge and surface binding repos: same treatment.

---

## Phase 2: Canonicalize `hrc-core` Validation

**Goal:** Make `HrcSessionRef` reject non-canonical scopeRefs at the parsing
boundary.

### Files

- `packages/hrc-core/src/selectors.ts`
  - `splitSessionRef()` (lines 40-71): After splitting `scopeRef` from the
    `<scopeRef>/lane:<laneRef>` format, validate `scopeRef` via
    `validateScopeRef()` from `agent-scope`. Hard fail with a descriptive
    error if validation fails.
  - `normalizeSessionRef()` (lines 73-77): Inherits stricter validation
    from `splitSessionRef`.
  - `parseSelector()` (lines 79-110): No changes needed — delegates to
    `normalizeSessionRef`.

### Tests

- Update `hrc-core` selector tests to assert rejection of `app:foo/lane:bar`,
  `project:foo/lane:bar`, and other non-canonical forms.
- Confirm that all 5 canonical forms pass: `agent:x`, `agent:x:project:y`,
  `agent:x:project:y:role:r`, `agent:x:project:y:task:t`,
  `agent:x:project:y:task:t:role:r`.

---

## Phase 3: Contract Changes — Require `sessionRef`, Introduce Window Contracts

**Goal:** Agent-backed app-session creation surfaces carry canonical session
identity. Window contracts are defined for command/scratchpad/TUI flows.

### 3a: App-Session Contracts (Agent-Only)

- `packages/hrc-core/src/http-contracts.ts`
  - `EnsureAppSessionRequest` (lines 211-220): Add required field
    `sessionRef: HrcSessionRef`. Top-level identity, not nested in `spec`.
  - `ApplyAppManagedSessionInput` (lines 268-273): Add required field
    `sessionRef: HrcSessionRef`.
  - `HrcAppSessionSpec`: remove `kind: 'command'`. Only `kind: 'harness'`
    is valid for app-managed sessions after the split.

### 3b: Window Contracts (New)

- `packages/hrc-core/src/http-contracts.ts`
  - `EnsureWindowRequest`: `{ selector: { appId, windowKey }, spec: WindowSpec, label?, metadata?, restartStyle?, forceRestart? }`
  - `RemoveWindowRequest`: `{ selector: { appId, windowKey }, terminateRuntime?: boolean }`
  - `ListWindowsRequest`: `{ appId, includeRemoved? }`
  - `CaptureWindowRequest`: `{ selector: { appId, windowKey } }` — GET semantics (read-only)
  - `AttachWindowRequest`: `{ selector: { appId, windowKey } }` — GET semantics (read-only)
  - `WindowLiteralInputRequest`: `{ selector: { appId, windowKey }, text: string }` — matches existing app-session `text` field
  - `InterruptWindowRequest`: `{ selector: { appId, windowKey } }`
  - `TerminateWindowRequest`: `{ selector: { appId, windowKey } }`
  - `ClearWindowContextRequest`: `{ selector: { appId, windowKey }, relaunch? }` — restarts runtime in same host context (no identity rotation)
  - `WindowSpec`: `{ kind: 'command', command: string[] }`

### Validation

- Server-side parsing of `EnsureAppSessionRequest` and
  `ApplyAppManagedSessionInput` must validate `sessionRef` via the
  strengthened `normalizeSessionRef` from Phase 2.
- Window contracts have no `sessionRef` validation — no scope identity.

---

## Phase 4: Store — Reverse Lookup and Managed Windows

**Goal:** Add the repo methods needed for shared-alias lifecycle and
introduce the managed-window persistence model.

### 4a: Reverse Lookup by `activeHostSessionId`

- `packages/hrc-store-sqlite/src/repositories.ts`
  - Add `AppManagedSessionRepository.findByActiveHostSessionId(hostSessionId)`
    method. The index `idx_app_managed_sessions_active_host_session_id`
    already exists (migration 0005, line 269).
  - Returns all active aliases pointing at a given host session.

### 4b: Managed Windows Table

- `packages/hrc-store-sqlite/src/migrations.ts`
  - New migration: `CREATE TABLE managed_windows`:
    ```sql
    CREATE TABLE managed_windows (
      app_id TEXT NOT NULL,
      window_key TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'command',
      label TEXT,
      metadata_json TEXT,
      host_context_id TEXT NOT NULL,
      spec_json TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      generation INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      removed_at TEXT,
      PRIMARY KEY (app_id, window_key),
      FOREIGN KEY (host_context_id) REFERENCES host_contexts(host_context_id)
    );
    ```
  - Note: `host_context_id`, not `host_session_id`. Windows reference the
    substrate layer directly.

- `packages/hrc-store-sqlite/src/repositories.ts`
  - New `ManagedWindowRepository` with CRUD methods mirroring
    `AppManagedSessionRepository` but keyed by `(appId, windowKey)` and
    referencing `hostContextId` instead of `hostSessionId`.

---

## Phase 5: Server — Delete `app:` Synthesis, Implement Canonical Ensure, Add Window Handlers

**Goal:** Rewrite `handleEnsureAppSession` for canonical identity. Add full
window handler surface. This is the bulk of the work.

### 5a: Delete `app:${appId}` Synthesis

- `packages/hrc-server/src/index.ts`
  - Line 754: Replace `const scopeRef = \`app:${appId}\`` with extraction
    of `scopeRef` and `laneRef` from the required `sessionRef` field
    (parsed via `splitSessionRef`).
  - Lines 5551-5559: Delete `findManagedAppSessionForSession()` entirely.
    Replace all call sites with
    `db.appManagedSessions.findByActiveHostSessionId(session.hostSessionId)`.

### 5b: Canonical Continuity Reuse

- In `handleEnsureAppSession`, new-session branch:
  1. Parse `sessionRef` from request into `{ scopeRef, laneRef }`.
  2. Check if a continuity record exists for that `sessionRef`.
  3. If YES: create the `appManagedSessions` alias pointing at the existing
     `activeHostSessionId`. Do not create a new host session.
  4. If NO: create a new host session with the canonical `scopeRef`/`laneRef`,
     insert host context, insert continuity, then create the alias.

### 5c: Conflict Detection

- If an existing alias (same `appId` + `appSessionKey`) already has an
  `activeHostSessionId`, and that host session's `sessionRef` differs from
  the requested `sessionRef`, return 409 Conflict.

### 5d: Shared-Alias Lifecycle

- `rotateSessionContext()` (lines 2449-2588): After rotating, update ALL
  aliases found via `findByActiveHostSessionId(oldHostSessionId)` to point
  at the new `hostSessionId`.
- `handleRemoveAppSession()` (lines 971-1068): Before tearing down the
  runtime, check `findByActiveHostSessionId`. If other active aliases
  exist, only remove the selected alias (mark as `removed`). Tear down
  runtime/bridges/surfaces only when no active aliases remain.

### 5e: Command/Window Handlers (Full Surface)

- Add server routes for managed windows:
  - `POST /v1/windows/ensure` — create or reattach a managed window.
    Creates a `host_contexts` row + runtime. No session, no scopeRef.
  - `POST /v1/windows/remove` — remove window, optionally terminate runtime.
  - `GET /v1/windows` — list by appId.
  - `GET /v1/windows/capture` — capture window output (read-only).
  - `GET /v1/windows/attach` — get attach descriptor for window (read-only).
  - `POST /v1/windows/literal-input` — send literal text to window.
  - `POST /v1/windows/interrupt` — send interrupt signal.
  - `POST /v1/windows/terminate` — terminate window process.
  - `POST /v1/windows/clear-context` — restart runtime in same host
    context (no identity rotation, per window clear-context semantics).
- Remove `spec.kind === 'command'` branch from `handleEnsureAppSession`.

### 5f: Hard Fail on Non-Canonical scopeRefs

- Add a guard in session hydration paths. When loading a `HrcSessionRecord`
  from the store, if `scopeRef` fails `validateScopeRef()`, throw an error
  indicating the session was created under a legacy scheme and must be
  recreated.
- This catches stale `app:` rows AND any other non-canonical junk without
  needing a data migration.

---

## Phase 6: CLI and SDK — Pass Canonical `sessionRef`, Add Window Client

**Goal:** `hrc run` sends canonical session identity. SDK exposes window
operations. CLI exposes window commands.

### 6a: CLI `run` Command

- `packages/hrc-cli/src/cli.ts`
  - Lines 679-693: The CLI already resolves `scopeRef` and `laneRef` from
    the positional arg via `resolveRunScopeInput()`. Format these into an
    `HrcSessionRef` string (`${scopeRef}/lane:${laneRef}`) and pass as
    `sessionRef` on the `ensureAppSession` request.
  - The `appSessionKey` remains as the app-local alias key.

### 6b: SDK Window Methods

- `packages/hrc-sdk/src/client.ts`
  - Add window client methods: `ensureWindow`, `removeWindow`,
    `listWindows`, `captureWindow`, `attachWindow`,
    `windowLiteralInput`, `interruptWindow`, `terminateWindow`,
    `clearWindowContext`.

### 6c: CLI Window Commands

- `packages/hrc-cli/src/cli.ts`
  - Add CLI subcommands under `window` (or integrate with existing
    `app-session` command group, renamed).

### Tests

- Update `packages/hrc-cli/src/__tests__/cli.test.ts` to verify the
  ensure request carries `sessionRef`.
- Update `packages/hrc-server/src/__tests__/server-app-sessions-managed.test.ts`
  to cover:
  - Alias creation with canonical `sessionRef`
  - Alias reuse when canonical continuity already exists
  - 409 on sessionRef mismatch
  - Shared-alias clear-context updates all aliases
  - Shared-alias remove (last alias tears down, non-last preserves)
  - Hard fail on non-canonical scopeRef encounter
- New test file for window operations covering the full surface.

---

## Phase 7: Cleanup

Shippable independently after the atomic cutover of Phases 1-6.

- **Audit callers of optional `scopeRef`/`laneRef`:** `HrcRuntimeSnapshot`
  and `HrcEventEnvelope` now have optional `scopeRef`/`laneRef`. Audit all
  code that previously assumed these were always present — especially
  logging, filtering, watch output, and event serialization. Animata is the
  primary consumer that will need updates.
- Delete `findManagedAppSessionForSession()` and all `app:` prefix logic.
- Remove `host_session_id` columns from `runtimes`, `launches`, `runs`,
  `events`, `local_bridges`, `surface_bindings` (fully replaced by
  `host_context_id`).
- Remove test fixtures that seed `app:` scopeRefs
  (`__tests__/fixtures/hrc-test-fixture.ts` `seedTmuxRuntime` callers).
- Audit `packages/hrc-server/src/__tests__/server-bridge-appsession-selector.test.ts`
  and `server-phase6-red.test.ts` for `app:` test data — rewrite to use
  canonical scopeRefs.
- Remove `kind: 'command'` from `HrcManagedSessionKind` if not already done.

---

## Out of Scope

- Animata-side changes (user will fix in place after aliasing breaks).
- Data migration of existing `app:` rows (hard fail on read is sufficient).
- Changes to `agent-scope` package itself (already correct).
