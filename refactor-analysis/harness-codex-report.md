# Refactoring Analysis
**Target:** packages/harness-codex/src
**Lines analyzed:** 2889  ·  **Generated:** 2026-06-07  ·  **Focus:** all

## SOLID Scorecard
| Principle | Status | Issues |
|-----------|--------|--------|
| SRP (Single Responsibility) | 🟡 | codex-session.ts mixes event marshalling + process lifecycle; run-one-shot.ts has deeply nested notification handlers |
| OCP (Open/Closed) | 🟡 | Type/string-based notification dispatch in both codex-session.ts and run-one-shot.ts (switch chains keyed on method string) |
| LSP (Liskov Substitution) | 🟢 | No violations observed |
| ISP (Interface Segregation) | 🟡 | CodexRpcClient handlers interface is fat (onNotification, onRequest, onMessage, onError); CodexSessionConfig has 11 optional fields |
| DIP (Dependency Injection) | 🟡 | Direct instantiation of CodexRpcClient and spawn() inside CodexSession; hardcoded magic strings for RPC methods |

## Priority Refactorings

### 1. Extract Event Handler Registry from CodexSession — OCP
- **Location:** codex-session.ts:304-410 (handleNotification switch block)
- **Current:** 9-case switch statement keyed on `notification.method` strings; adding new event types requires editing CodexSession
- **Suggested:** Create NotificationHandler interface and a registry map: `Map<string, (params: unknown) => void>`. Abstract handler logic into methods on a dedicated EventDispatcher class.
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 2-3h  ·  **Tests:** codex-session.test.ts (test each handler in isolation)

### 2. Extract Nested Notification Queue Logic — SRP/Readability
- **Location:** run-one-shot.ts:75-202 (notification queue promise chaining + switch dispatch)
- **Current:** Closure over notificationQueue, resolveTurn, rejectTurn, and 15+ variables; switch statement spans 100+ lines with complex nested type casts
- **Suggested:** Extract to NotificationProcessor class handling queue/error semantics; extract switch into handler methods per notification type
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 3-4h  ·  **Tests:** run-one-shot.test.ts (mock RPC and verify each notification path)

### 3. Replace String-Based RPC Method Dispatch — OCP + Type Safety
- **Location:** codex-session.ts:305 + run-one-shot.ts:108 (switch on notification.method)
- **Current:** `switch (notification.method) { case 'error': ... case 'turn/started': ... }` repeated in two files; string literals scattered
- **Suggested:** Create NotificationMethod enum or discriminated union for type-safe dispatch; use as const tagged literals to allow exhaustiveness checking
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** 2h  ·  **Tests:** Verify all notification types are still handled post-refactor

### 4. Split CodexSession Responsibilities — SRP
- **Location:** codex-session.ts:80-489 (540 lines: process lifecycle + RPC marshalling + event emission + permission handling)
- **Current:** Single class owns proc spawn, RPC client lifecycle, state machine, event callback routing, permission resolution, file I/O for events
- **Suggested:** 
  - SessionLifecycleManager: start(), stop(), state transitions
  - RpcEventBridge: handleNotification(), handleRequest() → emits UnifiedSessionEvent[]
  - PermissionResolver: resolvePermission() (extract to strategy pattern)
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** 4-5h  ·  **Tests:** All codex-session.test.ts suites; integration tests for start/stop flows

### 5. Extract Common Event Mapping Logic — DRY
- **Location:** event-mapping.ts:128-203 (mapItemStarted) & 211-318 (mapItemCompleted)
- **Current:** Two massive switch statements (75 lines each) with nearly identical structure; same CodexThreadItem type guards duplicated
- **Suggested:** Create unified EventMapper with shared type-guard + dispatch for both started/completed paths; factor discriminator extraction into helper
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1.5h  ·  **Tests:** event-mapping.test.ts (parametric test each item type for both paths)

### 6. Refactor buildCodexAppServerLaunchDescriptor to Reduce Boilerplate — Code Smell
- **Location:** codex-adapter.ts:101-123 (22 lines of spread-if chains)
- **Current:** 10x `...(condition ? { key: value } : {})` pattern; hard to extend without adding more lines
- **Suggested:** Create helper `withProperty<K extends keyof T>(obj: T, key: K, value: T[K] | undefined)` and chain it; or use class-based builder
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1h  ·  **Tests:** codex-adapter tests (verify descriptor shape stays same)

### 7. Reduce CodexAdapter Method Size — SRP/Readability
- **Location:** codex-adapter.ts:508-681 (composeTarget method, 174 lines)
- **Current:** Single method owns: mkdir, symlinks, MCP composition, config assembly, manifest generation, bundle construction
- **Suggested:** Extract sub-methods: composeSkillsAndPrompts(), composeMcpAndConfig(), writeManifest(), buildBundle()
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 2h  ·  **Tests:** composeTarget integration test (verify file outputs unchanged)

### 8. Consolidate CodexSession + run-one-shot Duplicate Logic — DRY
- **Location:** codex-session.ts lines 146-148, 210-220 vs run-one-shot.ts lines 206-218
- **Current:** Thread initialization (RPC.sendRequest('initialize'), 'initialized' notification) duplicated; turn parameter objects duplicated
- **Suggested:** Extract shared initialization as function; define TurnParams type once; share in both entry points
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1.5h  ·  **Tests:** Run both paths; verify same RPC calls

