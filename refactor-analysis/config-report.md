# SOLID / code-smell audit — `packages/config` (spaces-config)

## Overall assessment

The package was recently refactored (commit `e238805`, "SOLID/code-smell cleanup pass
across all 17 packages") and is in good shape. Most files already use guard-clause
de-nesting, extracted private helpers, named constants for magic numbers, and `Record`
lookup tables instead of switch chains. The findings below are modest, mostly Low-risk
internal dedupe/constant extractions plus a handful of deferred public-surface or
behavior-touching items. No god objects or large undecomposed functions were found.

Files read in full: `materializer/permissions-toml.ts`, `orchestration/install.ts`,
`core/config/agent-profile-toml.ts`, `git/repo.ts`, `resolver/placement-resolver.ts`,
`orchestration/explain/format-text.ts`, `orchestration/materialize-refs.ts`,
`materializer/hooks-toml.ts`, `materializer/link-components.ts`,
`resolver/validator.ts` (partial), `store/paths.ts` (relevant sections). Cross-package
usage greps run for deprecated members.

---

## Repeated TOML optional-string parse block in agent-profile-toml
- File: packages/config/src/core/config/agent-profile-toml.ts:342
- Risk: Low
- API-impact: internal-only
- Smell: The pattern `if (value['x'] !== undefined) { if (typeof value['x'] !== 'string') fail(...); options.x = value['x'] }` is copy-pasted ~10 times across `parseClaudeOptions`, `parseCodexOptions`, and `parseBrain` (lines 342-359, 386-438, 300-322).
- Proposed change: Extract a private `parseOptionalString(value, key, source, path): string | undefined` helper (mirroring the existing `parseStringArray`) and call it from each site. Behavior-preserving — same `fail()` calls, same assignments.

## Repeated enum-validated string parse block in parseCodexOptions
- File: packages/config/src/core/config/agent-profile-toml.ts:404
- Risk: Low
- API-impact: internal-only
- Smell: `approval_policy` (404-417) and `sandbox_mode` (418-431) repeat an identical "must be a string → must be in Set → assign" block differing only in the Set and the property.
- Proposed change: Extract a private `parseOptionalEnum(value, key, allowedSet, label, source, path)` helper. Behavior-preserving.

## Duplicated `parseStringArray`-style array narrowing in TOML parsers
- File: packages/config/src/materializer/permissions-toml.ts:226
- Risk: Low
- API-impact: internal-only
- Smell: `parsePermissionsToml` repeats `Array.isArray(x['k']) ? (x['k'] as string[]) : undefined` for every field (lines 229, 237, 245-246, 254, 262-265); the same idiom recurs in `parseHooksToml` (hooks-toml.ts:152) and `readHooksWithPrecedence` (hooks-toml.ts:454).
- Proposed change: Add a tiny private `asStringArray(v: unknown): string[] | undefined` helper inside each module and reuse. Purely internal, behavior-preserving.

## `populateStore` / `populateSnapshots` are near-duplicate functions
- File: packages/config/src/orchestration/materialize-refs.ts:276
- Risk: Med
- API-impact: internal-only
- Smell: `populateSnapshots` (materialize-refs.ts:276-306) and `populateStore` (install.ts:186-216) are equivalent except `populateStore` reads `aspHome`/`registryPath` from options while `populateSnapshots` takes them as params. Both build a `PathResolver`, loop over `lock.spaces`, skip non-`registry` entries, skip existing snapshots, and `createSnapshot`.
- Proposed change: Extract one shared private `populateSnapshotsFromLock(lock, registryPath, aspHome)` and call it from both. `populateStore` is exported, so keep its signature; only its body changes. Behavior-preserving.

## Magic git timeout numbers repeated in repo.ts
- File: packages/config/src/git/repo.ts:156
- Risk: Low
- API-impact: internal-only
- Smell: Raw timeout literals `300000` (clone) and `120000` (fetch/pull/push, three sites: 191, 222, 611) with `// 5 minute` / `// 2 minute` comments.
- Proposed change: Introduce module-private named constants `CLONE_TIMEOUT_MS = 5 * 60_000` and `NETWORK_OP_TIMEOUT_MS = 2 * 60_000` and reference them. Behavior-preserving.

## Repeated try/catch stat-as-boolean helpers
- File: packages/config/src/materializer/link-components.ts:139
- Risk: Low
- API-impact: internal-only
- Smell: `isDirectory` (exported, 156-163) and `fileExists` (private, 184-191) are the same try/catch-around-`stat`/`access` shape; the `linkComponents` loop (139-147) re-implements the directory check inline.
- Proposed change: Use the existing `isDirectory` helper inside `linkComponents` instead of the inline `stat` try/catch; keep `fileExists` as-is. Only call sites change, not `isDirectory`'s signature. Behavior-preserving.

## Duplicated agent/project branch in computeSpaceIntegrity
- File: packages/config/src/resolver/placement-resolver.ts:224
- Risk: Low
- API-impact: internal-only
- Smell: The `agent:` branch (225-232) and `project:` branch (233-240) are structurally identical — strip prefix, join `<root>/spaces/<id>`, hash-if-exists-else-marker — differing only in prefix regex, root, and fallback marker string.
- Proposed change: Extract a private `integrityForFilesystemSpace(root, idPrefixRegex, marker)` helper and call it for both branches. Behavior-preserving.

## Magic literal file/ref names in placement-resolver
- File: packages/config/src/resolver/placement-resolver.ts:298
- Risk: Low
- API-impact: internal-only
- Smell: Bare string literals `'SOUL.md'`, `'HEARTBEAT.md'`, `'agent-profile.toml'`, `'asp-targets.toml'`, `'spaces'`, and ref prefixes `'agent-root:///'` / `'project-root:///'` appear inline (lines 298, 323, 391, 407, 226/233, 377).
- Proposed change: Hoist module-private `const` names (e.g. `SOUL_FILENAME`, `HEARTBEAT_FILENAME`, `AGENT_PROFILE_FILENAME`, `AGENT_ROOT_REF_PREFIX`). Behavior-preserving.

## Shared collision-detection map+throw pattern
- File: packages/config/src/orchestration/materialize-refs.ts:330
- Risk: Low
- API-impact: internal-only
- Smell: `discoverSkills` (330-341) and `detectCommandConflicts` (352-372) each build a `Map<name, owner>` and throw on a second insert; the dedupe shape is identical (only the error-message text differs).
- Proposed change: Extract a private `assertNoNameCollision(...)` helper that owns the throw; pass a kind label so the existing message wording is preserved exactly. Behavior-preserving.

---

## DEFERRED (High-risk or public-surface)

## `readHooksToml` silently swallows non-ENOENT errors
- File: packages/config/src/materializer/hooks-toml.ts:173
- Risk: High
- API-impact: internal-only
- Smell: The catch returns `null` on ENOENT (correct) but then has a second unconditional `return null` (line 177) that swallows TOML parse failures and real IO errors. This contradicts the repo's documented "never silently capture errors" policy that the sibling `readPermissionsToml` (permissions-toml.ts:284-292) follows by re-throwing non-ENOENT.
- Proposed change: Re-throw non-ENOENT errors as `readPermissionsToml` does.
- Reason it needs a human: Changing `return null` to `throw err` is a runtime behavior change — currently-tolerated malformed `hooks.toml` would become a hard install failure; needs confirmation of desired semantics + a test.

## Deprecated public export `getStorePath` appears unused outside its own test
- File: packages/config/src/store/paths.ts:69
- Risk: High
- API-impact: public-surface
- Smell: `getStorePath` is `@deprecated` and re-exported from `store/index.ts`. A repo-wide grep finds no consumers other than its own `paths.test.ts` — removable dead public surface.
- Proposed change: Remove the export (and its test) after confirming no downstream pins.
- Reason it needs a human: It is an exported package symbol (spaces-config public API); removal is a breaking change for external/hrc-runtime/ACP consumers not visible in this repo.

## Deprecated public member `PathResolver.store`
- File: packages/config/src/store/paths.ts:305
- Risk: High
- API-impact: public-surface
- Smell: `@deprecated` getter aliasing `snapshots`; still consumed by cli `doctor.ts`, `gc.ts`, `list.ts`.
- Proposed change: Migrate callers to `.snapshots`, then drop the alias.
- Reason it needs a human: Public class member still in use; migrating callers and removing the alias is a coordinated cross-package public-surface change requiring sign-off.
