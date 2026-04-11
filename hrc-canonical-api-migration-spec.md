# HRC Canonical Core Migration After ACP Scope Reduction

**Target repo:** `agent-spaces` (`packages/hrc-server`, `packages/hrc-cli`, `packages/hrc-core`, `packages/hrc-sdk`)
**Status:** Revised to match the updated `../acp-spec`
**Source of truth:** `../acp-spec/spec/runtime/HRC.md`, `../acp-spec/spec/runtime/HRC_DETAIL.md`

---

## 1. Verdict

After the ACP spec reduction, `app-session` is no longer a required HRC companion surface.

The updated ACP boundary is now:

- the ACP-facing HRC core is canonical for agent and harness sessions addressed by stable `SessionRef`
- the remaining required non-core HRC companion surfaces are:
  - non-agent managed PTY or window sessions for TUIs and scratchpad terminals
  - semantic in-flight input
  - surface binding
  - local migration bridges

What dropped out of the required companion scope:

- app-owned stable harness/session keys
- app-owned workbench or harness sessions
- bulk app-session `apply` / `upsert` reconciliation

That means the old `app-session` layer no longer has a spec-backed role. The remaining non-core need is a **window or command-session companion surface**, not an app-owned harness-session registry.

---

## 2. Updated ACP Boundary

| Layer | Current ACP status | Examples |
|---|---|---|
| ACP-facing HRC core | Canonical | `resolveSession`, `listSessions`, `watch`, `ensureRuntime`, `dispatchTurn`, `interrupt`, `terminate`, `clearContext`, `capture`, `getAttachDescriptor` |
| Required HRC companion surfaces outside ACP core | Still required | non-agent managed PTY or window sessions, semantic in-flight input, surface binding, local migration bridges |
| No longer required companion surfaces | Removed from current scope | app-owned harness/workbench sessions, app-owned stable session keys, bulk session `apply` / `upsert` reconciliation |

Two practical consequences follow from that boundary:

1. Harness roles should use canonical `SessionRef` identity directly.
2. Non-agent TUI and scratchpad terminals should use a dedicated command/window surface rather than the old `app-session` layer.

---

## 3. What HRC Should Do Now

HRC should split the remaining work cleanly:

### 3.1 Agent and harness sessions

Use the ACP-facing HRC core only:

- `POST /v1/sessions/resolve`
- `GET /v1/sessions`
- `GET /v1/sessions/by-host/:hostSessionId`
- `GET /v1/events`
- `POST /v1/runtimes/ensure`
- `POST /v1/turns`
- `POST /v1/interrupt`
- `POST /v1/terminate`
- `POST /v1/clear-context`
- `GET /v1/capture`
- `GET /v1/attach`

Identity is:

- stable `SessionRef` for semantic routing
- `hostSessionId` for concrete host continuity

### 3.2 Non-agent TUIs and scratchpad terminals

Keep a separate non-core companion surface for:

- ensuring a PTY or window-backed session
- attaching
- capturing
- literal input
- interrupting
- terminating
- fresh-PTY restart or relaunch

That companion surface should be expressed as a `windows` or `command-session` API, not as `app-session`.

---

## 4. What Can Be Removed

Because the ACP spec no longer requires app-owned harness/workbench sessions, the following HRC surface should be purged:

- `/v1/app-sessions/*`

More specifically, HRC can remove the app-session layer that exists to do:

- `(appId, appSessionKey) -> sessionRef` aliasing
- app-owned harness-session ensure/list/get/remove flows
- bulk `apply` / `upsert` reconciliation
- app-session-specific selector routing for harness turns
- synthetic client identities such as `appId: 'hrc-cli'`

What should **not** be removed as part of that purge:

- non-agent managed PTY or window lifecycle APIs
- semantic in-flight input
- surface-binding APIs
- local bridge APIs

Those remain required companion surfaces under the current ACP spec.

---

## 5. What The Canonical Core Still Should Not Absorb

The ACP spec reduction does **not** broaden the HRC core.

The following remain out of scope for the core unless `../acp-spec` changes again:

- prefix or ownership fanout such as `scopeRefPrefix` query support
- app-owned labels, metadata bags, or `kind` fields in the core session record
- combined launch-plus-prime fields such as `initialPrompt` on `ensureRuntime(...)`
- dry-run planning on `ensureRuntime(...)`
- bulk host-local `apply` / `upsert` reconciliation in the core

