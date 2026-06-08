# Refactoring Analysis
**Target:** packages/harness-claude/src
**Lines analyzed:** 3341  ·  **Generated:** 2026-06-07  ·  **Focus:** all

## 📊 SOLID Scorecard
| Principle | Status | Issues |
|-----------|--------|--------|
| S (SRP) | 🟡 | 1 moderate violation in agent-session.ts (mixed concerns: state mgmt, SDK interaction, message processing, event emission) |
| O (OCP) | 🟢 | No violations detected; handler tables & visitor patterns used effectively |
| L (LSP) | 🟢 | No violations detected; consistent interface contracts |
| I (ISP) | 🟢 | Minimal interface bloat; well-sized contracts |
| D (DIP) | 🟡 | 2 minor issues: hardcoded SDK model map lookup; direct Bun.spawn calls in invoke.ts |

---

## 🎯 Priority Refactorings

### 1. Extract Event Emission & Turn Management from AgentSession — SRP
- **Location:** agent-session.ts:117–780 (main class definition)
- **Current:** AgentSession combines 5 responsibilities: SDK lifecycle, prompt queue, output listening, event emission, and tool tracking
- **Suggested:** Extract into 2-3 focused classes:
  - `EventEmitter` for `emitEvent`, `emitAgentStart`, `emitAgentEnd`, `emitTurnEnd`
  - `TurnTracker` for `pendingTurnIds`, `turnCounter`, `emitTurnEndIfNeeded`, `flushPendingTurns`
  - Keep AgentSession as orchestrator delegating to these collaborators
- **Risk:** Medium  ·  **API-impact:** internal-only  ·  **Effort:** 2–3 hours  ·  **Tests:** agent-session.getMetadata.test.ts, agent-session test suite (requires refactoring turn/event test assertions)

### 2. Extract Message Processing Pipeline — SRP
- **Location:** agent-session.ts:476–651 (processMessage, handleToolBlocks, tool result logic)
- **Current:** Scattered tool tracking, subagent context, and message dispatch across 6 methods; complex branching on msgType
- **Suggested:** Create `SDKMessageProcessor` class encapsulating:
  - Tool use/result block extraction & normalization
  - Subagent context tracking logic (lines 605–651)
  - Message type routing (lines 581–651)
  - Emit event delegation to EventEmitter
- **Risk:** Medium  ·  **API-impact:** internal-only  ·  **Effort:** 2–3 hours  ·  **Tests:** Must verify tool_use, tool_result, and subagent context flow; agent-session.test.ts

### 3. Extract Spawn Options Building — Primitive Obsession + DRY
- **Location:** invoke.ts:215–234 (invokeClaude) & invoke.ts:359–377 (spawnClaude)
- **Current:** Identical spawn options object construction duplicated in two functions; primitive Record<string, string | undefined> type repeated
- **Suggested:** Create `SpawnOptionsBuilder` or `type SpawnConfig` to centralize:
  ```typescript
  type SpawnConfig = {
    cwd?: string
    env?: Record<string, string>
    stdio: 'pipe' | 'inherit'
  }
  function buildSpawnOptions(options: ClaudeInvokeOptions | SpawnClaudeOptions): SpawnConfig
  ```
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 0.5 hours  ·  **Tests:** invoke.test.ts (spawnClaude, invokeClaude tests)

### 4. Decouple Claude Path Resolution from Spawn — Dependency Injection
- **Location:** invoke.ts:206–281 (invokeClaude), line 209: `getClaudePath()` called inside function
- **Current:** Direct call to `getClaudePath()` inside invokeClaude; tight coupling makes testing harder without mocking process/env
- **Suggested:** Accept `claudePath?: string` in options; default to `getClaudePath()` only if omitted
  ```typescript
  export async function invokeClaude(
    options: ClaudeInvokeOptions & { claudePath?: string } = {}
  ): Promise<...> {
    const claudePath = options.claudePath ?? await getClaudePath()
    // ...
  }
  ```
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 0.5 hours  ·  **Tests:** invoke.test.ts (allows test injection; no mock needed)

