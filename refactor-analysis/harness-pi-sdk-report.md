# Refactoring Analysis

**Target:** packages/harness-pi-sdk/src
**Lines analyzed:** 2,474  ·  **Generated:** 2026-06-07  ·  **Focus:** all

## SOLID Scorecard

| Principle | Status | Issues |
|-----------|--------|--------|
| **S** (SRP) | 🟡 | Two classes exceed 300 lines; event mapping mixes concerns |
| **O** (OCP) | 🔴 | Large switch statements on event types; hard to extend with new event types |
| **L** (LSP) | 🟢 | No detected override violations |
| **I** (ISP) | 🟡 | Fat config interfaces; PiSessionConfig has 12+ properties |
| **D** (DIP) | 🟡 | Direct new of classes (SessionManager); some implicit dependencies |

---

## Priority Refactorings

### 1. Extract Event Mapping Concerns from PiSession — **SRP**

- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-pi-sdk/src/pi-session/pi-session.ts:246–302` (emitHookForEvent), lines 550–639 (mapPiEventToUnified)
- **Current:** `PiSession.emitHookForEvent()` handles 3 event types with a 33-line switch statement; `mapPiEventToUnified()` is a 90-line function with a 10-case switch; both live in the main session class
- **Problem:** PiSession mixes session lifecycle management with event transformation and hook dispatch. The `emitHookForEvent` switch couples session logic to hook event routing, and `mapPiEventToUnified` is a standalone translation layer that's conceptually separate but tightly bound to PiSession
- **Suggested:**
  - Extract `emitHookForEvent` into a `PiHookDispatcher` class that accepts HookEventBus and owns the switch logic
  - Move event mapping helpers (`mapPiEventToUnified`, handler functions) into a separate `PiEventMapper` module
  - PiSession calls these services; does not own the mapping logic
- **Risk:** Medium  ·  **API-impact:** internal-only  ·  **Effort:** 2–3 hours  ·  **Tests:** Update pi-session.test.ts to mock PiHookDispatcher and PiEventMapper; ensure event flow still passes through without breaking the stream

### 2. Decouple Event Type Switch Statement — **OCP**

- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-pi-sdk/src/pi-session/pi-session.ts:550–639` (mapPiEventToUnified)
- **Current:** A 10-case switch statement (`agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`) directly handles each event type. Adding a new Pi SDK event type requires editing this central function
- **Problem:** Violates OCP; the mapping function grows with each new event type. No extensibility seam for plugins or new event handlers
- **Suggested:**
  - Replace the switch with a `Map<string, (event: PiAgentSessionEvent, ...) => UnifiedSessionEvent[]>` dispatch table
  - Register default handlers; allow callers to inject custom handlers for new event types
  - Each handler is a small, focused function (e.g., `handleMessageStart()`, `handleToolExecutionEnd()`)
- **Risk:** Medium  ·  **API-impact:** internal-only  ·  **Effort:** 2–3 hours  ·  **Tests:** pi-session.test.ts already has good coverage; refactor dispatch without changing behavior; add test for custom handler injection

### 3. Split PiSession Class (Too Large, Mixed Concerns) — **SRP**

- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-pi-sdk/src/pi-session/pi-session.ts:68–303`
- **Current:** PiSession (768 lines) handles:
  - Session lifecycle (start, stop, sendPrompt, state management)
  - Event subscription and forwarding
  - Hook event emission
  - Event mapping and transformation (held message state, final flags)
  - Permission handling setup
  - Session metadata
- **Problem:** SRP violation; PiSession has too many reasons to change (lifecycle changes, new hook types, event schema changes, new metadata fields, permission logic changes). Line count > 300 indicates complexity
- **Suggested:**
  - Keep PiSession as a minimal UnifiedSession implementation (lifecycle, subscription, state)
  - Extract held-message state into a `PiMessageBuffer` class
  - Move event subscription/mapping into a `PiEventRouter` service (takes agent session, emits unified events)
  - Move hook emission into `PiHookDispatcher`
- **Risk:** High  ·  **API-impact:** internal-only  ·  **Effort:** 4–6 hours  ·  **Tests:** Comprehensive suite of integration tests; ensure UnifiedSession contract still holds; test backward compatibility of event ordering

### 4. PiSdkAdapter: Extract Artifact Merging Logic — **SRP**

- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-pi-sdk/src/adapters/pi-sdk-adapter.ts:369–436` (composeTarget method) and private merge methods (lines 437–533)
- **Current:** PiSdkAdapter.composeTarget() orchestrates extension, skills, hooks, and context merging in a 67-line method. Four private merge methods handle artifact-type-specific logic
- **Problem:** composeTarget mixes orchestration with file I/O and manifest building; too many levels of indentation (deep nesting in loops); 698-line class has too many concerns (adaptation, bundling coordination, manifest generation)
- **Suggested:**
  - Extract a `PiSdkBundleComposer` class that handles merging, ordering, and manifest building
  - Replace four `mergeArtifact*` methods with a more generic `mergeArtifact(type: 'extensions' | 'skills' | 'hooks' | 'context')` pattern using a config map
  - PiSdkAdapter delegates composition and calls the composer; does not own merge logic
