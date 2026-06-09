# Refactor analysis — `spaces-aspc` (packages/aspc)

packageType: **general** (a thin JSON-RPC facade + service over the ASP compiler and harness broker; no concurrency/perf/data-heavy characteristics)

## Summary

This package is a small (647 LOC across 7 files), already-polished facade. It exposes
an `AspcService` (compile / compile-harness-invocation / compile-and-start), a stdio
JSON-RPC `ProtocolServer` that fronts both the ASPC methods and a co-hosted broker, and
an `AspcClient` transport wrapper. The two prior refactor passes (T-02028, T-02030)
clearly already landed here: table-driven dispatch is in place in both
`selectBrokerProfile` and `brokerMethodTable`, diagnostic codes/schema strings are
centralized, `startFromDispatch` is a single source for the broker-start arg order
(documented as anti-drift), error handling is structured through
`compileRuntimePlanSafe`, and the residual structural casts / version-duplication carry
explicit comments naming why they exist. Characterization coverage is strong (586 test
LOC vs 647 source LOC across `service.test.ts`, `facade.test.ts`, and a red-guard test).

**Verdict: 0 applicable findings.** No Low/Med internal-only refactor is warranted. The
remaining "smells" are all either documented load-bearing constraints (version
duplication, structural placement cast) or would be behavior-neutral churn with no
clarity gain. I am not manufacturing findings to look productive.

## Public boundary verdict (outside-in, assessed first)

`src/index.ts` re-exports exactly: `AspcClient` + `AspcRequestHandler`;
`createAspcService` + `AspcCompiler`/`AspcService`/`AspcServiceOptions`;
`createAspcFacadeServer` + `runAspcFacadeStdio` + `AspcFacadeOptions`.

- The surface is **narrow and matches actual usage** — each export is a real entry point
  (service factory, facade-server factory, stdio runner, client). No fat/leaky interface.
- `startFromDispatch` is correctly **not** re-exported (internal-only, used by both
  `service.ts` and `facade.ts`) — comment says so explicitly. No T07 widen/narrow needed.
- `AspcClient` deliberately uses single-shot `onRequest`/`onNotification` with throw-on-
  re-register (documented foot-gun avoidance). This is an encoded invariant (T12-adjacent),
  not a smell.
- No M02 expand/contract is needed: the wire protocol versions (`ASPC_PROTOCOL_VERSION`,
  schema-version literals) are owned by `spaces-aspc-protocol`; this package only forwards
  them.

The boundary is pinned and healthy. No public-surface change recommended.

## Findings by mechanism

**None applicable.** Every mechanism in the lens was walked outside-in; each candidate was
pressure-tested by re-reading and found either already-resolved or contraindicated. The
notable checks:

- **[T40] Make-safe / characterization tests** — already present and substantial
  (`service.test.ts`, `facade.test.ts`, `v01-removal.red.test.ts`). The public surface is
  gated. No new tests required to enable a refactor because no refactor is recommended.
- **[T19] conditional ↔ dispatch** — `selectBrokerProfile` (profileSelector.ts) already
  uses a `SELECTOR_CRITERIA` table + `reduce`; `brokerMethodTable` (facade.ts) already uses
  a route table. Both are at the correct altitude — *not* over-abstracted (each table has
  3 and 8 real, materialized entries respectively). No T16 de-abstraction warranted: the
  variation is real, not speculative.
- **[T15] extract missing abstraction** — diagnostic codes (`DIAGNOSTIC_CODES`), schema
  strings (`ASPC_*_SCHEMA`, `RUNTIME_COMPILE_RESPONSE_SCHEMA`), method-name maps
  (`ASPC_METHODS`, `BROKER_METHODS`), and the `JSONRPC_VERSION` literal are all already
  hoisted to named single-source constants. No remaining magic strings/numbers or
  primitive obsession.
- **[T18] error handling** — the one try/catch (`compileRuntimePlanSafe`) converts a thrown
  compiler exception into a typed `ok:false` diagnostic envelope — the correct pattern
  (expected failure modeled as data, not exception). No swallowed `catch {}`.
- **[T17] partial→total** — the `compileAndStart` broker-undefined branch throws an explicit,
  reachable guard ("requires a co-hosted broker"); the `hello` capability flags reflect the
  same condition. This is a real reachable guard, correctly kept explicit, not a "can't
  happen" arm to narrow.
- **[T23] middle man** — `AspcClient` methods are thin `this.#transport.request(...)`
  forwarders, but they provide a typed, named, defaulted (`hello`) public API over an
  untyped transport — that is the value the class adds, not pass-through to collapse.
- **[T07] boundary** — no fat or leaky interfaces; see boundary verdict above.

## Deliberately left alone (contraindications honored)

1. **`ASPC_FACADE_VERSION = '0.1.1'` duplicates `package.json` `version`** (service.ts:26).
   Confirmed in sync (both 0.1.1). The adjacent comment documents *why*: build `rootDir` is
   `./src`, so importing the manifest breaks emit. This is a documented, load-bearing
   constraint — "deduping" it would break the build. Leave it. (If anything, this is a
   build-config concern, not a source refactor.)

2. **`PlacementWithDispatchEnv` structural cast** (service.ts:178–184). The comment states
   the typed `placement` contract in `spaces-runtime-contracts` doesn't expose
   `dispatchEnv`, so it's reached via a named structural view rather than `any`. This is the
   *correct* mitigation for an upstream contract gap (named type + isolated accessor). The
   real fix lives in `spaces-runtime-contracts`, not here. Leave it.

3. **`brokerMethodTable` per-row `params as Parameters<typeof broker.x>[0]` casts**
   (facade.ts:137–170). These casts sit *after* `validateCommand(...)` runs at the call
   site in `registerBrokerMethods`, so the runtime narrowing is real; the cast only bridges
   the validator's `unknown` output to each broker method's input type. Folding the cast
   into the table would lose the per-method type binding. Leave it.

4. **Double validation in `registerAspcMethod`** (`validateAspcCommand` envelope check +
   `validateRequest(params)` payload check, facade.ts:84–87). This is defense-in-depth
   across two distinct concerns (JSON-RPC envelope shape vs typed params), both owned by the
   protocol package. Not redundant — load-bearing. Leave it.

5. **`profiles[0] as BrokerExecutionProfile` with a `length === 1` guard**
   (profileSelector.ts:45–46). The comment explains the deliberate choice of a length check
   over a `!== undefined` guard (which would let the single-match case fall through to the
   missing-profile diagnostic). Correct and documented. Leave it.

6. **Tables not de-abstracted (T16 direction checked, not applicable).** Both dispatch
   tables encode variation that has actually materialized (3 selector dimensions, 8 broker
   routes). Inlining them back would re-introduce the copy-paste the prior passes removed.
   Going "deep" here surfaces no real premature abstraction to collapse.

## Outside-in apply sequence

None — there are no findings to apply. The package is in a finished state after the two
prior passes. Recommend: take no action; spend the apply-phase budget on packages with
real residual findings.
