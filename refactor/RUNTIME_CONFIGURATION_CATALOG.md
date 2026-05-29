# Runtime Configuration Catalog

Last updated: 2026-05-28

This is the human planning catalog for ASP/HRC runtime configurations. The code
validation catalog is `packages/spaces-runtime-contracts/src/route-catalog.ts`.
Keep this file broader than the code catalog: it should include current compiler
routes, legacy ASP compatibility routes, pre-HRC matrix coverage, and target
future routes.

## Terms

- **Current**: implemented as a compiler route or public ASP execution path.
- **Legacy**: supported by existing ASP APIs or `asp run`, but not the desired
  HRC controller shape.
- **Future**: target HRC route/configuration that is not fully implemented yet.
- **Matrix**: covered by `scripts/pre-hrc-broker-matrix-e2e.ts`.

## Current Code Catalog

The current typed route catalog contains these route families:

| ID | Status | Provider | Frontend / harness | Runtime | Interaction | Controller | Host / driver | Turn delivery | Matrix row |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `claude-code-broker-tmux-interactive` | Current default | `anthropic` | `claude-code` / `claude` | `claude-code-cli` | `interactive` | `harness-broker` | `claude-code-tmux`, pty, tmux surface | `broker-input`, `terminal-literal-input` | `real-claude-tmux`, `claude-tmux-ghostmux` |
| `claude-code-terminal-interactive` | Current explicit / legacy-compatible | `anthropic` | `claude-code` / `claude` | `claude-code-cli` | `interactive` | `terminal` | foreground/tmux/ghostty family | `terminal-launch-input`, `terminal-literal-input` | Missing |
| `codex-cli-broker-tmux-interactive` | Current default | `openai` | `codex-cli` / `codex` | `codex-cli` | `interactive` | `harness-broker` | `codex-cli-tmux`, pty, tmux surface | `broker-input`, `terminal-literal-input` | `real-codex-tmux`, `codex-tmux-ghostmux` |
| `codex-cli-terminal-interactive` | Current explicit / legacy-compatible | `openai` | `codex-cli` / `codex` | `codex-cli` | `interactive` | `terminal` | foreground/tmux/ghostty family | `terminal-launch-input`, `terminal-literal-input` | Missing |
| `agent-sdk-embedded-noninteractive` | Future in compiler, current public API | `anthropic` | `agent-sdk` / `claude-agent-sdk` | `claude-agent-sdk` | `nonInteractive` | `embedded-sdk` | in-process SDK | `sdk-turn`, `sdk-inflight-input` | Missing |
| `pi-sdk-embedded-noninteractive` | Current | `openai` | `pi-sdk` / `pi-sdk` | `pi-sdk` | `nonInteractive` | `embedded-sdk` | in-process SDK | `sdk-turn`, `sdk-inflight-input` | `real-pi-sdk-embedded` |
| `codex-app-server-headless` | Current default | `openai` | `codex-cli` / `codex` | `codex-cli` | `headless` | `harness-broker` | `codex-app-server`, jsonrpc-stdio | `broker-input` | `fake-codex`, `real-codex` |
| `codex-legacy-exec-headless` | Legacy / migration-only | `openai` | `codex-cli` / `codex` | `codex-cli` | `headless` | `legacy-exec` | legacy launch artifact | `legacy-launch-input` | Missing |

## Public ASP Compatibility Surface

These are user-visible ASP combinations that need either matrix rows or an
explicit decision to retire.