- **Risk:** Medium  ·  **API-impact:** internal-only  ·  **Effort:** 2–3 hours  ·  **Tests:** pi-sdk-adapter.test.ts; ensure artifacts still merge in correct order; check manifest structure is identical

### 5. Permission Hook: Duplicate Logic Across Two Paths — **DRY**

- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-pi-sdk/src/pi-session/permission-hook.ts:15–67`
- **Current:** Two separate if-else branches:
  - Lines 27–48: If `permissionHandler` exists, emit hook, check auto-allow, request permission
  - Lines 50–67: If only `hookEventBus` exists, emit hook, check auto-allow, request permission
- **Problem:** Nearly identical logic (emit, auto-allow check, request decision) is duplicated. If permission logic changes, both paths must be updated. Hard to test both paths thoroughly
- **Suggested:**
  - Extract a `ToolPermissionResolver` interface/class with a method `resolvePermission(toolName, input): Promise<PermissionDecision>`
  - Implement two adapters: `PermissionHandlerResolver` and `HookEventBusResolver` 
  - Single code path calls the resolver; strategy pattern decouples the two sources
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1–2 hours  ·  **Tests:** permission-hook.test.ts; ensure both paths still work; add parametrized tests for both resolver strategies

### 6. PiSessionConfig: Fat Config Interface — **ISP**

- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-pi-sdk/src/pi-session/types.ts:35–53`
- **Current:** PiSessionConfig has 12 properties, mixing:
  - Core identity (ownerId, cwd)
  - Optional model config (model, provider, thinkingLevel)
  - Persistence (persistSessions, sessionPath)
  - Extensions (extensions, skills, contextFiles, additionalExtensionPaths)
  - Hooks (hookEventBus, onEvent)
- **Problem:** Callers must understand and pass all these options; fat interface makes testing harder; some properties are only used in specific code paths (e.g., onEvent is only used in subscribeToEvents)
- **Suggested:**
  - Extract model config into `PiModelConfig { model, provider, thinkingLevel }`
  - Extract persistence into `PiPersistenceConfig { persist: boolean, sessionPath?: string }`
  - Extract extensions into `PiExtensionsConfig { extensions?, skills?, contextFiles?, additionalExtensionPaths? }`
  - PiSessionConfig composes these; callers build targeted sub-configs
- **Risk:** Medium  ·  **API-impact:** internal-only (may affect constructors)  ·  **Effort:** 2 hours  ·  **Tests:** Ensure all existing tests still pass; parametrize tests to validate each sub-config

### 7. Hook Runtime: Duplicate Hook Loading Logic — **DRY**

- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/harness-pi-sdk/src/pi-session/hook-runtime.ts:132–259` (buildHookExtension) and `/Users/lherron/praesidium/agent-spaces/packages/harness-pi-sdk/src/pi-sdk/pi-sdk/runner.ts:210–228`
- **Current:** Both `hook-runtime.ts` (buildHookExtension) and runner.ts have nearly identical code:
  - Load hooks from manifest
  - Filter by hook.harness (if needed)
  - Build spaceIds set
  - Call buildHookExtension with same params
- **Problem:** Copy-paste code; any bug fix in hook registration must be made in two places
- **Suggested:**
  - Extract hook loading into a shared utility `loadManifestHooks(manifest, noExtensions, bundleRoot, targetName, spaceIds, yolo, cwd)`
  - Both buildHookExtension callers use this utility
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1 hour  ·  **Tests:** Existing tests cover both code paths; refactor should not change behavior

---

## Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| **Long Function** | `mapPiEventToUnified` (90 lines) | Medium |
| **Long Function** | `PiSession` class (768 lines) | High |
| **Long Function** | `PiSdkAdapter` class (698 lines) | High |
| **Nested If-Else** | permission-hook.ts lines 27–67 (duplication + 3 levels) | Medium |
| **Large Switch Statement** | pi-session.ts line 269–301 (3 event types) | Low |
| **Large Switch Statement** | pi-session.ts line 555–638 (10 event types) | Medium |
| **Duplicated Code** | permission-hook.ts: two parallel permission resolution paths | Medium |
| **Duplicated Code** | hook-runtime.ts + runner.ts: hook loading + registration | Low |
| **Magic Strings** | Event type strings ('agent_start', 'tool_execution_end', etc.) scattered through code | Low |
| **Type Casting** | Multiple `as Record<string, unknown>` and `as PiMessage | undefined` casts | Low |
| **Incomplete Error Handling** | PiSession.start() sets state to 'error' but does not log details (line 133–134) | Low |

---

## Quick Wins (Low Risk, High Value)

1. **Extract magic event strings into constants** (10 min)
   - Create `src/pi-session/event-types.ts` with `const PI_EVENT = { AGENT_START: 'agent_start', ... }`
   - Replace all hardcoded strings in pi-session.ts and hook-runtime.ts
   - Reduces typos, improves IDE autocomplete

2. **Add debug logging in PiSession.start() error path** (15 min)
   - Line 133: Add `console.error('[pi-session] Start failed:', error)` before setting state to 'error'
   - Improves observability for support/debugging

3. **Extract `heldFromPiMessage` helper into a reusable factory** (20 min)
   - Currently used in 2 places; move to a utility function with clear contract
   - Reduces duplication in handleMessageEnd and handleAgentEnd

4. **Replace 7 utility functions at file level with a `PiEventUtils` class** (1 hour)
   - Functions: `assistantTextFromPiMessage`, `latestAssistantMessage`, `heldFromPiMessage`, `mapPiMessage`, `mapContentBlocks`, `mapToolResultItem`, `mapToolResultContent`, `normalizeToolInput`
   - Organize as static methods; easier to test, document, and extend
   - (Lower priority if you prefer functional style; ergonomic, not essential)

5. **Parameterize test expectations in pi-session.test.ts** (30 min)
   - Many test cases follow the same pattern (create event, call mapPiEventToUnified, assert)
   - Use parametrized tests (Jest describe.each) to reduce duplication and improve coverage

---

## Technical Debt Notes

### Event Mapping State Machine
The `PiEventMappingState` (lines 352–376) implements a held-message pattern to buffer assistant messages until a terminal event (turn_end or agent_end). The logic is sound but complex:
- Held message carries across model rounds (turn_end)
- Only finalized when agent_end or standalone turn_end arrives
- Comments are thorough, but the state machine is hard to visualize

**Recommendation:** Consider extracting state management into a `MessageBuffer` class with explicit `hold()`, `flush(final: boolean)`, and `canHold(message)` methods. Make the state machine testable in isolation.

### Config Resolution Precedence
`resolveGlobalAgentDir` (lines 56–66) and `resolveAuthStoragePath` (lines 41–49) have hardcoded precedence (options > config > env > home). This is OK, but consider documenting the precedence in a constant or enum to make it obvious to maintainers.

### Runner Error Handling
`runner.ts` (lines 312–315) catches errors and logs to stderr, then exits with code 1. This is minimal. Consider:
- Distinguish between recoverable errors (e.g., missing bundle) and unrecoverable errors (e.g., I/O fail mid-stream)
- Exit codes: 1 (general error), 2 (config error), 3 (SDK error)

### Hook Script Execution
`runHookScript` (lines 70–108 in hook-runtime.ts) uses `shell: true` and passes payload via stdin. This is intentional for script flexibility, but:
- Payload escaping: `proc.stdin.write(payload)` assumes JSON is safe; use a dedicated serializer if format changes
- Error handling: JSON parse errors in hook scripts are silently caught and logged; consider more structured error reporting

---

## Summary

**Finding Count:** 7 refactorings + 11 code smells  
**Applicable for Auto-Apply (Low/Med + internal-only):** 5 refactorings (#1, #2, #4, #5, #7) + 5 quick wins  
**Risk Profile:** 3 Medium-risk, 1 High-risk (class splitting); recommend prioritizing #5 (permission hook) and #7 (hook loading) first for low-hanging fruit

