# Closeout Evidence

Core rule: closeout evidence must match the strongest surface touched or claimed.
For any completion claim C, the cited evidence tier must be >= the strongest
changed-or-claimed surface in C. If the required evidence cannot be run, the
closeout must say BLOCKED / not fully validated instead of claiming done. A
real-behavior claim closed on weaker evidence is NOT done.

| Claim class | Minimum evidence |
| --- | --- |
| Docs / router / convention-only change | `bun scripts/check-doc-reachability.ts` plus prose review. No product-behavior claim may be closed from this alone. |
| Pure logic / refactor with no protocol or runtime surface | Relevant unit or contract tests green. Include typecheck when TS types or exported internals moved. |
| Protocol / DTO / public contract surface | A covering contract test or matrix row. The S7 public-surface sensor is necessary GUARD coverage: it proves presence, not semantic correctness. |
| Packaging / distribution / installability surface | Pack smoke evidence: root `bun scripts/smoke-pack-cross-repo.ts` for cross-repo package/export-boundary changes, and `cd packages/cli; bun scripts/smoke-test-pack.ts` for `@lherron/agent-spaces` package/CLI packaging changes. |
| Harness / broker behavior | The existing harness-broker matrix bar, `bun run smoke:matrix`; see [packages/harness-broker/AGENTS.md](../packages/harness-broker/AGENTS.md). If a row is unavailable, name the unavailable row/blocker. For harness-broker changes, the package guidance remains the stronger local rule. |
| Real integration / installed-runtime behavior: HRC, ACP, Discord, Ghostty, installed binaries, launchd, live services | Real e2e evidence against the installed/running system. Mock-only or unit-only evidence cannot close that claim. |
