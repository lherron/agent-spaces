# harness-pi-sdk SOLID / code-smell audit

Package: `spaces-harness-pi-sdk` (`packages/harness-pi-sdk/`)
Scope: all non-test source under `src/`.

Overall this package is in good shape — it was clearly part of the recent SOLID
cleanup pass (T-02028). Event mapping in `pi-session.ts` is already decomposed
into small named helpers (`flushHeld`, `flushTerminal`, `handleAgentEnd`,
`handleTurnEnd`, `handleMessageEnd`), event-type strings are centralized in
`event-types.ts`, and the bundle/hook runtime is deduped into `hook-runtime.ts`.
The findings below are mostly residual cross-file duplication and a couple of
latent correctness smells that must be deferred because they would change
behavior or public surface.

---

## Duplicated SDK-entry resolution (constant + function)
- File: packages/harness-pi-sdk/src/adapters/pi-sdk-adapter.ts:64
- Risk: Med
- API-impact: internal-only
- Smell: `SDK_ENTRY_CANDIDATES` and `resolveSdkEntry(sdkRoot)` are copy-pasted into `packages/harness-pi-sdk/src/pi-sdk/pi-sdk/runner.ts:31` (the runner's version uses `access` instead of the adapter's `fileExists`, but the logic is identical). Same candidate list, same loop, same null fallback.
- Proposed change: Extract the candidate list + resolver into a single internal module (e.g. `pi-session/sdk-entry.ts`) and import from both sites. Behavior-preserving since both iterate the same candidates and return the first that exists. (Cross-file move, hence Med.)

## Near-duplicate manifest extension/context loading in bundle.ts vs runner.ts
- File: packages/harness-pi-sdk/src/pi-session/bundle.ts:42
- Risk: Med
- API-impact: internal-only
- Smell: The block that builds `extensionFactories` (hook-extension push + the `for (const extension of manifest.extensions)` dynamic-import loop with the "does not export a default function" throw) and the `contextFiles = await Promise.all(...)` loop are duplicated almost line-for-line in `runner.ts:199`-`244`. The `hook-runtime.ts` header comment claims this machinery is centralized, but the extension-import + context-read portions are not.
- Proposed change: Extract two internal helpers (e.g. in `hook-runtime.ts` or a sibling) — `loadManifestExtensionFactories(manifest, bundleRoot)` and `loadManifestContextFiles(manifest, bundleRoot)` — and call them from both `bundle.ts` and `runner.ts`. Behavior-preserving; both call sites already resolve paths and import identically.

## Magic hook-event strings in hook-runtime.ts not centralized
- File: packages/harness-pi-sdk/src/pi-session/hook-runtime.ts:199
- Risk: Low
- API-impact: internal-only
- Smell: String literals `'pre_tool_use'`, `'post_tool_use'`, `'session_start'`, `'session_end'`, and the Pi lifecycle names `'tool_call'`, `'tool_result'`, `'session_start'`, `'session_shutdown'` are scattered across `runHooks` calls and `pi.on(...)` registrations (lines 199, 225, 240, 253, 263, 268). `event-types.ts` already establishes the pattern of centralizing such strings (`PI_EVENT`, `HOOK_EVENT`) but does not cover these.
- Proposed change: Add named constant objects (e.g. `HOOK_RUNTIME_EVENT` / `PI_LIFECYCLE_EVENT`) local to this module (or in `event-types.ts`) and reference them. Internal-only, behavior-preserving (same literal values).

## Redundant type-guard duplicated with map branches in mapContentBlocks
- File: packages/harness-pi-sdk/src/pi-session/pi-session.ts:657
- Risk: Low
- API-impact: internal-only
- Smell: `mapContentBlocks` does a `.filter(...)` with a 4-arm type predicate (`text | image | media_ref | toolCall`) and then a `.map(...)` that re-discriminates the same four arms. The `block.type === ...` checks are duplicated.
- Proposed change: Collapse into a single `.flatMap((block) => mapContentBlock(block))` where one private `mapContentBlock` returns `ContentBlock | undefined` and undefined entries are dropped. Removes the duplicated discrimination. Behavior-preserving.

