# Unified Context Template v2

**Status:** Proposal
**Date:** 2026-04-07
**Author:** Claude Opus (agent-spaces session)

## Problem

The current system has two separate mechanisms for injecting context into agent sessions:

1. **System prompt** — built by `system-prompt-template.toml`, passed via `--system-prompt` flag, persists through context compression
2. **Session reminder** — hardcoded in a bash hook (`agent_motd.sh`), injected as `<system-reminder>` on SessionStart, can compress away

The system prompt template is well-structured (typed sections, composable, testable). The session reminder is a shell script with hardcoded logic. There's no way to compose, configure, or test session reminders the way you can system prompts.

Additionally, the current implementation has no size awareness — templates can grow unboundedly, and the slot mechanism requires code changes to add new slot names.

## Proposal

Merge both into a single `context-template.toml` with `[[prompt]]` and `[[reminder]]` TOML headers that visually and structurally separate the two placement zones.

## Current Implementation Reference

### Files involved (agent-spaces repo)

```
packages/runtime/src/system-prompt-template.ts   — TOML parser, type definitions
packages/runtime/src/system-prompt-resolver.ts    — Section resolver (file, inline, exec, slot)
packages/runtime/src/system-prompt.ts             — Materialization entry point, template discovery
packages/runtime/src/system-prompt-template.test.ts
packages/runtime/src/system-prompt-resolver.test.ts
```

### Files involved (other repos)

```
~/praesidium/var/agents/system-prompt-template.toml  — Production template
~/praesidium/var/agents/AGENT_MOTD.md                — Platform preamble (read by template)
~/praesidium/var/agents/conventions.md               — Coding conventions (read by template)

~/praesidium/spaces-repo/spaces/praesidium-defaults/hooks/scripts/agent_motd.sh  — SessionStart hook
~/praesidium/spaces-repo/spaces/praesidium-defaults/hooks/hooks.json             — Hook registration
```

### Current section types

- **file** — reads a file path, supports `required` flag and `agent-root:///` / `project-root:///` refs
- **inline** — literal string content
- **exec** — runs a bash command, captures stdout, optional `timeout`
- **slot** — filled from agent-profile.toml or scaffold packets; currently hardcoded to only allow `additional-base` and `scaffold` names

### Current slot name allowlist (parser enforced)

```typescript
const SYSTEM_PROMPT_SLOT_NAMES = ['additional-base', 'scaffold'] as const
```

This requires code changes to parser, resolver, and types to add any new slot.

### Current `when` predicate

Only supports `runMode` matching:

```toml
when = { runMode = "heartbeat" }
```

### Current template resolution chain

1. `agent-profile.toml` → `instructions.template` (agent-specific override)
2. `~/praesidium/var/agents/system-prompt-template.toml`
3. `$ASP_HOME/system-prompt-template.toml`
4. Built-in default (generated TOML from code)

### Current SessionStart hook behavior

The hook at `agent_motd.sh`:
1. Logs the hook payload to `~/praesidium/var/logs/motd-calls.log`
2. Detects justfile in cwd and runs `just info`
3. Output goes to stdout → Claude Code injects as `<system-reminder>`

Registered only for `startup` matcher (not `compact`).

### Claude Code hook behavior (from docs)

- `SessionStart` hooks can use `startup` and `compact` matchers
- `startup` fires once at session start
- `compact` fires when Claude Code compresses context (context window pressure)
- Hook stdout is injected as `<system-reminder>`, capped at 10,000 chars
- `PreCompact` / `PostCompact` exist but cannot inject context (observability only)

---

## v2 Template Format

### Example `context-template.toml`

```toml
schema_version = 2
mode = "replace"
max_chars = 10000           # hard budget — error if resolved content exceeds this

# ===========================================================================
#  SYSTEM PROMPT — persists through context compression
# ===========================================================================

[[prompt]]
name = "platform"
type = "file"
path = "AGENT_MOTD.md"

[[prompt]]
name = "soul"
type = "file"
path = "agent-root:///SOUL.md"
required = true

[[prompt]]
name = "additional-base"
type = "slot"
source = "instructions.additionalBase"

[[prompt]]
name = "date"
type = "exec"
command = "date '+Today is %Y-%m-%d (%A).'"

[[prompt]]
name = "services"
type = "exec"
command = "stackctl status dev --brief 2>/dev/null"
timeout = 3000
max_chars = 600

[[prompt]]
name = "heartbeat"
type = "file"
path = "agent-root:///HEARTBEAT.md"
when = { runMode = "heartbeat" }

[[prompt]]
name = "scaffold"
type = "slot"
source = "scaffold"

[[prompt]]
name = "conventions"
type = "file"
path = "conventions.md"

# ===========================================================================
#  SESSION REMINDER — injected at SessionStart + compact, may compress away
# ===========================================================================

[[reminder]]
name = "project-tooling"
type = "exec"
command = "just info 2>/dev/null"
when = { exists = "justfile" }
timeout = 3000

[[reminder]]
name = "wrkq-context"
type = "exec"
command = "wrkq agent-info 2>/dev/null"
timeout = 3000

[[reminder]]
name = "additional-session"
type = "slot"
source = "session.additionalContext"

[[reminder]]
name = "additional-session-exec"
type = "slot"
source = "session.additionalExec"
```