| ID | Status | Public entrypoint | Runtime shape | Needed coverage |
| --- | --- | --- | --- | --- |
| `asp-claude-interactive` | Legacy-compatible | `asp run --harness claude` | direct Claude CLI, inherited terminal | Add foreground terminal smoke or prove broker-tmux fully replaces it. |
| `asp-claude-headless` | Legacy-compatible | `asp run --harness claude --no-interactive` | direct Claude CLI `-p`, captured process output | Add headless process smoke if retained. |
| `asp-codex-interactive` | Legacy-compatible | `asp run --harness codex` | direct Codex CLI, inherited terminal | Add foreground terminal smoke or prove broker-tmux fully replaces it. |
| `asp-codex-headless-legacy` | Legacy / migration-only | `asp run --harness codex --no-interactive` before broker cutover | legacy launch artifact / app-server adapter path | Add migration smoke until deleted. |
| `asp-pi-cli-interactive` | Legacy-compatible | `asp run --harness pi` | Pi CLI interactive process | Add process-invocation smoke. |
| `asp-pi-cli-headless` | Legacy-compatible | `asp run --harness pi --no-interactive` | Pi CLI `--print`, captured output | Add process-invocation smoke. |
| `asp-pi-sdk-interactive-runner` | Legacy-compatible | `asp run --harness pi-sdk` | Pi SDK runner process with `--mode interactive` | Decide whether to keep after embedded SDK route lands everywhere. |
| `asp-pi-sdk-print-runner` | Legacy-compatible | `asp run --harness pi-sdk --no-interactive` | Pi SDK runner process with `--mode print` | Covered indirectly by `real-pi-sdk-embedded` only if runner path is retired. |
| `agent-sdk-turn` | Current public API / future compiler | `runTurnNonInteractive({ frontend: "agent-sdk" })` | in-process Claude Agent SDK turn | Add matrix row. |
| `agent-sdk-inflight` | Current public API / future compiler | `runTurnInFlight({ frontend: "agent-sdk" })` | in-process Claude Agent SDK with queued input | Add matrix row. |
| `pi-sdk-turn` | Current public API and compiler | `runTurnNonInteractive({ frontend: "pi-sdk" })` | in-process Pi SDK turn | Covered by `real-pi-sdk-embedded`; add resume/inflight decisions separately. |

## Target Future Catalog

These rows should exist in the HRC-era catalog once the corresponding controller
or driver behavior is implemented and tested.

| ID | Provider | Frontend | Runtime | Interaction | Controller | Host / driver | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `claude-code-broker-ghostty-interactive` | `anthropic` | `claude-code` | `claude-code-cli` | `interactive` | `harness-broker` or terminal controller | Ghostty attach surface | Future alternative to tmux attach, if retained. |
| `codex-cli-broker-ghostty-interactive` | `openai` | `codex-cli` | `codex-cli` | `interactive` | `harness-broker` or terminal controller | Ghostty attach surface | Future alternative to tmux attach, if retained. |
| `agent-sdk-embedded-noninteractive` | `anthropic` | `agent-sdk` | `claude-agent-sdk` | `nonInteractive` | `embedded-sdk` | in-process SDK | Listed in the code route catalog, but compiler emission is intentionally deferred. |
| `agent-sdk-embedded-inflight` | `anthropic` | `agent-sdk` | `claude-agent-sdk` | `nonInteractive` | `embedded-sdk` | in-process SDK | Needs HRC in-flight delivery semantics and matrix coverage. |
| `pi-sdk-embedded-inflight` | `openai` | `pi-sdk` | `pi-sdk` | `nonInteractive` | `embedded-sdk` | in-process SDK | Public nonInteractive exists; decide whether true in-flight input is supported. |
| `pi-cli-broker-or-terminal-interactive` | `openai` | `pi-cli` | `pi-cli` | `interactive` | TBD | TBD | Legacy CLI exists; no HRC route family is defined yet. |
| `pi-cli-broker-or-command-headless` | `openai` | `pi-cli` | `pi-cli` | `headless` | TBD | TBD | Legacy CLI `--print` exists; no HRC route family is defined yet. |

## Pre-HRC Matrix Rows

Current matrix rows:

| Row | Covers |
| --- | --- |
| `fake-codex` | deterministic `codex-app-server` headless broker fixture |
| `real-codex` | real `codex-app-server` headless broker |
| `real-codex-tmux` | real Codex CLI interactive tmux broker |
| `codex-tmux-ghostmux` | real Codex CLI interactive tmux broker with Ghostmux operator attach |
| `real-claude-tmux` | real Claude Code interactive tmux broker |
| `claude-tmux-ghostmux` | real Claude Code interactive tmux broker with Ghostmux operator attach |
| `real-pi-sdk-embedded` | real Pi SDK embedded nonInteractive executor |

## Coverage Gaps

Minimum missing rows for full legacy ASP coverage:

1. `claude-code` foreground terminal interactive.
2. `codex-cli` foreground terminal interactive.
3. `codex-cli` legacy-exec headless.
4. `claude-code` headless process invocation.
5. `pi-cli` interactive process invocation.
6. `pi-cli` headless process invocation.
7. `agent-sdk` nonInteractive SDK turn.
8. `agent-sdk` in-flight SDK turn.
9. `pi-sdk` runner interactive/print, unless explicitly retired in favor of
   embedded SDK only.

## Maintenance Rule

When adding or removing a runtime route, update all three places in the same
change:

1. `packages/spaces-runtime-contracts/src/route-catalog.ts` for enforceable route
   validation.
2. `scripts/pre-hrc-broker-matrix-e2e.ts` for driver certification rows.
3. This file for current, legacy, and future planning visibility.