## Duplicated media_ref construction
- File: packages/harness-pi-sdk/src/pi-session/pi-session.ts:682
- Risk: Low
- API-impact: internal-only
- Smell: The `media_ref` construction `{ type:'media_ref', url, ...(typeof mimeType==='string'?...), ...(filename), ...(alt) }` appears twice — in `mapContentBlocks` (line 682) and in `mapToolResultItem` (line 725).
- Proposed change: Extract a private `makeMediaRefBlock(block)` helper returning the `media_ref` ContentBlock and call from both sites. Behavior-preserving.

## Duplicated string-coercion ternary across event handlers
- File: packages/harness-pi-sdk/src/pi-session/pi-session.ts:484
- Risk: Low
- API-impact: internal-only
- Smell: The pattern `typeof piEvent.<field> === 'string' ? piEvent.<field> : undefined` is repeated for `turnId`, `messageId`, `reason` across `handleAgentEnd`, `handleTurnEnd`, `handleMessageEnd`, and the `mapPiEventToUnified` switch (lines 461, 484, 504, 522, 565, 578, 588).
- Proposed change: Add a tiny private `asString(value: unknown): string | undefined` helper and replace the inline ternaries. Behavior-preserving, internal-only.

## Empty validateSpace with dead accumulators
- File: packages/harness-pi-sdk/src/adapters/pi-sdk-adapter.ts:266
- Risk: Low
- API-impact: internal-only
- Smell: `validateSpace` builds `const errors: string[] = []` and `const warnings: string[] = []`, never pushes to either, then returns `{ valid: errors.length === 0, errors, warnings }` (always valid, always empty). The local accumulators are dead.
- Proposed change: Simplify the body to `return { valid: true, errors: [], warnings: [] }` (same return shape / `HarnessValidationResult` contract). The method signature (part of the `HarnessAdapter` interface) is untouched, so this is internal-only. Behavior-preserving.

## Model-separator mismatch between adapter args and runner parsing
- File: packages/harness-pi-sdk/src/pi-sdk/pi-sdk/runner.ts:273
- Risk: High
- API-impact: internal-only
- Smell: Adapter model ids and the `--model` default use a `/` separator (`openai-codex/gpt-5.5`, `pi-sdk-adapter.ts:61`/`221`), and `buildRunArgs` forwards `--model <provider>/<model>`. But `runner.ts:273` parses with `args.model.split(':')` and throws `'Model must be specified as provider:model'` when there is no colon — so a `/`-separated id fails resolution. `pi-session.ts` instead takes separate `provider`/`model` fields, so the two paths disagree on wire format.
- Proposed change: DEFER — reconciling the separator (or accepting both `:` and `/`) changes runtime model-resolution behavior and the thrown-error contract. Needs a human to confirm the canonical wire format and whether the runner path is exercised. Document only.

## `--resume` continuation flag is wired but unhandled by the runner
- File: packages/harness-pi-sdk/src/adapters/pi-sdk-adapter.ts:607
- Risk: High
- API-impact: public-surface
- Smell: `buildRunArgs` pushes `--resume` when `options.continuationKey` is set, with an inline comment that the runner "may not implement resume yet". `runner.ts:parseArgs` has no `--resume` case, so it hits the `default` branch and throws `Unknown argument: --resume`. This is latent-broken wiring that would crash the runner if `continuationKey` is ever supplied.
- Proposed change: DEFER — either drop the flag emission or implement `--resume` in the runner. Both alter run-launch behavior / the documented forward-compat contract, and the direction is a product call. Document only.

---

### Summary of safe (auto-applyable) findings
Low/Med + internal-only and behavior-preserving:
1. Dedup SDK-entry resolution (Med)
2. Dedup manifest extension/context loading (Med)
3. Centralize hook-runtime event strings (Low)
4. Collapse `mapContentBlocks` filter+map duplication (Low)
5. Extract `makeMediaRefBlock` helper (Low)
6. Extract `asString` coercion helper (Low)
7. Simplify dead-accumulator `validateSpace` (Low)

### Deferred (need a human)
- Model-separator mismatch (High, behavior/error-contract change)
- `--resume` latent-broken wiring (High, public run-launch surface)
