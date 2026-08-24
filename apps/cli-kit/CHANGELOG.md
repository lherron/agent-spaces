# cli-kit — Changelog

## 0.1.0 — 2026-04-27

Initial release. Shared CLI helpers for the agent-spaces monorepo, extracted
during the Commander CLI Upgrade project.

### Added

- `CliUsageError` — typed error class for usage mistakes (exit code 2).
- `exitWithError()` — unified error envelope that writes to stderr and exits
  with the correct code (2 for usage, 1 for everything else).
- `attachJsonOption()`, `attachServerOption()`, `attachActorOption()` —
  reusable Commander option helpers.
- `repeatable()` — Commander argument parser for accumulating repeated flags.
- `withDeps()` — thin wrapper that extracts Commander opts/positionals and
  injects a dependency bag into action handlers.
- `parseDuration()`, `parseIntegerValue()`, `parseJsonObject()`,
  `parseCommaList()` — value-validation helpers (lifted from the former
  hand-rolled parsers in acp-cli and hrcchat-cli).
- `consumeBody()` — stdin / `--file` / positional body reader.

### Notes

- **User-visible change:** none — cli-kit is a library consumed by the four
  CLI packages; end-users interact only with `acp`, `hrc`, `hrcchat`, `asp`.
