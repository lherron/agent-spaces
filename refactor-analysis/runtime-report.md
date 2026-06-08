# Refactoring Analysis
**Target:** packages/runtime/src  
**Lines analyzed:** 2,849  ·  **Generated:** 2026-06-07  ·  **Focus:** all

## SOLID Scorecard
| Principle | Status | Issues |
|-----------|--------|--------|
| S (SRP) | 🟡 | Multiple large files mixing concerns; context-resolver is 712L with 5+ responsibilities |
| O (OCP) | 🟡 | Switch/pattern matching on types (section type, scan category) that grows per case |
| L (LSP) | 🟢 | No violations; proper error handling and interface adherence |
| I (ISP) | 🟡 | Fat config objects (CreateSessionOptions 41L, ContextResolverContext 56L) with unused fields |
| D (DIP) | 🟡 | Module-level mutable registry in factory.ts; hardcoded runtime dependencies; direct Bun.spawn |

## Priority Refactorings

### 1. Extract Service Probe Resolution from context-resolver.ts — SRP
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/runtime/src/context-resolver.ts:399-429`
- **Current:** `resolveServiceProbeSection()` contains 30L of service probing, templating, and formatting logic inside a 712L file
- **Suggested:** Extract to dedicated `service-probe-resolver.ts` module; reduce context-resolver to single concern (template resolution orchestration)
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1h  ·  **Tests:** service-probe-resolver.test.ts (3 new cases: success, timeout, mixed results)

### 2. Extract Command/File Reference Slot Resolution — SRP
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/runtime/src/context-resolver.ts:431-537`
- **Current:** `resolveSlotSection()`, `resolveAdditionalBaseSlot()`, `resolveScaffoldSlot()`, `resolveFileRefSlot()`, `resolveCommandSlot()` (107L total) mix slot dispatch, file reading, and command execution
- **Suggested:** Create `slot-resolver.ts` with focused SlotResolver class; depend on file reader and exec utilities
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 2h  ·  **Tests:** slot-resolver.test.ts (6 new cases: basic file, scaffold, command, missing ref, ambiguous match)

### 3. Extract Duplicate File Reading Logic — DRY + SRP
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/runtime/src/agent-memory/store.ts:90-98, 206-213` and context-resolver.ts:675-684
- **Current:** Three copies of "try readFile, catch ENOENT" pattern across two modules
- **Suggested:** Create `file-reader.ts` utility with `readFile()` and `readOptionalFile()` exports; import from both modules
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 30m  ·  **Tests:** file-reader.test.ts (2 new cases: exists, ENOENT)

### 4. Extract Type Guards to Shared Utility Module — DRY + Maintainability
- **Location:** `isRecord()` defined in 4 files (context-template.ts:451, context-resolver.ts:705, system-prompt.ts:322, template-vars.ts:107)
- **Current:** Identical implementations scattered, hard to maintain/extend
- **Suggested:** Create `type-guards.ts` exporting `isRecord()`, `isString()`, `isArray()`; import in all modules
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 30m  ·  **Tests:** type-guards.test.ts (4 cases per guard)

### 5. Break resolveZone() Logic into Smaller Functions — SRP + Complexity
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/runtime/src/context-resolver.ts:177-245` (69L with 4+ nesting levels)
- **Current:** Single function handles: when-predicate matching, content resolution, wrapping, truncation, diagnostics collection
- **Suggested:** Extract inner loop into `resolveSectionWithDiagnostics()` (20L), `applyTruncationIfNeeded()` (15L); reduce main function to orchestration
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1.5h  ·  **Tests:** context-resolver.test.ts (add 5 new integration cases covering all extract paths)

### 6. Split context-resolver.ts Section Dispatch — OCP
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/runtime/src/context-resolver.ts:336-354`
- **Current:** `resolveSection()` switch on section.type; adding new types requires modifying this file
- **Suggested:** Introduce `SectionResolver` interface with type-specific implementations; register in map; iterate over registry instead of switch
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** 2.5h  ·  **Tests:** context-resolver.test.ts (add 3 cases: new custom resolver registration, fallback)

### 7. Extract Template Parsing Validation — SRP
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/runtime/src/context-template.ts:109-482` (374L of parsing + validation)
- **Current:** `parseContextTemplate()` and 30+ helper functions tightly couple TOML parsing with validation logic
- **Suggested:** Create `template-validator.ts` with pure validation functions; keep parsing in template.ts but call validator functions
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** 2h  ·  **Tests:** template-validator.test.ts (8 new cases: each validation rule)

