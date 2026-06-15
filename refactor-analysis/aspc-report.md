# 🔧 Refactoring Analysis — spaces-aspc

**Target:** `packages/aspc/src` (npm: `spaces-aspc`)  ·  **Files read:** 7 source + 3 test  ·  **Lines:** 647 src
**Generated:** 2026-06-14  ·  **Package type:** general (JSON-RPC facade / compiler orchestration leaf)

## 🧭 Summary

This package is already heavily and intentionally refactored: dispatch tables (broker routes, selector
criteria), single-source constant maps (`ASPC_METHODS`, `BROKER_METHODS`, `DIAGNOSTIC_CODES`), named
structural views with rationale comments, and a deliberately single-shot handler-registration contract.
Most classic smells are pre-empted and documented in-comment. Findings are few and small: one genuine
magic-string duplication of an already-exported protocol constant, and a documented hand-synced version
constant. The public boundary is narrow and sound.

## 🚪 Public boundary (assess first)

- **API surface (`index.ts`):** `AspcClient` (+ `AspcRequestHandler`); `createAspcService` (+ types
  `AspcCompiler`/`AspcService`/`AspcServiceOptions`); `createAspcFacadeServer` + `runAspcFacadeStdio`
  (+ `AspcFacadeOptions`). All request/response payload types come from `spaces-aspc-protocol`, not
  re-exported here.
- **Findings:** No T07/M02 boundary defects. The surface matches actual usage: `AspcClient` exposes one
  typed method per RPC plus a generic `request<T>` escape hatch (used by tests for `broker.*` and
  `invocation.*` routes the facade co-hosts — this is aligned, not leaky). `onRequest`/`onNotification`
  are single-shot by design with throw-on-double-register and a documented rationale (a true T12 illegal-
  state guard, already in place). `startFromDispatch` is exported from `service.ts` but consumed only by
  `facade.ts` + tests; it is intentionally NOT re-exported from `index.ts`, so it is internal surface.
- **Verdict:** 🟢 sound

## 🎯 Findings by mechanism (outside-in, highest impact first)

### 1. `brokerProtocol` literal duplicates an exported protocol constant — [T15] Extract missing abstraction

