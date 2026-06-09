# Refactor Analysis — spaces-harness-pi-sdk

Package dir: `packages/harness-pi-sdk`
Package type chosen: **leaf / adapter** (a harness adapter + session implementation that translates
the Pi coding-agent SDK into the `spaces-runtime` / `spaces-config` contracts; no concurrency-critical
or hot-loop code).

## Summary

This package has clearly already absorbed the two prior SOLID/code-smell passes (T-02028, T-02030).
The duplication that this kind of adapter normally accretes has been extracted into single-source-of-truth
modules: `pi-session/hook-runtime.ts`, `pi-session/manifest-loading.ts`, `pi-session/sdk-entry.ts`,
`pi-session/bundle-manifest-types.ts`, and `pi-session/event-types.ts` (named constants for every SDK
event/hook string). The hard part of the package — the held-latest event-mapping state machine in
`pi-session.ts` — is decomposed into small total functions (`flushHeld`, `flushTerminal`, `handleAgentEnd`,
`handleTurnEnd`, `handleMessageEnd`) and is covered by a thorough characterization suite (`pi-session.test.ts`,
9 mapping tests). Spread-projection sites consistently use explicit conditional-include projection rather than
`{...obj}`, so the excess-property hazard the brief warns about is already avoided.

The result is an **honest near-zero**: there are **no auto-applicable Low/Med + internal-only refactors**
that survive pressure-testing. The one substantive finding is a **latent behavior defect** (a redesign, not
a refactor) in the runner's model-string parsing, surfaced below as a deferred finding.

## Public boundary verdict

The public surface (`src/index.ts` → `PiSdkAdapter`/`piSdkAdapter`, `register`, and the `pi-session`
re-exports) is coherent and matches usage:

- `register()` is the canonical entrypoint; it wires the adapter into the harness registry and registers
  the `'pi'` session factory. Its option-forwarding uses explicit conditional spreads (no excess-property leak).
- `pi-session/index.ts` re-exports both this package's own symbols and a curated set of `@mariozechner/pi-coding-agent`
  symbols (`AuthStorage`, `ModelRegistry`, `createCodingTools`, etc.). This is a deliberate facade so downstream
  consumers depend on `spaces-harness-pi-sdk` rather than reaching into the SDK directly. Leave as-is — narrowing
  it would be a `[M02]` contract change with external (cross-package) consumers and no demonstrated benefit.
- `PiSdkAdapter` implements the `HarnessAdapter` interface from `spaces-config`; method set is dictated by that
  interface, not over-wide.

No boundary `[T07]`/`[M02]` change is warranted.

## Findings by mechanism

### A. Make-safe `[T40]` — already satisfied
The two highest-risk surfaces (the event-mapping state machine and `composeTarget`/`buildRunArgs`) already
have characterization tests (`pi-session.test.ts`, `pi-session.getMetadata.test.ts`, `pi-sdk-adapter.test.ts`,
including the `T-00881` model-format regression). No new make-safe work is a prerequisite for the rest.

### E. Quality `[T18]` — runner model parsing (DEFERRED, see deferred findings)
`pi-sdk/pi-sdk/runner.ts:245` parses the `--model` argument as `provider:model` (`split(':')`), but the
adapter (`pi-sdk-adapter.ts`) emits and the `T-00881` regression test pins **slash-separated** model IDs
(`openai-codex/gpt-5.5`), and `buildRunArgs` always passes `--model <slash-form>`. The colon split therefore
yields `modelId === undefined` and throws `Model must be specified as provider:model` for every adapter-launched
run that specifies a model. This is a **behavior change to fix** (it alters whether the runner errors), and the
correct provider/model split is non-obvious (`ModelRegistry.find(provider, model)` takes two args; the `:` vs `/`
convention must be reconciled against the SDK's own registry keys). Flagged as redesign — do NOT auto-apply.

### Mechanisms with no actionable finding (pressure-tested, left alone)

- **`[T16]` de-abstract / collapse premature abstraction** — Considered the parallel
  `loadPiSdkBundle` (`bundle.ts`) vs the runner's inline bundle-loading (`runner.ts` `main`). They already
  share the load primitives (`loadBundleManifest`, `collectBundleSpaceIds`, `buildHookExtension`,
  `loadManifestExtensionFactories`, `loadManifestContextFiles`); the residual difference is real (the library
  loader returns a typed `Skill[]`/`ExtensionFactory[]` result object for in-process embedding; the runner
  builds `sessionOptions` and drives `InteractiveMode`/`runPrintMode`). Folding them would couple the library
  path to the standalone-process path. Load-bearing divergence — leave.
- **`[T15]` extract missing abstraction (duplicated `PiSdkBundle*` types)** — `pi-sdk-adapter.ts` defines its
  own `PiSdkBundleManifest`/`PiSdkBundleHookEntry` etc. (lines 66-93) with `schemaVersion: 1`/`harnessId: 'pi-sdk'`
  **literal** types, while `bundle-manifest-types.ts` defines the same names with **widened** (`number`/`string`)
  types. This looks like duplication but is deliberate: the adapter's copy is the **producer** contract (it writes
  a v1 `pi-sdk` manifest, so literal types are the right strictness), and the shared module is the **consumer**
  contract (it must accept any well-formed manifest it reads back). Collapsing them would either over-constrain the
  reader or under-constrain the writer. Leave; the comment in `bundle-manifest-types.ts` already documents the SoT
  intent for the consumer side.