### 9. Extract Magic Constants to Named Module Exports — Code Smell
- **Location:** codex-adapter.ts:71-78, codex-session.ts:38-39, codex-hooks.ts:10-11
- **Current:** Constants like `IMAGE_EXTENSIONS`, `MAX_IMAGE_BYTES`, `DEFAULT_HOOK_TIMEOUT_SECONDS`, file names hardcoded in strings
- **Suggested:** Create constants.ts exporting all magic numbers + extension sets; import into modules
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 0.5h  ·  **Tests:** Smoke test that constants match existing values

### 10. Simplify Parallel Permission Handler Logic — Code Smell
- **Location:** codex-session.ts:440-476 (handleRequest switch + dual permission approval paths)
- **Current:** Two case branches (commandExecution, fileChange) with nearly identical structure; async permission flow repeated
- **Suggested:** Create PermissionApprovalRequest type union; single handler method dispatching to shared approval logic
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1h  ·  **Tests:** codex-session.test.ts permission suite

## Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| **Long Method** | codex-session.ts:304-410 (handleNotification) | Med — 107 lines, 9-case switch with nested type casts |
| **Long Method** | run-one-shot.ts:107-202 (handleNotification) | Med — 96 lines, dense control flow, high nesting |
| **Long Method** | codex-adapter.ts:508-681 (composeTarget) | Med — 174 lines, multiple concerns (I/O, composition, config) |
| **Primitive Obsession** | codex-session.ts:305+ (notification.method: string keys) | Med — Untyped string dispatch; no exhaustiveness |
| **Primitive Obsession** | run-one-shot.ts:108+ (same issue) | Med — Duplicated string-based switch; brittle to new events |
| **Deep Nesting** | codex-adapter.ts:534-574 (nested loops in composeTarget) | Low — 4 levels; readable but extractable |
| **Magic Numbers** | codex-session.ts:39 (MAX_IMAGE_BYTES = 10 * 1024 * 1024) | Low — Semantic but unexported |
| **Duplicated Blocks** | codex-session.ts:305-410 vs run-one-shot.ts:107-202 | Med — Notification dispatch logic nearly identical |
| **Duplicated Blocks** | codex-session.ts:442-455 vs 457-471 (permission handling) | Low — Parallel structures, minor differences |
| **Duplicated Blocks** | codex-adapter.ts:237-241 & 313-322 (appendDefaultFeatureFlags + appendInteractiveCommonFlags calls) | Low — Feature flag building repeated |
| **Long Parameter List** | CodexSessionConfig (11 optional fields) | Low — Not a function parameter; interface is segregable |
| **Feature Envy** | CodexRpcClient.handleResponse (access to this.pending, this.closed) | Low — Cohesive; acceptable for RPC client internals |

## Quick Wins (Low Risk, High Value)

1. **Extract NotificationMethod enum** (~0.5h, Low risk) — Create discriminated union for `notification.method` strings; apply in both session paths. Enables TypeScript exhaustiveness checking.

2. **Create constants.ts module** (~0.5h, Low risk) — Move IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, DEFAULT_HOOK_TIMEOUT_SECONDS, INSTRUCTIONS_FILES to shared export; import everywhere.

3. **Consolidate permission handler structure** (~1h, Low risk) — Merge commandExecution + fileChange approval cases in handleRequest using union type + single resolver.

4. **Extract turn parameter builder** (~1h, Low risk) — DRY the turn/start params (model, cwd, approvalPolicy, sandbox, etc.) used in both CodexSession + run-one-shot.

5. **Add JSDoc to notification handlers** (~0.5h, Low risk) — Document what each notification type represents; clarify state mutations (e.g., turn/completed vs turn/started).

## Technical Debt Notes

- **Event Dispatch Fragility:** String-keyed switch statements for RPC notifications are scattered and untyped. Adding new Codex event types requires edits in two places (codex-session.ts + run-one-shot.ts) with no compile-time safety. Priority: refactor to discriminated union + exhaustiveness checks.

- **Process Lifecycle Coupling:** CodexSession entangles process spawning, RPC protocol, permission handling, and event marshalling. Difficult to test in isolation; harder to reuse RPC client logic. Consider extraction of SessionLifecycleManager.

- **Type Safety Gaps:** CodexThreadItem is loosely typed (catch-all `{ type: string; id?: string }` at end of union). Event parameters passed as `unknown` and cast in handlers. Consider stricter notification type definitions.

- **Duplicate Session Logic:** Both CodexSession and runCodexAppServerOneShot initialize threads, handle turn completion, and process items. Sharing reduces maintenance burden but currently requires code duplication for lifecycle differences.

- **No Request/Response Validation:** RPC responses cast directly without validation (e.g., `response as ThreadStartResponse`). If Codex protocol changes, silent failures likely.

---

**Summary:** The harness-codex package is well-structured at the module level but suffers from notification dispatch fragmentation (OCP violation), long methods mixing concerns (SRP), and code duplication between session paths. Priority fixes are event handler abstraction and session responsibility split. All identified refactorings are Low-Med risk, internal-only changes suitable for safe iterative cleanup.
