# P0 hash epoch — `asp-hash-epoch/2026-08-21-p0`

- Status: migration-contract input for the `raspc` byte-compatibility corpus
- Evidence date: 2026-08-21
- Task: T-07309 (folds T-07305, T-07306, T-07308)
- Epoch marker: **`asp-hash-epoch/2026-08-21-p0`**

## Decision

Every hash value and every emitted artifact byte produced by the TypeScript
compiler is re-based, once, at this epoch. Bytes and digests produced by any
commit **before** the landing commit of this task are *pre-epoch* and are not a
valid oracle for `raspc`. The Mode B corpus, the burn-in sample, and any
byte-compatibility comparison must be collected against post-epoch bytes only.

One epoch, one landing chain: the three P0 determinism scopes below all change
hash material, so they land together rather than as three separate bumps.

## What changed at this epoch

### Scope A — one canonical JSON, codepoint ordering

`packages/spaces-runtime-contracts/src/hash.ts` (`createCanonicalHasher`) is the
single canonical-JSON implementation. The six local serializers that previously
computed their own key ordering now delegate to it:

| Former local implementation | Now |
| --- | --- |
| [`packages/agent-spaces/src/agent-inspection.ts`](../packages/agent-spaces/src/agent-inspection.ts) `sortJson` | `createCanonicalHasher().hash` |
| [`packages/aspc/src/manifest.ts`](../packages/aspc/src/manifest.ts) `sortKeys` | `canonicalJson` delegates to `canonicalize` |
| [`packages/config/src/orchestration/install.ts`](../packages/config/src/orchestration/install.ts) `stableJson` | delegates to `canonicalize` |
| [`packages/execution/src/run-codex.ts`](../packages/execution/src/run-codex.ts) `stableJson` | delegates to `canonicalize` |
| [`packages/harness-codex/src/adapters/codex-hooks.ts`](../packages/harness-codex/src/adapters/codex-hooks.ts) `canonicalJson` | `createCanonicalHasher().hash` |

Two behaviours therefore change beyond ordering, by design: object fields whose
value is `undefined` are omitted from hash material rather than serialized, and
non-finite numbers are rejected instead of silently serialized.

ICU-dependent `localeCompare` is gone from every hash-material ordering; those
sites now compare by codepoint, matching the bare `.sort()` used elsewhere:
`install.ts` (`hashDirectory`), `resolver/integrity.ts` (both integrity
functions), `resolver/filesystem-registry.ts`, `store/snapshot.ts`, and
`agent-inspection.ts`. `store/snapshot.ts` and `resolver/integrity.ts` remain
byte-identical to each other.

### Scope B — injected compile clock

Compiler output timestamps derive from the caller's `CompileContext`, not the
ambient host clock. `packages/config/src/core/compile-clock.ts` is the single
blessed fallback point for the config plane: with no compile context it stamps
real time exactly as before, with one it stamps the pinned instant. The clock is
threaded through `ResolveOptions`/`InstallOptions`,
`MaterializeFromRefsOptions`, `LockGeneratorOptions`, `MaterializeOptions`,
`createEmptyLockFile`, `mergeLockFiles`, and the temp-lifecycle sweep and
runtime-prompt artifact writer.

`{{date}}` in [`packages/runtime/src/template-vars.ts`](../packages/runtime/src/template-vars.ts)
is derived in UTC from the injected instant. Previously the same instant
rendered as two different dates on two machines in different time zones, and
that date reached prompt bytes.

Mode B output exclusions remain lock artifacts only.

### Scope C — sorted TOML, trailing newlines

`config.toml` is emitted from canonically ordered objects, so two composes that
discovered the same MCP servers in a different order now produce identical
bytes. Every artifact write site ends in exactly one `\n`: `plugin.json`,
`settings.json`, `mcp.json`, and `hooks/hooks.json` previously ended without
one.

## Enforcement

`scripts/p0-hash-epoch.test.ts` runs inside `just verify` and holds the epoch
open-endedly: import/AST censuses over every non-test `.ts` under
`packages/*/src` force any new canonicalizer, any new `localeCompare`, and any
new artifact writer to be classified explicitly rather than slipping in.

## Consequences for `raspc`

- The Mode B corpus must be regenerated at or after the landing commit of this
  task. Any corpus entry captured earlier encodes pre-epoch bytes.
- Fingerprinted runtime homes (`codex-homes`) refork on the new hashes and stale
  caches are invalidated by the fingerprint change; this is expected, one-time,
  and self-healing.
- The canonical epoch publish, node resyncs, and per-node regeneration
  verification are supervisor/primary obligations that follow the landing; they
  are not part of this change.
