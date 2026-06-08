# 🔧 Refactoring Analysis
**Target:** packages/config/src  
**Lines analyzed:** 29,959  ·  **Generated:** 2026-06-07  ·  **Focus:** all

## 📊 SOLID Scorecard
| Principle | Status | Issues |
|-----------|--------|--------|
| **S (SRP)** | 🟡 | 4 files >300 lines with multiple responsibilities; `placement-resolver.ts` mixes resolution, instruction loading, and integrity computation |
| **O (OCP)** | 🟡 | 2 type-keyed switch statements without extension seams; hardcoded rule lists in lint dispatcher |
| **L (LSP)** | 🟢 | No violations detected |
| **I (ISP)** | 🟡 | `LintContext` requires spaces array; type-heavy interfaces >15 members (harness.ts, permissions-toml.ts) |
| **D (DIP)** | 🟡 | Direct instantiation of `PathResolver` in 10+ locations; hardcoded rule array in lint/rules/index.ts; `new Map()` coupling |

---

## 🎯 Priority Refactorings

### 1. Split `placement-resolver.ts` — SRP violation
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/config/src/resolver/placement-resolver.ts:1–451`
- **Current:** 450 lines; mixes 5 concerns: materialization resolution, instruction loading, space composition, integrity computation, cwd resolution
- **Suggested:** Extract into separate modules: `placement-materialization.ts`, `placement-instructions.ts`, `placement-integrity.ts`; use composition in facade
- **Risk:** Medium  ·  **API-impact:** internal-only  ·  **Effort:** 4 hours  ·  **Tests:** Update 15+ test imports
- **Blast radius:** `orchestration/resolve.ts`, `orchestration/build.ts`, placement resolver tests

### 2. Extract bundle resolution logic from `placement-resolver.ts` — OCP violation
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/config/src/resolver/placement-resolver.ts:139–171`
- **Current:** Two switch statements on `bundle.kind` (lines 139, 275) that will grow with new bundle types
- **Suggested:** Strategy pattern: `BundleResolverFactory` with `AgentProjectResolver`, `ComposeResolver` implementations
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 3 hours  ·  **Tests:** 8 unit tests
- **Rationale:** New bundle types (e.g., `workspace`) can be added without modifying placement-resolver

### 3. Extract lint rule dispatcher — OCP + DIP violation
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/config/src/lint/rules/index.ts:29–38`
- **Current:** Hardcoded array of rule functions; requires file edits to add rules
- **Suggested:** Dynamic rule registry: `LintRuleRegistry` with `.register()` API; rules self-register on import
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 2 hours  ·  **Tests:** 6 unit tests
- **Impact:** 7 new rules can be added without touching dispatcher

### 4. Centralize `PathResolver` instantiation — DIP violation
- **Location:** 10+ files: `orchestration/install.ts:188`, `orchestration/explain/explain.ts:199`, `store/snapshot.ts`, `resolver/lock-generator.ts`
- **Current:** Direct `new PathResolver({ aspHome })` in business logic
- **Suggested:** Dependency injection container or service factory: `PathResolverFactory.create(aspHome?: string)` with singleton caching
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 2 hours  ·  **Tests:** 10 callers to update
- **Rationale:** Enables test mocking; consolidates `aspHome` resolution logic

### 5. Decompose `install.ts` — SRP + DIP violations
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/config/src/orchestration/install.ts:1–736` (736 lines)
- **Current:** 12 responsibilities: registry management, store population, space materialization, linting, target building, harness dispatch
- **Suggested:** Extract modules: `install-registry.ts`, `install-store.ts`, `install-materialization.ts`; use `InstallCoordinator` facade
- **Risk:** Medium  ·  **API-impact:** internal-only  ·  **Effort:** 6 hours  ·  **Tests:** Update 50+ test assertions
- **Blast radius:** `orchestration/build.ts`, `orchestration/index.ts`, CLI handlers