### Design decisions

**1. `[[prompt]]` vs `[[reminder]]` headers**

TOML array-of-tables makes the two zones visually distinct and structurally enforced. A `[[prompt]]` section always routes to `--system-prompt`. A `[[reminder]]` section always routes to hook stdout. The parser produces two separate arrays. You cannot accidentally intermingle them — the TOML header is the placement.

**2. `max_chars` — hard fail, no silent shedding**

Global `max_chars` is a hard ceiling. If the resolved total exceeds it, the resolver throws an error. The user must fix their template. No priorities, no silent dropping. This keeps the system honest and predictable.

Per-section `max_chars` truncates that section's output with a `[truncated]` marker. This is useful for exec sections that might produce variable-length output (like `stackctl status`).

**3. Open-ended slots via `source` path**

Instead of an allowlist of slot names, slots declare a `source` — a dot-path into agent-profile.toml:

```toml
[[prompt]]
name = "additional-base"
type = "slot"
source = "instructions.additionalBase"

[[reminder]]
name = "additional-session"
type = "slot"
source = "session.additionalContext"
```

The resolver walks the dot-path into the parsed profile TOML. File refs are resolved the same way as today. Adding new slots requires only a template entry and a config path — no code changes.

For exec arrays in agent-profile.toml (like `session.additionalExec`), the resolver detects string arrays where entries look like commands and executes them:

```toml
# agent-profile.toml
[session]
additionalContext = ["rex-session-banner.md"]
additionalExec = [
  "wrkq cat $(wrkq current 2>/dev/null) 2>/dev/null || echo 'No current task'",
  "agentchat pending --count 2>/dev/null",
]
```

**4. `when` predicates: `runMode` + `exists`**

```toml
when = { runMode = "heartbeat" }      # existing — matches run mode
when = { exists = "justfile" }        # new — checks file existence in cwd
```

`exists` checks cwd for the named file. Keeps exec sections focused on producing content, not gating on preconditions.

**5. Variable interpolation in inline sections**

```toml
[[prompt]]
name = "identity"
type = "inline"
content = "You are {{agent_name}} in project {{project_id}}."
```

Available variables from resolver context: `agent_name`, `agent_root`, `agents_root`, `project_root`, `project_id`, `run_mode`. Simple `{{var}}` replacement, no expressions or logic.

---

## Implementation Plan

### 1. Parser changes (`context-template.ts`)

- Support `schema_version = 2`
- Parse `[[prompt]]` and `[[reminder]]` as two separate section arrays
- `[[section]]` remains valid for v1 templates (treated as prompt-only, backwards compat)
- New optional fields on all section types:
  - `max_chars` (positive integer) — truncate section output
- Slot sections: replace `name` allowlist with `source` (string, required for v2 slots)
- `WhenPredicate`: add optional `exists` (string) field
- Return type becomes `ContextTemplate` with `promptSections` and `reminderSections`

**v1 backwards compatibility:** When `schema_version = 1`, parser reads `[[section]]` arrays and places them all in `promptSections`. The `name` allowlist for slots is enforced only for v1. `source` is ignored for v1.

### 2. Resolver changes (`context-resolver.ts`)

New exported function:

```typescript
interface ResolvedContext {
  prompt: { content: string; mode: SystemPromptMode } | undefined
  reminder: string | undefined
}

async function resolveContextTemplate(
  template: ContextTemplate,
  context: ResolverContext
): Promise<ResolvedContext>
```

Changes to section resolution:
- Per-section `max_chars`: after resolving content, truncate to limit with `\n[truncated]` suffix
- Global `max_chars`: after joining all sections, throw if total chars exceeds budget
- `when.exists`: check `existsSync(join(process.cwd(), when.exists))` before resolving
- Open-ended slots: walk `source` dot-path into `context.agentProfile` parsed TOML
  - String arrays → resolve as file refs (same as current `additionalBase`)
  - Source paths ending in `Exec` → resolve as command arrays (execute each, concatenate output)
- `{{var}}` interpolation: replace known variables in inline section content before returning

The existing `resolveSystemPromptTemplate()` function continues to work unchanged for v1 callers.

### 3. Materialization changes (`system-prompt.ts`)

- `loadSystemPromptTemplate()` → also checks for `context-template.toml` (preferred over `system-prompt-template.toml`)
- Template discovery order becomes:
  1. `agent-profile.toml` → `instructions.template`
  2. `~/praesidium/var/agents/context-template.toml`
  3. `~/praesidium/var/agents/system-prompt-template.toml` (v1 fallback)
  4. `$ASP_HOME/context-template.toml`
  5. `$ASP_HOME/system-prompt-template.toml` (v1 fallback)
  6. Built-in default
- `materializeSystemPrompt()` writes both `system-prompt.md` and `session-reminder.md`
- Return type gains `reminderContent: string | undefined`

### 4. CLI changes

