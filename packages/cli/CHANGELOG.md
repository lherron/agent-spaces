# cli (asp) — Changelog

## 0.5.0 — 2026-04-27

Bumped Commander from **v12** to **v14** and adopted shared `cli-kit` helpers
as part of the Commander CLI Upgrade project.

### Changed

- **Commander version:** `^12.1.0` → `^14.0.0`. Minor help-output formatting
  changes from the upstream version bump.
- **Error handling:** adopted `exitWithError` from `cli-kit` for consistent
  exit-code behaviour (usage errors exit **2**, runtime errors exit **1**).
- **Dependencies:** added workspace `cli-kit`.

### Notes

- **No verb or flag changes.** The `asp` CLI surface is identical.
- **No JSON output shape changes.** All structured output is bit-identical.
- **Help format:** auto-generated help text may differ slightly in whitespace
  and alignment due to Commander v14's formatting engine.
