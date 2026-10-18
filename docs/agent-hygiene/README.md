# Agent Hygiene

`asp token-rent` is the prioritization input for prompt remediation passes. It prices the resident context stack that an agent pays on every turn, then multiplies each section by real HRC run frequency.

Usage:

```bash
asp token-rent --fleet
asp token-rent --agent clod --json
asp token-rent --since HEAD~1
```

The report reads live HRC data from `~/praesidium/var/state/hrc/state.sqlite`.
Resident bytes come from `broker_invocations.spec_projection_json`: the newest
invocation per scope is considered, then the newest usable prompt per agent is
priced. It reads `launch.systemPromptFile` when present, or, for Codex, only the
trimmed `praesidium-context` block in `$CODEX_HOME/AGENTS.md` using the spec's
locked environment. It does not read pre-v2 compiled-plan prompt artifacts.
Agents without a usable on-disk prompt report zero and `missingPromptArtifact`;
zero alone does not prove a layer is unused. Sections split on the composed
prompt join marker: blank line, `---`, blank line.

Regime split:

- Resident rent: `AGENT_MOTD.md`, `conventions.md`, `SOUL.md`, runtime scope/date/services, and any other section present in the composed `system-prompt.md` artifact.
- Session-start reminders: `USER.md`, `MEMORY.md`, wrkq/just info, and similar boot context. These are not counted as per-turn resident rent.
- Dead-layer candidates: instruction-looking markdown with resident rent `0` because it is not present in any priced system-prompt artifact.

Token counting uses the current heuristic `ceil(chars / 4)`. The output includes Markdown by default and JSON with `--json`; use `--usage-since` when a report needs a specific frequency window.