### 5. Deep Nesting in Message Content Extraction — Reduce Complexity
- **Location:** agent-session.ts:742–779 (extractResponseText)
- **Current:** 3 levels of nesting (if msg['type'], if content is string, if Array.isArray); guard clauses not fully exploited
- **Suggested:** Flatten with early returns:
  ```typescript
  private extractResponseText(message: unknown): string | undefined {
    if (!message || typeof message !== 'object') return undefined
    const msg = message as Record<string, unknown>
    if (msg['type'] === 'result' && typeof msg['result'] === 'string') return msg['result']
    if (msg['type'] !== 'assistant') return undefined
    const assistantMsg = msg['message'] as Record<string, unknown> | undefined
    if (!assistantMsg) return undefined
    if (typeof assistantMsg['content'] === 'string') return assistantMsg['content']
    if (!Array.isArray(assistantMsg['content'])) return undefined
    // ... extract text from blocks
  }
  ```
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 0.5 hours  ·  **Tests:** No test impact (internal; no behavior change)

### 6. Move Magic Constants Out of Scope — Eliminate Magic Numbers
- **Location:** agent-session.ts:33 (DEFAULT_MAX_TURNS = 100), agent-session.ts:39 (SDK_CHILD_SHELL = '/bin/bash')
- **Current:** Module-level constants; should be configuration-injectable for testing (e.g., spawn shell, turn limits per session type)
- **Suggested:** Move to `AgentSessionConfig` or create `AgentSessionDefaults` type:
  ```typescript
  interface AgentSessionConfig {
    // ...
    maxTurns?: number  // Already present
    shell?: string  // New
  }
  const DEFAULTS = { maxTurns: 100, shell: '/bin/bash' }
  ```
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1 hour  ·  **Tests:** Must verify tests still pass with default shell injection

### 7. Simplify HooksBridge Conditional Logic — OCP + Reduce Nesting
- **Location:** hooks-bridge.ts:66–140 (createCanUseToolCallback)
- **Current:** Deeply nested if-else chain (5 levels): permissionHandler → isAutoAllowed vs hookEventBus → isToolAutoAllowed vs requestPermission
- **Suggested:** Extract permission resolution to dedicated method:
  ```typescript
  private async resolvePermission(toolName: string, toolInput: Record<string, unknown>, toolUseId?: string): Promise<CanUseToolResult> {
    if (this.permissionHandler) {
      if (this.permissionHandler.isAutoAllowed(toolName)) {
        return { behavior: 'allow', updatedInput: toolInput }
      }
      const response = await this.permissionHandler.requestPermission({...})
      return response.allowed ? { behavior: 'allow', ... } : { behavior: 'deny', ... }
    }
    if (!this.hookEventBus) {
      return { behavior: 'allow', updatedInput: toolInput }
    }
    // hookEventBus branch...
  }
  ```
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1 hour  ·  **Tests:** hooks-bridge.ts test coverage (canUseTool callback scenarios)

### 8. Consolidate Duplicate Tool Result Handling — DRY Violation
- **Location:** agent-session.ts:677–709, hooks-bridge.ts:303–320 (processToolResultBlock)
- **Current:** `processToolResultBlock` logic duplicated between agent-session and hooks-bridge; same extraction, normalization, event emission
- **Suggested:** Move common logic to `sdk-message-decode.ts`:
  ```typescript
  export interface ToolResultExtraction {
    toolName: string
    toolInput?: unknown
    isError?: boolean
    result: ToolResult
  }
  export function extractToolResult(blockObj: Record<string, unknown>, toolMeta?: {name: string; input: unknown}): ToolResultExtraction
  ```
- **Risk:** Medium  ·  **API-impact:** internal-only  ·  **Effort:** 1–1.5 hours  ·  **Tests:** sdk-message-decode.test.ts (new unit test); update agent-session + hooks-bridge callers

---

