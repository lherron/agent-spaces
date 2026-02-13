# CLI Notes (Context7)

## Codex CLI
- Non-interactive execution: `codex exec` (or `codex e`).
- JSON streaming: `codex exec --json "..."` outputs JSON Lines events to stdout.
- Structured output: `codex exec --output-schema ./schema.json -o ./output.json "..."`.
- Final message is written to stdout; streaming activity goes to stderr.
- Model override: `codex exec -m gpt-5.3-codex -c model_reasoning_effort=xhigh "..."`.
- Resume session: `codex resume` (picker) or `codex resume --last` (most recent).

## Claude Code
- Launch interactive agent: `claude` in the repo directory.
- Non-interactive print mode: `claude -p "query"` (prints response and exits).
- JSON output: `claude -p "query" --output-format json`.
- Schema-validated JSON: `claude -p --json-schema '<schema>' "query"` (print mode only).
- Model selection: `claude -p --model opus "query"` (alias for latest Opus).
- Claude CLI accepts a full model name via `--model` (example in docs uses `claude-sonnet-4-5-20250929`).
- Debug mode: `claude --debug`.
- Resume session: `claude -r` (picker) or `claude -r <session-id>` (specific session).
- Continue most recent: `claude -c` (continues most recent conversation in current directory).

## Gemini CLI
- Non-interactive prompt: `gemini -p "..."`.
- Structured JSON output: `gemini -p "..." --output-format json`.
- Streaming JSON events: `gemini -p "..." --output-format stream-json`.
- Model selection: `gemini -p "..." --model gemini-3-pro-preview` (requires preview features enabled).
- Resume session: Not supported (no session persistence).

## OpenCode CLI
- Non-interactive prompt: `opencode run "..."`.
- Run flags include `--model` (provider/model), `--agent`, `--format` (default or json), and `--attach` to a running server.
- `--format json` returns raw JSON events; default format prints text.
- List available models with `opencode models` (optionally `--refresh`).
- Resume session: `opencode -c` (continue last) or `opencode -s <session-id>` (specific session).
