# Refactor Analysis — spaces-harness-codex

**Package dir:** `packages/harness-codex`
**packageType:** `general` (a harness adapter + a long-lived JSON-RPC session driver; some
"concurrent" character in the RPC client, but the concurrency is already structured and tested).
**Analysis date:** 2026-06-08
**Source LOC (non-test):** ~2,400 across 13 files. Every production file was read in full.

## Summary

This package is **clean**. The two prior passes (T-02028, T-02030) already did the high-leverage
work that the 15 mechanisms target here:

- The shared codex app-server event protocol is extracted into a single source of truth
  (`event-mapping.ts`): the `CodexThreadItem` union, the notification-param interfaces, and the pure
  `mapItemStarted` / `mapItemCompleted` / `mapDeltaNotification` / `formatCodexErrorBody` mappers are
  consumed by BOTH the long-lived `CodexSession` and the headless `runCodexAppServerOneShot`. The
  duplicated *intent* (item→event mapping) is already collapsed.
- Magic numbers are named (`MAX_IMAGE_BYTES`, `MIN_MCP_CONFIG_BYTES`, `MIN_CODEX_VERSION`,
  `DEFAULT_HOOK_TIMEOUT_SECONDS`, `DEFAULT_CODEX_*`).
- Error normalization is centralized (`errors.ts` → `errorMessage` / `toError`).
- Discovery, config assembly, hooks, and AGENTS.md rendering are each in cohesive single-purpose
  files (`codex-discovery.ts`, `codex-config.ts`, `codex-hooks.ts`, `codex-agents.ts`).
- The `buildRunArgs` conditional is a small 3-way dispatch over launch mode, each arm a named
  builder — already in good shape; not a growing type-switch.

No Low/Med + internal-only auto-applicable findings were identified. `applicableCount = 0`. The
remaining candidates I pressure-tested are either (a) deliberate diverging copies whose shared core
is already extracted, (b) public-surface contract boundaries with real external consumers, or (c)
spread/projection hazards the brief explicitly warns against. They are documented below as
deliberately-left-alone with the mechanism reasoning, not manufactured as findings.

## Public boundary verdict

The public surface (`index.ts` re-exports + `codex-session/index.ts`) is **load-bearing and
correctly shaped**. Confirmed external consumers:

- `packages/agent-spaces` (`prepare-cli-runtime.ts`, `broker-invocation.ts`, `client.ts`) imports
  `buildCodexAppServerLaunchDescriptor` + `CodexAppServerLaunchDescriptor`.
- `packages/execution` (`run-codex.ts`) imports `CODEX_INTERACTIVE_HOOK_EVENTS`,
  `applyPraesidiumContextToCodexHome`, `buildHrcCodexHooksConfig`, `trustCodexHooksInConfigToml`;
  `harness/index.ts` imports `codexAdapter`.
- `runCodexAppServerOneShot` is referenced by the runtime-contract boundary-check allowlist
  (`spaces-runtime-contracts/src/boundary-checks.ts`).

Verdict: the boundary is **not fat and not leaky** for its consumers. Every public export has at
least one external caller. No [T07] narrowing or [T16] de-export is warranted — removing or
reshaping any of these is an [M02] expand/contract change across two packages, i.e. `public-surface`,
never auto-applicable. Leave the boundary intact.

## Findings by mechanism

**None applicable.** Each mechanism was walked outside-in; the candidates that survived a first look
did not survive the pressure-test (re-read + contraindication). They are recorded in
"Deliberately left alone" with the structural reason.

## Deliberately left alone (pressure-tested OUT)

1. **Twin `buildUserInputs` (`codex-session.ts:488` async vs `run-one-shot.ts:314` sync)** — [T15]
   extract-missing-abstraction candidate. **Left:** these are *diverging copies*, not accidental
   duplication. The session variant is `async`, accepts `AttachmentRef[]`, branches on
   url/file/image-vs-text, enforces `MAX_IMAGE_BYTES`, and emits `{type:'image'|'localImage'|'text'}`.
   The one-shot variant is sync, accepts a plain `string[]` of image paths, and only ever emits
   `localImage`/`text`. They consume different input contracts and have different async signatures;
   a shared helper would need to be the async superset and would force the one-shot caller to `await`
   and to wrap its paths into `AttachmentRef`s — added coupling, not removed duplication. Contra-
   indication (divergence is load-bearing) applies.