## 📝 Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| **Long parameter list** | hooks-bridge.ts:160–165 (emitPostToolUse takes 5 params) | Low | Extract to options object: `{toolName, toolInput, toolResponse, toolUseId?, isError?}` |
| **Duplicate code** | agent-session.ts:661–675 + agent-session.ts:677–709 (tool block processing) | Medium | Consolidate into shared `processToolBlock()` for use/result common path |
| **Primitive obsession** | invoke.ts:217–226 (SpawnOptions as inline object) | Low | Create `SpawnConfig` type (see refactor #3) |
| **Deep nesting** | hooks-bridge.ts:71–140 (createCanUseToolCallback) | Medium | Extract permission resolution method (see refactor #7) |
| **Magic numbers** | agent-session.ts:33, 39 (DEFAULT_MAX_TURNS, SDK_CHILD_SHELL) | Low | Configurability issue (see refactor #6) |
| **Feature envy** | claude-adapter.ts:466–468 (getDefaultRunOptions reads manifest deeply) | Low | Manifest reading already delegated to spaces-config; OK |
| **Long method** | agent-session.ts:418–469 (listenToOutput) | Medium | 51 lines; control flow + error handling; extract error handler to method |
| **Type casts** | agent-session.ts:745, 804, 829 (repeated `as Record<string, unknown>`) | Low | Create helper: `asRecord(val)` |

---

## 🚀 Quick Wins (low risk, high value)

1. **Extract SpawnConfig from invoke.ts** (Effort: 0.5h, Risk: Low)
   - Unify spawn options object construction in `invokeClaude` and `spawnClaude`.
   - DRY improvement with zero API surface change.

2. **Flatten extractResponseText nesting** (Effort: 0.5h, Risk: Low)
   - Convert nested if statements to early returns.
   - Improves readability of message extraction logic.

3. **Add cloudePath injection option to invokeClaude** (Effort: 0.5h, Risk: Low)
   - Allow test injection without mocking.
   - Makes testing easier without coupling tests to runtime env.

4. **Create asRecord() helper** (Effort: 0.5h, Risk: Low)
   - Consolidate repeated `as Record<string, unknown>` casts.
   - Better type safety and readability across message decode.

5. **Extract permission resolution in HooksBridge** (Effort: 1h, Risk: Low)
   - Reduce nesting and cognitive load in createCanUseToolCallback.
   - Improves readability; no behavior change.

---

## ⚠️ Technical Debt Notes

### High-Priority Debt
- **AgentSession class complexity:** The 664-line class manages SDK lifecycle, message routing, tool tracking, event emission, and turn management. As features grow (subagent context, async patterns), this becomes a maintenance bottleneck. Extract collaborators (EventEmitter, TurnTracker, SDKMessageProcessor) to unblock future work.
- **Message processing logic duplicated:** Tool block extraction/normalization is done in both AgentSession and HooksBridge. This will diverge as new block types are added. Centralize in sdk-message-decode.

### Medium-Priority Debt
- **HooksBridge permission logic complexity:** The deeply nested conditional in createCanUseToolCallback is hard to extend (e.g., adding new permission sources). Extracting a `resolvePermission()` method will improve testability and clarity.
- **Spawn configuration fragmentation:** Two independent functions (invokeClaude, spawnClaude) build spawn options identically. As spawn scenarios grow (streaming, signals, etc.), divergence is likely.

### Low-Priority Debt
- **Magic constants:** SDK_CHILD_SHELL and DEFAULT_MAX_TURNS are module-level; should be injectable for test flexibility and future shell/timeout customization.
- **Type safety in message decode:** Repeated `as Record<string, unknown>` casts suggest a need for branded types or helper functions to make the type-narrowing intent explicit.

### No Violations Found
- **Liskov Substitution Principle (LSP):** All interface implementations (HarnessAdapter, UnifiedSession, AsyncIterable) honor their contracts; no "not implemented" throws or type-checking before calls.
- **Open/Closed Principle (OCP):** Handler tables (TOOL_RESULT_BLOCK_HANDLERS) and visitor patterns (forEachToolBlock) allow new block types without modifying existing code.
- **Interface Segregation (ISP):** Interfaces are appropriately sized (HookEventBusAdapter, PermissionHandler); no interface stubbing detected.

---

## Key Findings Summary

**Total Refactorings:** 8 (2 Medium-risk SRP, 1 Medium-risk DRY, 5 Low-risk)
**Quick Wins:** 5 (all Low-risk)
**Auto-Apply Candidates:** Refactorings #3, #4, #5, #7 (Low-risk + internal-only) → 4 items
**Lines of Code:** 3,341 total; no files exceed 900 lines (largest: agent-session.ts 884 lines; acceptable for state machine)

**Design Strengths:**
- Excellent use of handler tables (TOOL_RESULT_BLOCK_HANDLERS) for OCP
- Visitor pattern (forEachToolBlock) decouples message traversal from processing
- Clear separation between adapter layer (claude-adapter.ts) and SDK layer (agent-sdk/)
- Solid dependency injection via constructor options (AgentSessionOpts)

**Design Weaknesses:**
- AgentSession violates SRP by combining 5+ concerns; needs decomposition
- Message processing logic fragmented across agent-session and hooks-bridge
- Conditional chains in HooksBridge createCanUseToolCallback lack extraction
- Minor type safety gaps (repeated type casts, magic numbers exposed as constants)
