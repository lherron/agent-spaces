## Pi Harness

When running with `--harness pi`:

- Always set `PI_CODING_AGENT_DIR=<asp_modules target pi dir>` as an environment variable
- This env var must appear in `--print-command` output for copy-paste compatibility
- This env var must be set when spawning the Pi process directly
- Add `--no-extensions` when there are no extensions to load (prevents Pi from loading defaults)
- Always add `--no-skills` to disable default skill loading from `.claude`, `.codex`, `~/.pi/agent/skills/`
- Materialize hooks to `hooks-scripts/` (Pi has an incompatible `hooks/` directory format)