### 6. Extract harness-specific logic from `install.ts` — OCP violation
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/config/src/orchestration/install.ts:380–450` (harness dispatch)
- **Current:** Type checks on `harness` parameter; new harnesses require install.ts edits
- **Suggested:** `HarnessAdapter` pattern: create `ClaudeAdapter`, `PiAdapter` with uniform interface; use factory
- **Risk:** Medium  ·  **API-impact:** internal-only  ·  **Effort:** 3 hours  ·  **Tests:** 8 harness-specific tests
- **Rationale:** Codex, Pi SDK support can be added without touching install.ts

### 7. Extract permission translation logic — SRP violation
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/config/src/materializer/permissions-toml.ts:1–731` (731 lines)
- **Current:** 3 responsibilities: TOML parsing, harness-specific translation (Claude vs Pi), enforcement annotation
- **Suggested:** Extract `PermissionTranslator` interface with `ClaudeTranslator`, `PiTranslator` implementations; use strategy pattern
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 3 hours  ·  **Tests:** 20 translation test cases
- **Rationale:** Future harness (Codex) permissions can reuse translators

### 8. Simplify `hooks-toml.ts` hook format conversion — Code smell
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/config/src/materializer/hooks-toml.ts:150–300` (deep nesting, 6+ levels)
- **Current:** 3-level nested loops + format conversions; multiple format branches (TOML → Claude array → Claude object)
- **Suggested:** Extract format converters: `HooksFormatter` with `toClaudeArray()`, `toClaudeObject()` methods
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 2 hours  ·  **Tests:** 15 format conversion tests
- **Rationale:** Reduces cyclomatic complexity; enables format validation per-converter

### 9. Reduce `harness.ts` interface bloat — ISP violation
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/config/src/core/types/harness.ts:1–220` (642 lines total)
- **Current:** `HarnessCatalogEntry` interface has 6 members; 4 lookup maps built inline (lines 99–115)
- **Suggested:** Split into `HarnessMeta` (id, provider) + `HarnessRuntime` (transport, frontend); lazy-load lookup maps
- **Risk:** Low  ·  **API-impact:** public-surface (type exports)  ·  **Effort:** 2 hours  ·  **Tests:** Update 25 type imports
- **Rationale:** Clarifies harness identity vs. runtime concerns; reduces module initialization cost

### 10. Extract `lint/rules/hooks-json.ts` format parsing — Code smell
- **Location:** `/Users/lherron/praesidium/agent-spaces/packages/config/src/lint/rules/hooks-json.ts:59–119` (deep nesting, 4+ levels)
- **Current:** `parseHooksContent()` has 3 branches + 6-level nesting (Array → entry → nestedHooks → nested → check)
- **Suggested:** Extract format handlers: `SimpleHooksParser`, `ClaudeArrayParser`, `ClaudeObjectParser` with common interface
- **Risk:** Low  ·  **API-impact:** internal-only  ·  **Effort:** 1.5 hours  ·  **Tests:** 8 format-specific tests
- **Rationale:** Improves readability; enables per-format validation rules

---

## 📝 Code Smells

| Smell | Location | Severity | Count |
|-------|----------|----------|-------|
| **Long methods (>50 lines)** | `install.ts`, `placement-resolver.ts`, `hooks-toml.ts`, `permissions-toml.ts`, `lock-generator.ts` | Medium | 12 functions |
| **Deep nesting (≥4 levels)** | `hooks-toml.ts` (6), `lint/rules/hooks-json.ts` (5), `closure.ts` (4), `materialize.ts` (4) | Low-Medium | 8 blocks |
| **Type-keyed switch/if-else** | `placement-resolver.ts` lines 139, 275; `closure.ts` line 128; `config/agent-profile-toml.ts` | Medium | 3 locations |
| **Hardcoded collections** | `lint/rules/index.ts:29–38`, `harness.ts:99–115`, `permissions-toml.ts:300–320` | Low | 3 locations |
| **Magic numbers** | `placement-resolver.ts:47` (BUNDLE_IDENTITY_HASH_LEN=16), `lint/rules/hooks-json.ts`, `lock-generator.ts` | Low | 5 occurrences |
| **Primitive obsession** | Strings used for bundle.kind, space types ('agent', 'project', 'registry'); wide use of `string[]` for refs | Low | 4 modules |
| **Feature envy** | `install.ts` reaches into 8 modules (store, resolver, materializer, git); `placement-resolver.ts` loads files directly | Low | 2 locations |
| **Duplicated logic** | Ref normalization in `space-composition.ts:102`, `closure.ts`, `lock-generator.ts` | Low | 3 patterns |