New subcommand: `asp resolve-reminder`
- Reads the context template (same discovery chain)
- Resolves only `[[reminder]]` sections
- Outputs to stdout (consumed by SessionStart hook)
- Exit 0 even if no reminder content (empty output is fine)

Update `asp run --dry-run`:
- Show both prompt and reminder sections
- Show per-section char counts and total
- Warn if approaching `max_chars` budget

### 5. Hook changes

Update `hooks.json` to register for both `startup` and `compact`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          { "type": "command", "command": "asp resolve-reminder" }
        ]
      },
      {
        "matcher": "compact",
        "hooks": [
          { "type": "command", "command": "asp resolve-reminder" }
        ]
      }
    ]
  }
}
```

Update `agent_motd.sh` to delegate to `asp resolve-reminder`:

```bash
main() {
    LOG_FILE=~/praesidium/var/logs/motd-calls.log
    mkdir -p "$(dirname "$LOG_FILE")"
    PAYLOAD=$(cat)
    { echo "=== $(date -Iseconds) ==="; echo "$PAYLOAD"; echo ""; } >> "$LOG_FILE"

    asp resolve-reminder 2>/dev/null || true
}
```

### 6. Template migration

Create `~/praesidium/var/agents/context-template.toml` with the v2 format. Keep `system-prompt-template.toml` for v1 fallback until all agents are migrated. No breaking changes — v1 templates continue to work.

---

## Agent-profile.toml session config

New `[session]` table in agent-profile.toml for per-agent reminder customization:

```toml
# agent-profile.toml for rex
[agent]
name = "rex"

[instructions]
template = "context-template.toml"
additionalBase = ["rex-authority.md"]

[session]
additionalContext = ["rex-session-banner.md"]
additionalExec = [
  "wrkq cat $(wrkq current 2>/dev/null) 2>/dev/null || echo 'No current task'",
  "COUNT=$(agentchat pending --count 2>/dev/null); [ \"$COUNT\" != \"0\" ] && echo \"Inbox: $COUNT pending messages\"",
]
```

---

## Test plan

### Parser tests (context-template.test.ts)

- Parses v2 template with `[[prompt]]` and `[[reminder]]` sections into separate arrays
- Parses v1 template with `[[section]]` into promptSections only (backwards compat)
- Rejects schema_version 2 templates that use `[[section]]` (must use `[[prompt]]`/`[[reminder]]`)
- Validates `max_chars` is a positive integer
- Validates `source` is required for v2 slot sections
- Validates `when.exists` is a string
- Rejects unknown `when` predicate keys

### Resolver tests (context-resolver.test.ts)

- Resolves prompt and reminder sections independently
- Truncates section output at `max_chars` with `[truncated]` marker
- Throws when total resolved content exceeds global `max_chars`
- Skips sections when `when.exists` file does not exist
- Includes sections when `when.exists` file exists
- Resolves open-ended slots via dot-path walk into agent profile
- Resolves `additionalExec` arrays as commands
- Interpolates `{{var}}` in inline content
- Returns undefined for empty prompt/reminder
- Existing v1 resolver tests continue to pass unchanged

### Integration tests

- `asp run <agent> --dry-run` shows both prompt and reminder with sizes
- `asp resolve-reminder` outputs only reminder content
- v1 templates work with no behavior change
- `max_chars` violation produces clear error message with section sizes

### E2E manual validation (NO MOCKS)

These tests must be run against real files and real agents — no mocks, no stubs.

1. **v2 dry-run with real template**: Create a `context-template.toml` (v2) in a temp agent root with real file/inline/exec sections. Run `asp run <target> --dry-run` and verify:
   - Prompt sections are rendered and displayed with char counts
   - Reminder sections are rendered separately
   - `when.exists` sections are correctly included/excluded based on actual file presence
   - `{{var}}` interpolation resolves actual context values

2. **`asp resolve-reminder` standalone**: From a project directory with a justfile, run `asp resolve-reminder` and verify:
   - Reminder-only sections are output to stdout
   - No prompt sections leak into reminder output
   - Exit 0 even when no reminder content

3. **v1 backwards compatibility**: Run `asp run <target> --dry-run` with the existing v1 `system-prompt-template.toml`. Verify:
   - Output is identical to pre-v2 behavior
   - No regressions in section resolution
   - `[[section]]` arrays are treated as prompt-only

4. **`max_chars` enforcement**: Create a v2 template with a low `max_chars` (e.g., 100) and sections that exceed it. Run `asp run --dry-run` and verify the error message includes per-section sizes.

5. **SessionStart hook integration**: Launch a real agent session with v2 template. Verify:
   - System prompt contains only `[[prompt]]` section content
   - `<system-reminder>` at session start contains `[[reminder]]` section content
   - Check `~/praesidium/var/logs/motd-calls.log` for hook execution evidence

6. **Template discovery chain**: Verify priority by placing templates at different levels:
   - Agent-specific template in `agent-profile.toml` → `instructions.template` takes priority
   - `context-template.toml` in agentsRoot takes priority over `system-prompt-template.toml`
   - Fallback to v1 template works when no v2 template exists