The core remains deliberately narrow:

- stable selector resolution
- runtime ensure
- turn dispatch
- lifecycle control
- capture
- attach
- event replay/watch

---

## 6. Proposed HRC Work

### 6.1 Phase H1: tighten the ACP-facing core

Verify and finish conformance for the current ACP-facing HRC core:

1. `resolveSession(...)` is idempotent on stable `SessionRef`.
2. `ensureRuntime(...)` matches the ACP spec shape:
   - stable selector
   - optional `intent?: HrcHarnessIntent`
   - `forceRestart?: boolean`
   - `restartStyle?: 'reuse_pty' | 'fresh_pty'`
3. `dispatchTurn(...)` remains the semantic harness execution surface.
4. `interrupt`, `terminate`, `clearContext`, `capture`, `attach`, `watch`, and `GET /v1/sessions/by-host/:hostSessionId` match the current ACP core contract.
5. Canonical-path tests cover `resolveSession -> ensureRuntime -> dispatchTurn` plus restart, clear-context, attach, and capture behavior.

### 6.2 Phase H2: complete the non-agent window surface

Make the non-agent companion surface explicit and complete for:

- center TUI sessions
- scratchpad terminals
- other non-agent managed PTY windows

That surface should own:

- ensure or relaunch
- literal input
- capture
- attach
- interrupt
- terminate

If `/v1/windows/*` is the chosen shape, finish that surface and route all non-agent terminal management through it instead of `app-session`.

### 6.3 Phase H3: parallel cutover plus direct purge

Assumptions for this plan:

- animata is the only real caller of the legacy `app-session` layer
- animata is being updated in parallel
- HRC does not need a deprecation window, compatibility shim, or retained legacy route family

Required caller-side outcomes:

1. animata harness roles use canonical `SessionRef` identity end-to-end and stop using `/v1/app-sessions/*`
2. animata center TUI and scratchpads use the dedicated non-agent window or command-session companion surface
3. `hrc-cli run` uses the canonical core and no longer depends on any synthetic app identity
4. no shipped caller continues to depend on app-session routes, DTOs, or selectors

### 6.4 Phase H4: delete the app-session layer atomically

Delete the app-session layer in the same change window as the caller cutover. Do not retain it as a fallback path.

Delete:

- app-session server routes
- app-session SDK methods
- app-session CLI verbs
- app-session contract types
- app-session persistence tables
- app-session-only tests

The preserved companion surfaces should be:

- windows or command-session management for non-agent terminals
- in-flight input
- surfaces
- bridges

There is no planned deprecation window for `app-session`.

---

## 7. Concrete HRC Deletions

The likely HRC removals are:

- app-session selector types and DTOs from [http-contracts.ts](/Users/lherron/praesidium/agent-spaces/packages/hrc-core/src/http-contracts.ts)
- app-session client methods from [client.ts](/Users/lherron/praesidium/agent-spaces/packages/hrc-sdk/src/client.ts)
- the `app-session` CLI verb family from [cli.ts](/Users/lherron/praesidium/agent-spaces/packages/hrc-cli/src/cli.ts)
- app-session route handlers from [index.ts](/Users/lherron/praesidium/agent-spaces/packages/hrc-server/src/index.ts)
- app-managed-session persistence and lookup paths
- app-session-focused tests in HRC server, SDK, and CLI packages

The likely HRC survivors are:

- canonical session/runtime endpoints
- non-agent window or command-session endpoints
- bridge endpoints
- surface-binding endpoints
- in-flight input endpoints

---

## 8. Summary

With animata moving harness roles to full `agent-scope` `SessionRef` identity, `app-session` no longer carries a required ACP role and no longer has a remaining caller that justifies retention.

The correct HRC shape is now:

- canonical HRC core for agent and harness sessions
- a separate non-core window or command-session surface for non-agent TUIs and scratchpad terminals
- no app-owned harness-session registry layer

Under the updated ACP spec, the proposed HRC change is therefore:

1. finish canonical-core conformance
2. move non-agent terminals onto a dedicated window or command-session companion surface
3. purge `app-session` entirely with no legacy retention path