### 8. Split CreateSessionOptions into Strategy Objects — ISP
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/runtime/src/session/options.ts:7-40`
- **Current:** Single 41-line interface mixes Claude SDK fields, Codex-specific config, model selection, and permissions (implementors must ignore ~60% of fields)
- **Suggested:** Create `ClaudeSDKSessionOptions`, `CodexSessionOptions`, `BaseSessionOptions`; use composition with kind-based selection
- **Risk:** High  ·  **API-impact:** public-surface  ·  **Effort:** 3h  ·  **Tests:** session factory tests updated (3 new per subtype)

### 9. Replace Module-Level Registry State in factory.ts — DIP
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/runtime/src/session/factory.ts:5-16`
- **Current:** Global mutable `sessionRegistry` requires `setSessionRegistry()` call; implicit dependency, hard to test
- **Suggested:** Change module to factory function that accepts registry as parameter; update callers to pass registry explicitly
- **Risk:** High  ·  **API-impact:** public-surface  ·  **Effort:** 2h  ·  **Tests:** factory.test.ts (3 new cases: registry passed, fallback, error)

### 10. Extract Memory Store Locking Strategy — SRP + OCP
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/runtime/src/agent-memory/store.ts:169-299` (advisory lock + process lock)
- **Current:** Two lock implementations (Python fcntl + process queue) tightly coupled in MemoryStore
- **Suggested:** Create `LockStrategy` interface; implement `PythonFcntlLock` and `ProcessQueueLock`; inject into MemoryStore
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** 2.5h  ·  **Tests:** store.test.ts (4 new: each lock strategy, fallback sequence)

## Code Smells

| Smell | Location | Severity |
|-------|----------|----------|
| **Deep nesting (4+ levels)** | context-resolver.ts:186-227 (resolveZone loop) | Med |
| **Duplicated type guard (isRecord)** | 4 files (template.ts, resolver.ts, system-prompt.ts, vars.ts) | Low |
| **Duplicated file read + error handling** | store.ts:90-98, 206-213, context-resolver.ts:675-684 | Low |
| **Magic timeout constants** | context-resolver.ts:22-23 (5000, 250) | Low |
| **Long method** | resolveZone() 65L with conditional logic | Med |
| **Long method** | resolveContextTemplateDetailed() 45L with nested ternaries | Med |
| **Long method** | parseSection() 92L switch with 5 case branches | Med |
| **Conditional complexity** | matchesWhenPredicate() 35L with nested if-checks | Low |
| **Hardcoded protocol strings** | service-probe.ts:3-5 (unix://, tcp://, http(s), ws(s) checks) | Low |
| **Fat interface** | CreateSessionOptions 34 properties, ~60% unused per kind | High |
| **Fat interface** | ContextResolverContext 18 properties, many optional | Med |
| **Global mutable state** | factory.ts:5 sessionRegistry | High |
| **Implicit dependency on Bun** | store.ts:246 Bun.spawn in production code | Med |
| **Primitive obsession in results** | Multiple union types instead of discriminated unions (StoreResult, ScanResult) | Low |

## Quick Wins (low risk, high value)

1. **Extract type-guards.ts utility** (30m): Create shared `isRecord()`, `isString()`, `isArray()`, `isNumber()` exports; import in 4+ files. Reduces duplication, improves maintainability. Tests: 4 new cases per guard. Risk: Low.

2. **Extract file-reader.ts utility** (30m): Centralize `readFile()` + `readOptionalFile()` + ENOENT handling used in store.ts and context-resolver.ts. Reduces duplication by 2 copies. Tests: 2 new test cases. Risk: Low.

3. **Extract constants to dedicated module** (15m): Move timeout constants (5000ms, 250ms) and separators to top-level exports in `constants.ts`. Improve discoverability and reduce magic numbers. Risk: Low.

4. **Add JSDoc comments to complex private functions** (20m): Document `resolveZone()`, `acquireAdvisoryLock()`, `parseWhenPredicate()` intent and parameter semantics. Zero code risk. Risk: None.

## Technical Debt Notes

- **MemoryStore locking is environment-specific:** Falls back from Python fcntl (Linux/macOS) to process queue (any platform). Consider abstracting lock strategy to allow injection of alternative (e.g., platform-native locks on Windows). Effort: 2.5h refactoring.

- **Section type dispatch not extensible:** Adding new ContextSection types requires modifying `resolveSection()` switch (context-resolver.ts) and `parseSection()` switch (context-template.ts). Consider registry pattern (OCP) if new types expected. Effort: 3h for both switches.

- **ContextResolverContext mixes optional concerns:** Optional fields like `scaffoldPackets`, `agentProfile`, `env` signal weak cohesion. Consider decomposing into focused interfaces per resolver path. Effort: 2h + test updates.

- **Error handling in resolveSection():** Functions intentionally swallow errors (exec, service probe, file read) and return `undefined`. Callers must infer failure reason from absence; consider structured error objects if debugging needed. Low priority unless observability required.

- **No centralized logging:** Security-sensitive operations (memory store writes, template resolution failures) lack structured logging hooks; only guarded `console.debug()` for harness detection failures. Consider injecting logger interface if audit trail needed.
