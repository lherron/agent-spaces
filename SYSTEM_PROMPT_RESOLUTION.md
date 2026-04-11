# System Prompt Resolution — Design Spec

## Status

This spec replaces the current `resolveInstructionLayer()` approach with a template-driven
system prompt engine. Partial groundwork is already in place (see "Current State" below).

## Problem

1. **No system-wide instructions.** Every agent's SOUL.md must duplicate platform conventions,
   safety rails, and environment context. No shared preamble/postamble.
2. **No precedence control.** The instruction layer concatenation order is hardcoded in
   `resolveInstructionLayer()`. There's no way to reorder, inject platform content between
   agent sections, or conditionally include content.
3. **No dynamic content.** System prompts are static files. No way to inject `date`, service
   status, git state, or other runtime context.
4. **`--system-prompt` vs `--append-system-prompt`.** Some agents want to replace the default
   Claude Code system prompt entirely; others want to append to it. Currently hardcoded to
   replace.

## Current State (as of this writing)

The following changes are already implemented and working:

### What's done

- **`materializeSystemPrompt()`** lives in `packages/runtime/src/system-prompt.ts` (shared).
  Both the CLI `asp run` path (`packages/execution/src/run.ts`) and the SDK client path
  (`packages/agent-spaces/src/client.ts`) call it.
- It calls `resolveInstructionLayer()` to get instruction slots, concatenates them with
  `\n\n---\n\n`, writes to `system-prompt.md` in the output directory.
- The content is passed via `--system-prompt` to Claude Code CLI (replaces default prompt)
  and via `systemPrompt` to the Agent SDK.
- `HarnessRunOptions` has `systemPrompt?: string` which flows through
  `claude-adapter.buildRunArgs()` → `buildClaudeArgs()` → `--system-prompt <content>`.
- `asp run rex --dry-run` prints "System prompt:" followed by the content, then "Command:".

### Key files

| File | Role |
|------|------|
| `packages/runtime/src/system-prompt.ts` | `materializeSystemPrompt()` — entry point, writes system-prompt.md |
| `packages/config/src/resolver/instruction-layer.ts` | `resolveInstructionLayer()` — to be replaced by template engine |
| `packages/config/src/core/types/harness.ts` | `HarnessRunOptions.systemPrompt` |
| `packages/harness-claude/src/claude/invoke.ts` | `ClaudeInvokeOptions.systemPrompt`, `buildClaudeArgs()` emits `--system-prompt` |
| `packages/harness-claude/src/adapters/claude-adapter.ts` | Threads `systemPrompt` from run options into `buildClaudeArgs()` |
| `packages/execution/src/run.ts` | CLI `run()` calls `materializeSystemPrompt()`, prints prompt in dry-run |
| `packages/agent-spaces/src/client.ts` | SDK paths call `materializeSystemPrompt()` |
| `packages/harness-claude/src/agent-sdk/agent-session.ts` | Agent SDK uses `systemPrompt` in session config |

### Relevant types

```typescript
// packages/config/src/core/types/harness.ts
interface HarnessRunOptions {
  systemPrompt?: string | undefined
  // ... other fields
}

// packages/harness-claude/src/claude/invoke.ts
interface ClaudeInvokeOptions {
  systemPrompt?: string | undefined  // emits --system-prompt
  // ... other fields
}

// packages/agent-spaces/src/types.ts
type ProcessInvocationSpec = {
  systemPromptFile?: string | undefined  // path to materialized file (audit)
  // ... other fields
}
```

## Design: Template-Driven System Prompt

### Template file: `system-prompt-template.toml`

Located at (resolution order):
1. Agent-specific: `agent-profile.toml` → `instructions.template` (relative to agent root)
2. Agents root: `~/praesidium/var/agents/system-prompt-template.toml`
3. ASP home: `$ASP_HOME/system-prompt-template.toml`
4. Built-in default: hardcoded in engine (reproduces current concat behavior)

```toml
schema_version = 1
mode = "replace"   # "replace" → --system-prompt | "append" → --append-system-prompt

[[section]]
name = "platform"
type = "file"
path = "platform-prompt.md"

[[section]]
name = "soul"
type = "file"
path = "agent-root:///SOUL.md"
required = true

[[section]]
name = "additional-base"
type = "slot"

[[section]]
name = "environment"
type = "exec"
command = "date '+Today is %Y-%m-%d.'"

[[section]]
name = "heartbeat"
type = "file"
path = "agent-root:///HEARTBEAT.md"
when = { runMode = "heartbeat" }

[[section]]
name = "scaffold"
type = "slot"

[[section]]
name = "conventions"
type = "file"
path = "conventions.md"
```

### Root-level fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `schema_version` | integer | required | Schema version (1) |
| `mode` | `"replace"` or `"append"` | `"replace"` | `replace` → `--system-prompt` (overwrites default). `append` → `--append-system-prompt` (adds to default). |

### Section types

| Type | Description | Key fields |
|------|-------------|------------|
| `file` | Read content from a file on disk | `path` (required), `required` (default false) |
| `inline` | Literal string content | `content` (required) |
| `exec` | Run a shell command, capture stdout | `command` (required), `timeout` (default 5000ms) |
| `slot` | Filled at materialization time from runtime data | (name determines which slot) |

