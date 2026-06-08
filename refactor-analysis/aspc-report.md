# aspc (spaces-aspc) — SOLID / code-smell audit

Scope: all non-test source under `packages/aspc/src/` — cli.ts, client.ts, diagnostics.ts,
facade.ts, index.ts, profileSelector.ts, service.ts (639 LOC total).

Note: a prior report existed at this path with stale line references (e.g. it lists
"Extract Profile Selection Logic into profileSelector.ts" as a TODO, but that module already
exists; it points at service.ts:159-223 for selection code that has since been moved out). That
report predates the recent cleanup and has been replaced by this current audit.

## Overall assessment

This package was put through the SOLID/code-smell cleanup pass (commit `e238805`) and the evidence
is visible throughout: diagnostic codes hoisted into a single `DIAGNOSTIC_CODES` constant
(`diagnostics.ts`), JSON-RPC method names in `ASPC_METHODS`/`BROKER_METHODS` tables (`facade.ts`),
a table-driven `SELECTOR_CRITERIA` profile selector already extracted into its own `profileSelector.ts`,
broker routes expressed as a `brokerMethodTable` lookup rather than copy-pasted `server.register`
blocks, and extracted `fail*` response builders in `service.ts`. The compiler dependency is already
injectable via `AspcServiceOptions.compiler`. Functions are short (largest is `brokerMethodTable` at
~46 lines, but it is a flat data table, not branching logic). Nesting is shallow, guard clauses are
used, and there is no dead code, no commented-out blocks, and no god object.

The findings below are minor and low value. This is an honest "already clean" result.

## Duplicated broker.start dispatch-spreading

- File: packages/aspc/src/service.ts:95
- Risk: Low
- API-impact: internal-only
- Smell: The four-arg call shape `broker.start(dispatch.startRequest, dispatch.dispatchEnv, dispatch.runtime, dispatch.lifecyclePolicy)` is duplicated verbatim between `service.ts:95-100` (`compileAndStart`) and `facade.ts:148-153` (`brokerMethodTable` start row). If `Broker.start`'s positional arg order changes, both sites must change in lockstep.
- Proposed change: Extract a small internal helper `startFromDispatch(broker, dispatch: InvocationDispatchRequest)` that spreads the dispatch fields, and call it from both sites. The two callers live in different files, so a true single-source dedupe needs a new shared internal function — keep it internal-only (do not widen any export). Marginal; only worth doing while already touching this area.

## Repeated `jsonrpc: '2.0'` envelope literal

- File: packages/aspc/src/facade.ts:83
- Risk: Low
- API-impact: internal-only
- Smell: The literal `'2.0'` for the JSON-RPC version is repeated three times within the file: `emitEvent` (line 59), `registerAspcMethod` (line 83), and `registerBrokerMethods` (line 182). Magic string.
- Proposed change: Introduce a file-local `const JSONRPC_VERSION = '2.0'` and reference it at the three construction sites. Cosmetic and behavior-preserving.

## Anonymous inline cast in `placementDispatchEnv`

- File: packages/aspc/src/service.ts:168
- Risk: Low
- API-impact: internal-only
- Smell: `req.compileRequest.placement as { dispatchEnv?: Record<string, string> | undefined }` is an inline structural cast to an anonymous type to reach an optional field the typed `placement` does not expose. Opaque and not named/reused.
- Proposed change: Hoist the cast target to a named file-local type, e.g. `type PlacementWithDispatchEnv = { dispatchEnv?: Record<string, string> | undefined }`, and cast to that. Readability only. The real gap is a missing field on the upstream `placement` contract in `spaces-runtime-contracts`; do not chase that from here — keep the edit cosmetic and internal-only.

## Facade version constant hand-synced with package.json

- File: packages/aspc/src/service.ts:26
- Risk: Med
- API-impact: public-surface
- Smell: `ASPC_FACADE_VERSION = '0.1.1'` is hand-duplicated from `package.json`'s `version` and surfaced over the wire by `aspc.hello`. The inline comment already documents the build constraint (rootDir is `./src`, so the manifest can't be imported without breaking emit) — this is a deliberate trade-off, but a drift hazard: bumping package.json without editing this constant silently ships a wrong version on the hello response.
- Proposed change: DEFER — needs a human / build decision and the value is part of the public `aspc.hello` protocol response. Options all touch build or public output (build-time generated `version.ts`, or a bundler `define`/replace). Documenting only; not auto-applied.

## Summary of counts

- Applicable (Low/Med AND internal-only, safe to auto-apply): 3
- Deferred (High-risk OR public-surface): 1