---

## 🚀 Quick Wins (low risk, high value)

1. **Extract `PathResolver` factory** (30 min, Low risk, internal-only)
   - Consolidate `new PathResolver()` calls into single `createPathResolver(aspHome?)` function
   - Enables mocking in tests; centralizes aspHome fallback logic
   - Files: `orchestration/install.ts:188`, `orchestration/explain/explain.ts:199`, `store/snapshot.ts`, `resolver/lock-generator.ts`

2. **Extract lint rule factory** (45 min, Low risk, internal-only)
   - Replace hardcoded `allRules` array with `LintRuleRegistry.register(rule)` API
   - Allows new rules without touching dispatcher; improves modularity
   - File: `lint/rules/index.ts:29–38`

3. **Extract hooks format converters** (1 hour, Low risk, internal-only)
   - Split `hooks-toml.ts` format logic into `HooksFormatter.toClaudeArray()`, `toClaudeObject()`
   - Reduces cyclomatic complexity; improves testability
   - File: `materializer/hooks-toml.ts:150–300`

4. **Name magic numbers** (30 min, Low risk, internal-only)
   - Add constants: `BUNDLE_IDENTITY_HASH_LEN = 16`, `HOOKS_FORMAT_VERSION = 1`
   - Improves code clarity; enables bulk edits
   - Files: `placement-resolver.ts:47`, `hooks-toml.ts`, `lock-generator.ts`

5. **Consolidate ref normalization** (45 min, Low risk, internal-only)
   - Create `utils/ref-normalization.ts` with `normalizeRefForDedup()`, `normalizeRefKey()`
   - DRY up 3 duplicate patterns across `space-composition.ts`, `closure.ts`, `lock-generator.ts`
   - Reduces future bugs in ref handling

---

## ⚠️ Technical Debt Notes

### High Priority Debt
- **Bundle type growth pending:** `placement-resolver.ts` will break with new bundle types (workspace, composite). Strategy pattern prevents this (Refactoring #2).
- **Harness proliferation risk:** `install.ts` has inline harness dispatch; Codex + Pi SDK support will bloat this file. Adapter pattern needed (Refactoring #6).
- **Install.ts is a god object:** 736 lines orchestrating 12 separate concerns. Risk of cascading changes as new features (harness support, cache modes) are added.

### Medium Priority Debt
- **Lint rule extensibility:** New rule additions require editing `lint/rules/index.ts`. Registry pattern (Refactoring #3) unblocks this.
- **Permission translation complexity:** `permissions-toml.ts` (731 lines) mixes format parsing with 3 harness-specific translators. Will degrade with Codex support.
- **Type inflation:** `harness.ts` (642 lines), `core/types/refs.ts` (340 lines) contain types + initialization logic. Split into types + factories.

### Low Priority Debt (Cosmetic)
- Hook format handling has 6-level nesting in `hooks-toml.ts`; extraction improves readability but no functional risk.
- Magic numbers used for hash lengths and format markers; naming improves clarity without code changes.
- Primitive obsession: bundle.kind, space type strings could be enums (internal-only refactor).

---

## 🛠️ Refactoring Effort Estimate
**Total effort:** ~27 hours  
**Quick wins (auto-applicable):** 3 hours  
**High-impact refactorings:** 18 hours  
**Low-priority cleanup:** 6 hours  

**Phase 1 (Week 1):** Refactorings #1–3 (Split placement-resolver, extract bundle strategy, extract lint dispatcher)  
**Phase 2 (Week 2):** Refactorings #4–6 (PathResolver factory, decompose install.ts, harness adapters)  
**Phase 3 (Week 3):** Refactorings #7–10 (Permissions translator, hooks formatter, harness type split, hooks-json parser)