2. **`handleNotification` switch in `CodexSession` (codex-session.ts:296) vs `runCodexAppServerOneShot`
   (run-one-shot.ts:110)** — [T19] conditional→dispatch / [T15] candidate. **Left:** the *shared*
   per-item mapping is ALREADY extracted (`mapItemStarted`/`mapItemCompleted`/`mapDeltaNotification`).
   What remains is thin `case → emit(map(...))` glue whose emit mechanism genuinely differs: the
   session emits synchronously and accumulates turn artifacts (`turn/diff/updated`,
   `turn/plan/updated`) + drives a `pendingTurn` resolver; the one-shot serializes through an
   awaited `notificationQueue`, handles `thread/tokenUsage/updated`, and resolves `finalOutput`. A
   unified dispatcher parameterized over sync-vs-async emit + the divergent arms would be more complex
   than the glue it deletes. Deliberate; the right seam (pure mappers) is already cut.

3. **`thread/start` / `thread/resume` param objects (run-one-shot.ts:197-222; codex-session.ts:142-170)**
   — [T21] parameter-object / data-clump candidate (~9 shared fields). **Left:** this is a
   spread/projection hazard the brief calls out. These objects are the exact JSON-RPC wire params the
   codex app-server validates; resume adds `threadId/history/path` and drops `experimentalRawEvents`.
   Folding the shared fields via `{...common, ...}` risks forwarding an unexpected key (e.g.
   `experimentalRawEvents` onto a resume) into a strict-param server, changing observable wire
   behavior. The explicit literals are the safe encoding here.

4. **`buildExecArgs` (codex-adapter.ts:244) vs inline app-server arg assembly in `CodexSession.start()`
   (codex-session.ts:107-117)** — [T15] candidate (both build
   `[-c profile, --enable feat…, app-server, …extraArgs]`). **Left:** they read different config
   shapes (`HarnessRunOptions` vs `CodexSessionConfig`) AND diverge in a behaviorally-meaningful way:
   the adapter defaults features to `DEFAULT_CODEX_ENABLED_FEATURES`, the session uses
   `featureFlags ?? []` (no default). Unifying would couple two distinct launch contracts and risk
   silently changing the session's default feature set. Not the same intent.

5. **Nested ternary `run-one-shot.ts:280` (`status === 'failed' ? … : status === 'interrupted' ? …`)**
   — readability candidate. **Left:** passes biome `recommended` (the active ruleset), both prior
   passes left it, and it is a flat 3-way map from one variable — replacing it with a lookup or
   if-chain is churn with no behavioral or lint benefit.

6. **`getDefaultRunOptions` post-build mutation of `defaults.approvalPolicy/sandboxMode` on
   `target.yolo` (codex-adapter.ts:763-766)** — [T17]/clarity candidate. **Left:** the mutation is on
   a locally-constructed object literal (no aliasing escape), reads clearly as "yolo overrides", and
   matches the same yolo-override shape used in `buildCodexAppServerLaunchDescriptor` /
   `appendInteractiveCommonFlags`. Rewriting to a conditional spread changes nothing observable and
   adds no safety.

7. **Public exports / boundary** — see verdict. External consumers in two packages; any reshape is
   `public-surface` [M02], excluded from auto-apply by definition.

## Outside-in apply sequence

No edits are recommended. `applicableCount = 0`.

If a future change does touch this package, the make-safe gate [T40] is already satisfied: the public
surface and both RPC consumers carry characterization tests (`codex-adapter.test.ts`,
`codex-adapter.model-reasoning-effort.test.ts`, `codex-session.test.ts`,
`codex-session.getMetadata.test.ts`, `rpc-client.test.ts`, `run-one-shot.test.ts`). Any boundary
change should go through [M02] expand/contract across `agent-spaces` + `execution`, not an in-place
edit.