- **Location:** `service.ts:70` — `...(broker !== undefined ? { brokerProtocol: 'harness-broker/0.2' } : {})`
- **Mechanism repaired:** A wire-protocol version string that has a single authoritative definition is
  re-typed as a bare literal at a second site. The recurring concept ("the broker protocol version this
  facade speaks") should resolve to the one exported name, so a future bump (0.2→0.3) is one edit, not a
  grep-and-pray across packages.
- **Symptom that flagged it:** `grep` shows `'harness-broker/0.2'` exported as `BrokerProtocolVersion` and
  in `SUPPORTED_BROKER_PROTOCOL_VERSIONS` from `spaces-harness-broker-protocol`, yet hardcoded as a string
  in service.ts. (Contrast: `DIAGNOSTIC_CODES` already centralizes ASPC's own codes — same discipline,
  not yet applied to the imported protocol version.)
- **Current → Suggested:** Import `BrokerProtocolVersion`/`SUPPORTED_BROKER_PROTOCOL_VERSIONS` (or a single
  `BROKER_PROTOCOL_VERSION` const if one is added there) and reference it. The `AspcHelloResponse.brokerProtocol`
  field type is the literal `'harness-broker/0.2' | undefined`, so the type-checker proves equivalence.
- **Direction:** isolate (collapse the duplicate literal to the shared source)
- **Preservation:** type/compiler-proof — the field type is pinned to the same literal; a mismatch would
  not compile. Emitted value is byte-identical.
- **Falsifiable signal:** `v01-removal.red.test.ts` already asserts `hello().brokerProtocol === 'harness-broker/0.2'`;
  it stays green. If the imported constant ever diverged from the field's literal type, `tsc` fails.
- **Risk:** Low  ·  **API-impact:** internal-only (observable output unchanged)  ·  **Effort:** XS
- **Tests:** existing `v01-removal.red.test.ts` covers it; no new test needed.
- **Contraindication:** If `spaces-aspc-protocol` deliberately wants ASPC to be able to advertise a version
  it does NOT yet support in the broker package (decoupled rollout), the literal is load-bearing. Current
  code shows no such intent — the field type is locked to the same literal — so this does not apply.

### 2. `ASPC_FACADE_VERSION` hand-synced to package.json — [T15] Extract missing abstraction (noted, NOT auto-applicable)

- **Location:** `service.ts:23-26` — `const ASPC_FACADE_VERSION = '0.1.1'` with a "Keep in sync with
  package.json `version`" comment.
- **Mechanism repaired:** The single concept "this package's version" exists twice (manifest + constant)
  and is reconciled by a human-maintained comment — a known drift hazard. The repair is a build-time
  injection or a generated version module so the constant has one source.
- **Symptom that flagged it:** The in-code comment explicitly states the duplication and the reason it
  cannot be removed naively (`rootDir: ./src` would break emit if package.json were imported directly).
- **Current → Suggested:** Add a generated `version.ts` (emitted from package.json at build) or a
  `define`/build-time replacement, then import it. This changes build wiring, not just source.
- **Direction:** isolate
- **Preservation:** observational-equivalence — value must remain `'0.1.1'` until package.json bumps; a
  build-injection change alters HOW the value is produced (build config), so it is a build-mechanism change,
  not a pure in-file refactor.
- **Falsifiable signal:** `hello().facadeInfo.version` must equal package.json `version` after the change.
- **Risk:** Med  ·  **API-impact:** internal-only  ·  **Effort:** S (touches tsconfig/build, not just .ts)
- **Tests:** add a test asserting `hello().facadeInfo.version === require('../package.json').version`.
- **Contraindication:** The current emit constraint (`rootDir: ./src`) is real; a naive `import pkg from
  '../package.json'` would break the build. Any fix must respect that, which is why this is flagged as
  build-mechanism (not auto-applicable) rather than a trivial literal collapse.

## 🪶 Deliberately left alone (where-NOT)

- **`PlacementWithDispatchEnv` structural cast (`service.ts:176-184`)** — Looks like a primitive/cast smell,
  but it is load-bearing: `dispatchEnv` is genuinely absent from the typed `placement` contract in
  `spaces-runtime-contracts` (confirmed by grep). It is already isolated behind a named type + a single
  helper with a rationale comment. Removing the cast requires a *redesign* of the upstream contract, not a
  refactor here. Leave it.
- **`brokerMethodTable` `params as Parameters<typeof broker.X>[0]` casts (`facade.ts:133-171`)** — These are
  the unavoidable boundary between untyped JSON-RPC params and the typed `Broker` methods; each route
  re-validates via `validateCommand` first. This is the correct narrow seam, not a smell. The table form
  already collapsed the copy-paste (documented in-comment).
- **`SELECTOR_CRITERIA` table + `reduce` (`profileSelector.ts:18-39`)** — Already the dispatch/table form a
  T19 conditional-to-dispatch refactor would produce. Adding a selector dimension is one row. No change.
- **Single-shot `onRequest`/`onNotification` throw (`client.ts:73-90`)** — A deliberate T12 illegal-state
  guard with documented rationale (last-writer-wins foot-gun). Not a partial/no-op override to totalize.
  Keep.
- **Local `JSONRPC_VERSION = '2.0'` (`facade.ts:32`)** — `'2.0'` is repeated across `harness-broker-protocol`
  but is NOT exported there as a named constant, so the facade's local single-source const is the right
  scope; it does not duplicate a shared export. Leave (do not invent a cross-package constant in this pass).
- **`cli.ts` manual arg parsing (`cli.ts:1-24`)** — A tiny single-command parser (`run --transport stdio`).
  Below the threshold for a parameter-object or dispatch-table; introducing structure would be premature
  abstraction (T16 contra). Leave.
- **`compileRuntimePlanSafe` try/catch → diagnostic (`service.ts:130-146`)** — Correct T18 error handling:
  converts an exception into a typed `compiler_exception` diagnostic on the response, not a swallowed catch.
  Covered by `service.test.ts`. Keep.

## 🔭 If applying: outside-in sequence

1. Finding #1 (Low/internal): import the shared broker-protocol version constant into `service.ts`, drop
   the literal. Re-run `bun test packages/aspc` (v01-removal red suite proves the value); `tsc` proves the
   type.
2. Finding #2 (Med, build-mechanism): defer — route through a deliberate build-config change + new version
   test; do not bundle with #1.

## ✅ Safety checklist

- [ ] `bun test packages/aspc` green (facade E2E + service unit + v01-removal red suite).
- [ ] `tsc`/typecheck green — proves the version-constant import matches the pinned field literal.
- [ ] `hello()` output byte-identical: `brokerProtocol` and `facadeInfo.version` unchanged.
- [ ] No new biome lint (importing a const adds no `useValidTypeof`-class issue here).
- [ ] No spread/field-set change: emitted `hello` object keys unchanged (broker-present vs absent branches).