- **`[T15]` named constants for verbose-logging event strings** — `runner.ts` `buildVerboseLoggingExtension`
  uses raw `'turn_start'`/`'tool_call'`/... literals instead of `hook-runtime.ts`'s `PI_LIFECYCLE_EVENT`. But
  `PI_LIFECYCLE_EVENT` is module-private to `hook-runtime.ts` and is a **different vocabulary** (the four hook
  lifecycle events the hook-runtime binds), whereas the verbose extension subscribes to a broader, diagnostic-only
  set (`turn_start`/`turn_end`/`tool_result`). Exporting and sharing would over-couple a debug aid to the hook
  contract for no behavioral gain. Leave.
- **`[T17]` partial→total / "can't happen" arms** — The `default: return []` in `mapPiEventToUnified` and the
  `default` no-op in `runner.ts parseArgs` are **real reachable guards** (the SDK emits event types this mapper
  intentionally drops; the arg loop must skip non-flag positionals). Keep explicit — do not narrow.
- **`[T22]` guard clauses / nesting** — The deepest logic (`runHooks` in `hook-runtime.ts`, `mapToolResultContent`)
  is already flattened with early `continue`/`return` and helper predicates. No nesting ≥4 remains.
- **`[T18]` swallowed `catch {}`** — Every empty catch is an intentional existence/availability probe
  (`fileExists`, `isFile`, `isDirectory`, `hasCredentials`, `dirHasEntries`, `discoverExtensions`,
  `detect`'s dynamic-import probe). These are presence checks, not error suppression. Keep.
- **`[T21]` parameter object** — `runHookScript(script, payload, env, cwd)` and `buildHookExtension`'s already-an-
  options-object signature are within bounds; no >4 positional data-clump worth reifying.
- **`[T12]` make illegal states unrepresentable** — `PiSessionState` is already a closed union and the
  `start()`/`sendPrompt()`/`stop()` guards enforce the transitions; the held-latest state (`held`/`agentActive`)
  is the genuinely tricky invariant and is documented + test-pinned. No cheap win here.

## Deliberately left alone (contraindications honored)

| Item | Why it stays |
|---|---|
| SDK re-export facade in `pi-session/index.ts` | Deliberate dependency-inversion facade; narrowing is an `[M02]` contract change with cross-package consumers. |
| Producer vs consumer manifest types (literal vs widened) | Defense-in-depth: strict writer, lenient reader. Diverging copies are load-bearing. |
| `loadPiSdkBundle` vs runner inline loading | Shared primitives already extracted; residual difference (in-process result object vs process-driving) is real. |
| Empty `catch {}` blocks | All are existence/availability probes, not error swallowing. |
| `default` arms in event mapper / arg parser | Reachable, intentional (drop unknown SDK events; skip positionals). |
| `PI_LIFECYCLE_EVENT` not shared with verbose logger | Different vocabularies; sharing over-couples a debug aid. |

## Outside-in apply sequence

No auto-applicable internal-only refactors. The only recommended action is **out of scope for the apply phase**:

1. (Redesign, route to an implementer, NOT auto-apply) Reconcile the runner's `--model` parsing in
   `pi-sdk/pi-sdk/runner.ts:245` with the slash-separated model-ID convention the adapter and the `T-00881`
   regression test already enforce. Add a runner-side characterization test that drives `buildRunArgs`' actual
   output (`openai-codex/gpt-5.5`) through the runner's model resolution before changing the split, so the fix
   is pinned against the real producer format.

Everything else: no change. This is a clean target post the two prior passes.