### Section fields (common)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | required | Unique section identifier |
| `type` | string | required | One of: `file`, `inline`, `exec`, `slot` |
| `when` | table | omit | Conditional: `{ runMode = "heartbeat" }`. Section skipped if predicate fails. |
| `required` | boolean | `false` | If true, fail materialization when content is missing/empty. Only meaningful for `file` type. |

### Path resolution

Paths in `file` sections resolve as:
- `agent-root:///...` → relative to the agent's root directory
- `project-root:///...` → relative to the project root
- Otherwise → relative to the agents root directory (`~/praesidium/var/agents/`)

### Slot definitions

Two built-in slots, identified by section `name`:

| Slot name | Source | Description |
|-----------|--------|-------------|
| `additional-base` | `agent-profile.toml` → `instructions.additionalBase` | All refs resolved and concatenated with `\n\n`. If the array is empty or the key is absent, section is skipped. |
| `scaffold` | Host scaffold packets from the placement request | All packets concatenated with `\n\n`. If no packets, section is skipped. |

### Exec behavior

- Commands run via `/bin/bash -c "<command>"`
- Working directory: agent root (if available), otherwise agents root
- Timeout: configurable per section (default 5000ms)
- Non-zero exit or timeout → section is silently skipped (not fatal)
- stderr is discarded
- stdout is trimmed and used as section content

### Section assembly

1. Parse template (resolve template chain)
2. Walk sections in declared order
3. For each section:
   - Evaluate `when` predicate — skip if false
   - Resolve content by type
   - Skip if content is empty (unless `required`, then fail)
4. Join non-empty section contents with `\n\n---\n\n`
5. Write to `system-prompt.md`
6. Pass to harness based on `mode`:
   - `replace` → `--system-prompt <content>` / `systemPrompt` in SDK
   - `append` → `--append-system-prompt <content>` / `appendSystemPrompt` in SDK

### What happens to resolveInstructionLayer()

It is **eliminated**. Its responsibilities are distributed:

| Old responsibility | New owner |
|-------------------|-----------|
| Read SOUL.md | Template engine: `type = "file"`, `path = "agent-root:///SOUL.md"` |
| Read HEARTBEAT.md conditionally | Template engine: `type = "file"` with `when = { runMode = "heartbeat" }` |
| Read additionalBase from profile | Template engine: `type = "slot"`, `name = "additional-base"` — engine reads profile and concatenates refs |
| Read byMode from profile | Eliminated — use `when` predicates on file sections, or agent overrides template |
| Read scaffold packets | Template engine: `type = "slot"`, `name = "scaffold"` |
| Root-relative ref resolution | Template engine's file resolver (same `agent-root:///` / `project-root:///` scheme) |

### Implementation plan

#### 1. Template parser (`packages/runtime/src/system-prompt-template.ts`)

- Parse TOML template file
- Validate schema (section types, required fields)
- Return typed `SystemPromptTemplate` with sections array and mode

#### 2. Template resolver (`packages/runtime/src/system-prompt-resolver.ts`)

- Takes: parsed template + context (agent root, project root, run mode, scaffold packets, agents root)
- Walks sections, evaluates `when`, resolves content by type
- Slot filler: reads agent-profile.toml for `additional-base`, uses scaffold packets for `scaffold`
- Returns: `{ content: string, mode: 'replace' | 'append' }`

#### 3. Update `materializeSystemPrompt()` (`packages/runtime/src/system-prompt.ts`)

- Load template (resolution chain)
- Call resolver
- Write to `system-prompt.md`
- Return `{ path, content, mode }`

#### 4. Thread `mode` through the harness

- `HarnessRunOptions` gets `systemPromptMode?: 'replace' | 'append'`
- `ClaudeInvokeOptions` gets `appendSystemPrompt?: string` (in addition to existing `systemPrompt`)
- `buildClaudeArgs()`: if mode is append, emit `--append-system-prompt` instead of `--system-prompt`
- Agent SDK: use `appendSystemPrompt` option if mode is append

#### 5. Deprecate and remove `resolveInstructionLayer()`

- Remove from `packages/config/src/resolver/instruction-layer.ts`
- Remove exports from `packages/config/src/index.ts`
- Update any remaining callers (placement-resolver.ts uses it for audit metadata — switch to template engine)

#### 6. Tests

- Template parsing (valid/invalid TOML, missing required fields)
- Section resolution (each type: file, inline, exec, slot)
- `when` predicate evaluation
- Exec timeout and failure handling
- Slot filling (additional-base from profile, scaffold from request)
- Mode threading (replace vs append flag in argv)
- Template resolution chain (agent override → agents root → asp home → built-in)
- End-to-end: `asp run rex --dry-run` produces expected prompt with template

## Filesystem layout reference

```
~/praesidium/
  var/
    agents/                              # agents root (ASP_AGENTS_ROOT)
      system-prompt-template.toml        # system-wide template ← NEW
      platform-prompt.md                 # system-wide preamble ← NEW
      conventions.md                     # system-wide postamble ← NEW
      rex/                               # agent root
        SOUL.md                          # agent identity
        HEARTBEAT.md                     # heartbeat-mode instructions
        LORE.md                          # optional extra context
        agent-profile.toml               # agent config
        spaces/                          # agent-local spaces
      alice/
        SOUL.md
        agent-profile.toml
    spaces-repo/                         # ASP home / registry
      projects/                          # materialized project bundles
        agent-spaces-.../
          targets/rex/claude/
            system-prompt.md             # materialized output
            plugins/
            settings.json
```
