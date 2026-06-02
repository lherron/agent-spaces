# 🧹 Refactor Backlog (non-bug second-pass findings)

**Generated:** 2026-06-01 · **Source:** the `🔁 Additional Findings (second pass)` section of each `*-report.md` · **Count:** 52 items.

## What this is

These are the second-pass findings that are **not behavioral bugs** — they describe code that works correctly today but is worth improving: naming, duplication (DRY), dead code, additive API/contract gaps, observability, and pure test-gap items. The 97 actual defects live in [BUGS.md](./BUGS.md); the full structural refactorings live in the body of each `*-report.md`.

None of these change behavior if left alone. `Type` classifies the kind of cleanup. Full write-ups are under the matching `### A#` heading in `<package>-report.md`.

---

| Package | ID | Type | Item | Location | Effort |
|---------|----|------|------|----------|--------|
| agent-scope | D | inconsistency | `parseSessionRef` trims some segments not others — pick one whitespace policy | `session-ref.ts:21-35` | 15m |
| agent-scope | F | DRY | `laneId` recomputed via magic `slice(5)` ×3; redundant laneId/laneRef pair | `input.ts:60,73,83` | 15m |
| agent-scope | G | test-gap | no `scope-ref.test.ts` — densest validator only tested indirectly | `src/__tests__/` | 40m |
| agent-spaces | A6 | error-quality | `collectTools` unguarded `JSON.parse` → opaque error (wrap w/ path) | `client-materialization.ts:281-287` | 30m |
| agent-spaces | A7 | observability | `deriveHandleParts` broad `catch{}` masks parse failures (add diagnostic) | `broker-invocation.ts:53-70` | 1h |
| agent-spaces | A8 | test-gap | no concurrency / multi-session coverage | `client.test.ts` | 1d |
| aspc-protocol | A1 | dead-code | dead `validateJsonRpcId` call (id already enforced by guard) | `schemas.ts:101,130-134` | 10m |
| aspc-protocol | A3 | cleanup | `protocolVersions` double-read; `.includes` runs on unvalidated items | `schemas.ts:144-156` | 10m |
| aspc-protocol | A4 | naming | `record`/`asRecord` names hide reports-vs-silent distinction | `schemas.ts:259-282` | 10m |
| aspc-protocol | A5 | diagnostic | array-item error message omits computed index path | `schemas.ts:309-315` | 5m |
| aspc-protocol | A6 | test-gap | `compileAndStart` validator never exercised by tests | `schemas.ts:90-92` | 15m |
| aspc-protocol | A7 | diagnostic | "Unsupported ASPC method" doesn't list valid methods | `schemas.ts:99` | trivial |
| aspc | A5 | dead-code | dead guard in `selectBrokerProfile` (length===1 branch) | `service.ts:192-211` | 5m |
| aspc | A6 | contract | `onRequest`/`onNotification` silent last-writer-wins | `client.ts:67-73` | 15m |
| aspc | A8 | test-gap | no failure-path / unit-level service tests | `test/facade.test.ts` | 45m |
| cli-kit | A3 | type-soundness | `repeatable<T>()` with no parser is type-unsound (`value as T`) | `index.ts:31` | 15m |
| cli-kit | A6 | consistency | `consumeBody` raw `readFileSync` → exit code 1 not 2 (wrap as `CliUsageError`) | `index.ts:108,112` | 10m |
| cli-kit | A7 | test-gap | `consumeBody` stdin (`-`) branch untested | `index.test.ts:137` | 15m |
| cli-kit | A8 | type-precision | `parseJsonObject` `as` cast vs runtime guard drift | `index.ts:67,79` | 10m |
| cli-kit | A9 | test-hygiene | tests monkey-patch global `process.exit`/stderr | `index.test.ts:36-58` | — |
| cli | A5 | DRY | duplicated `readOptionalFile` ×2 byte-identical | `self/prompt.ts:275`, `explain.ts:402` | 15m |
| cli | A6 | consistency | hand-rolled `process.exit(2)` vs central `CliUsageError` | `self/{prompt,explain,paths}.ts` | 2-3h |
| cli | A7 | micro | `formatWhenPredicate` evaluated twice in one expression | `self/lib.ts:445` | 5m |
| cli | A8 | cleanup | mid-function `require('node:fs')` on a real launch path | `run.ts:165` | 5m |
| config | A6 | OCP | `DEFAULT_HARNESSES = ['claude']` hardcodes harness enumeration | `lock-generator.ts:26` | 1h |
| config | A7 | error-quality | `computeClosure` rewraps deep failures, loses cause | `closure.ts:259-270` | 1h |
| config | A8 | fragility | `acquireLock` string-matches `proper-lockfile` messages | `core/locks.ts:96-117` | 1h |
| execution | A8 | ISP | `RunOptions` vs `GlobalRunOptions` diverge (no shared base) | `run/types.ts:34-65,134-161` | 2-3h |
| execution | A9 | dead-code | `resolveInteractive` no-op imported in 4 places as a fake seam | `run/util.ts:43-48` | 30m |
| harness-broker-client | A4 | additive-API | `onClose`/`onPermissionRequest` no unsubscribe; handlers only grow | `client.ts:239-245` | 1h |
| harness-broker-client | A5 | export-gap | `InvocationStartDispatchOptions` used in public sig but not exported | `client.ts:57-61` | 5m |
| harness-broker-client | A7 | perf | `structuredClone(dispatch)` per `invocation.start` — dead copy + throw surface | `client.ts:166` | 15m |
| harness-broker-client | A9 | observability | unmatched response id silently dropped (add debug counter) | `*-transport.ts:181-183` | 30m |
| harness-broker-protocol | A5 | test-gap | `flush()`, streaming-UTF-8, `canonicalizeJson` edges untested | `test/*` | 2h |
| harness-broker-protocol | A6 | naming | `path`/`issue` exported as dangerously generic names | `validation-primitives.ts:135-141` | 1h |
| harness-broker-protocol | A7 | DRY | error-class boilerplate duplicated across modules | multiple | 1-2h |
| harness-broker | A4 | hidden-state | module-global `permissionRequestCounter` shared across invocations | `permissions.ts:95-100` | <0.5d |
| harness-broker | A9 | robustness | parse-error frame written per malformed line — amplification surface | `protocol-server.ts:115-125` | <0.5d |
| harness-claude | A2 | dead-wiring | `register.ts` hardcodes hook bus to `undefined`; `onSdkSessionId` never wired | `register.ts:11-29` | 0.25-0.5d |
| harness-claude | A6 | test-gap | `PromptQueue` + invoke-timeout untested | `prompt-queue.ts`, `invoke.ts` | 0.5d |
| harness-claude | A7 | API-surface | likely-dead public `invoke*`/`spawnClaude` exports widen surface | `claude/index.ts:26-32` | 0.25d |
| harness-codex | A10 | test-gap | no rpc-client / cleanup / flush tests | `codex-session/*.test.ts` | 0.5d |
| harness-pi | A8 | test-gap | no test for hook-script injection, cleanup-on-failure, several methods | `pi-adapter.test.ts` | 0.5d |
| harness-pi-sdk | A2 | dead-code | `createPermissionHook` exported, never wired (pairs with BUGS A3) | `permission-hook.ts:13-69` | 1-3h |
| harness-pi-sdk | A7 | perf | `resolveSdkEntry` reads whole bundle to test existence (`byteLength>=0`) | `runner.ts:142-156` | 15m |
| runtime | A5 | additive-API | `UnifiedSession.onEvent` no unsubscribe/replace semantics | `session/types.ts:178-179` | 2h |
| runtime | A7 | observability | `detectAvailable` flattens error to message — drops cause/stack | `harness/registry.ts:94-100` | 30m |
| runtime-contracts | A2 | test-gap | no test for array-index `omitPaths` / round-trip (shields BUGS A1) | `test/hash.test.ts:82-96` | 20m |
| runtime-contracts | A5 | OCP | three per-kind profile validators, no kind-dispatching entry point | `validate-execution-profile.ts:24,108,300` | 30m |
| runtime-contracts | A6 | additive-API | controller/mapper contracts carry no `AbortSignal` cancellation seam | `controller.ts:12-24`, `event-mapper.ts:13-18` | 1-2h |
| runtime-contracts | A7 | fragility | `boundary-checks.ts` ships `rg` commands split mid-token | `boundary-checks.ts:13-32` | 1h |
| runtime-contracts | A8 | DRY | `legacyTransportAlias()` can't apply to persisted producers (extract shared) | `public-api.ts:80-92` | 30m |

---

## By type

| Type | ~Count |
|------|--------|
| test-gap | 11 |
| DRY / duplication | 6 |
| dead-code | 5 |
| naming / diagnostic | 6 |
| additive-API / export-gap | 6 |
| consistency / inconsistency | 5 |
| observability | 4 |
| perf (non-hot-path) | 3 |
| type-soundness/precision | 3 |
| OCP / fragility / misc | 3 |

A few are linked to bugs in [BUGS.md](./BUGS.md) — e.g. `runtime-contracts A2` (test gap) shields `A1`, and `harness-pi-sdk A2` (dead `createPermissionHook`) is the missing wiring for `A3`. Fix those pairs together.
