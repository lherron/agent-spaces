import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EventFamily, EvidenceAuthority } from 'spaces-harness-broker-protocol'
import { EVENT_FAMILY_BY_TYPE } from 'spaces-harness-broker-protocol'
import { PI_SDK_AUTHORITY } from '../../../harness-broker-pi-sdk/src/evidence-authority'
import {
  CLAUDE_IGNORED_ATTACHMENT_TYPES,
  CLAUDE_IGNORED_ROW_TYPES,
  CLAUDE_KNOWN_HOOK_NAMES,
  CLAUDE_KNOWN_SYSTEM_SUBTYPES,
  CLAUDE_TRANSCRIPT_OWNED_HOOK_FACTS,
} from '../../src/drivers/claude-code-tmux/native-types'
import {
  CODEX_ITEM_CARRYING_EVENT_MSG_TYPES,
  CODEX_KNOWN_ROLLOUT_EVENT_MSG_TYPES,
} from '../../src/drivers/codex-cli-tmux/native-types'
import {
  AGENT_HARNESS_TMUX_AUTHORITY,
  BROKER_ONLY_AUTHORITY,
  CLAUDE_CODE_TMUX_AUTHORITY,
  CODEX_APP_SERVER_AUTHORITY,
  CODEX_CLI_TMUX_AUTHORITY,
  PI_TUI_TMUX_AUTHORITY,
} from '../../src/drivers/evidence-authority'

/**
 * `AUTHORITY.md` is the PUBLISHED form of the code declaration (T-07853 §6,
 * spec item 1: "check in AUTHORITY.md AND a per-driver code declaration"). A
 * published matrix that has drifted from the enforced one is worse than no
 * published matrix, so the two are checked against each other here.
 */
const AUTHORITY_MD = readFileSync(join(import.meta.dir, '../../AUTHORITY.md'), 'utf8')

const DECLARED: Record<string, Record<EventFamily, EvidenceAuthority>> = {
  'claude-code-tmux': CLAUDE_CODE_TMUX_AUTHORITY,
  'codex-cli-tmux': CODEX_CLI_TMUX_AUTHORITY,
  'codex-app-server': CODEX_APP_SERVER_AUTHORITY,
  'pi-tui-tmux': PI_TUI_TMUX_AUTHORITY,
  'agent-harness-tmux': AGENT_HARNESS_TMUX_AUTHORITY,
  'pi-sdk': PI_SDK_AUTHORITY,
}

/** Parse the `## The matrix` table into {driver: {family: authority}}. */
function publishedMatrix(): Record<string, Record<string, string>> {
  const section = AUTHORITY_MD.split('## The matrix')[1]?.split('\n## ')[0] ?? ''
  const rows = section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim())
    )
  const header = rows[0]
  expect(header?.[0]).toBe('Family')
  const drivers = header?.slice(1) ?? []
  const out: Record<string, Record<string, string>> = {}
  for (const driver of drivers) out[driver] = {}
  for (const row of rows.slice(2)) {
    const family = row[0]?.replace(/`/g, '') ?? ''
    if (family.length === 0) continue
    for (const [index, driver] of drivers.entries()) {
      // Cells may be bolded for emphasis and footnoted with † / ‡.
      const cell = (row[index + 1] ?? '').replace(/[*†‡]/g, '').trim()
      const target = out[driver]
      if (target !== undefined) target[family] = cell
    }
  }
  return out
}

describe('AUTHORITY.md matches the enforced declaration', () => {
  const published = publishedMatrix()

  test('the published table names exactly the drivers that declare a matrix', () => {
    expect(Object.keys(published).sort()).toEqual(Object.keys(DECLARED).sort())
  })

  for (const [driver, declared] of Object.entries(DECLARED)) {
    test(`${driver}: every family's published value equals the code declaration`, () => {
      const publishedForDriver = published[driver] ?? {}
      expect(publishedForDriver).toEqual(declared as unknown as Record<string, string>)
    })
  }

  test('every event family appears in the published table', () => {
    const families = new Set(Object.values(EVENT_FAMILY_BY_TYPE))
    const publishedFamilies = new Set(Object.keys(published['claude-code-tmux'] ?? {}))
    expect([...families].sort()).toEqual([...publishedFamilies].sort())
  })

  test('the load-bearing families section lists the families and the T-07883 ruling', () => {
    const section = AUTHORITY_MD.split('## Load-bearing families')[1]?.split('\n## ')[0] ?? ''
    for (const family of [
      'turn-bracket',
      'conversation',
      'tool',
      'input-admission',
      'submission-disposition',
      'permission',
    ]) {
      expect(section).toContain(`\`${family}\``)
    }
    // The taxonomy survived the ruling; the halt did not. Published prose that
    // still promised a halt would send the next operator hunting for a release
    // command that no longer does anything, so the ruling is pinned HERE, in
    // the section that used to carry the halt clause.
    expect(section).toContain('T-07883')
    expect(section).toContain(
      '"We should never halt when an unknown event arrives. Harnesses are upgraded'
    )
    expect(section).toContain('**the cursor advances.**')
    expect(section).toContain('`snapshot.capture.state` is always `open`')
    // And nowhere in the file does a live behaviour still claim to halt.
    expect(AUTHORITY_MD).not.toContain('stops that invocation')
    expect(AUTHORITY_MD).not.toContain('## Operating a halt')
  })

  test('broker-owned families are broker for EVERY driver', () => {
    // No provider reports admission, supervision, invocation lifecycle or the
    // terminal-surface lease. A driver claiming otherwise would be declaring an
    // authority it cannot have.
    for (const [driver, matrix] of Object.entries(DECLARED)) {
      expect({
        driver,
        admission: matrix['input-admission'],
        supervision: matrix['turn-supervision'],
        lifecycle: matrix['invocation-lifecycle'],
        surface: matrix['terminal-surface'],
      }).toEqual({
        driver,
        admission: 'broker',
        supervision: 'broker',
        lifecycle: 'broker',
        surface: 'broker',
      })
    }
    expect(BROKER_ONLY_AUTHORITY['conversation']).toBe('broker')
  })
})

/**
 * The Phase 3 authority decisions (T-07870) rest on facts about what the codex
 * rollout CAN contain, read off `codex-rs/rollout/src/policy.rs`. A future edit
 * that adds one of these types to the pinned table would mean codex started
 * persisting it — which is exactly the moment the corresponding family decision
 * has to be revisited, so it fails here rather than going unnoticed.
 */
describe('Phase 3: the source facts the codex-cli-tmux decisions rest on', () => {
  test('the rollout has no permission vocabulary, so `permission` cannot leave hook', () => {
    for (const type of [
      'exec_approval_request',
      'apply_patch_approval_request',
      'request_permissions',
      'request_user_input',
      'elicitation_request',
    ]) {
      expect(CODEX_KNOWN_ROLLOUT_EVENT_MSG_TYPES.has(type)).toBe(false)
    }
    expect(CODEX_CLI_TMUX_AUTHORITY.permission).toBe('hook')
  })

  test('the rollout has no tool-START vocabulary, so `tool` cannot leave hook', () => {
    for (const type of ['exec_command_begin', 'mcp_tool_call_begin', 'web_search_begin']) {
      expect(CODEX_KNOWN_ROLLOUT_EVENT_MSG_TYPES.has(type)).toBe(false)
    }
    // `item_started` IS pinned (it is a real variant and shares the item
    // channel) but `policy.rs` never persists it, so it is not tool-start
    // evidence either — it is classified, not available.
    expect(CODEX_ITEM_CARRYING_EVENT_MSG_TYPES.has('item_started')).toBe(true)
    expect(CODEX_CLI_TMUX_AUTHORITY.tool).toBe('hook')
  })

  test('the rollout has no harness-exit vocabulary, so `harness-lifecycle` cannot leave hook', () => {
    for (const type of ['shutdown_complete', 'session_configured']) {
      expect(CODEX_KNOWN_ROLLOUT_EVENT_MSG_TYPES.has(type)).toBe(false)
    }
    expect(CODEX_CLI_TMUX_AUTHORITY['harness-lifecycle']).toBe('hook')
  })

  test('the turn bracket rows EXIST — this one is a wakeup gap, not a vocabulary gap', () => {
    // Stated as a test so the distinction survives: `task_complete` is pinned
    // and always persisted; what the reader lacks is a wakeup that reaches it
    // after the Stop hook. See AUTHORITY.md "the reader has no wakeup".
    for (const type of ['task_started', 'task_complete', 'turn_aborted']) {
      expect(CODEX_KNOWN_ROLLOUT_EVENT_MSG_TYPES.has(type)).toBe(true)
    }
    expect(CODEX_CLI_TMUX_AUTHORITY['turn-bracket']).toBe('hook')
  })
})

/**
 * The Phase 4 authority decisions (T-07873) rest on facts about what a Claude
 * Code SESSION JSONL contains, measured over the three archived T-07849
 * sessions (835 rows, 36 turns) and a live seat's own raw ingress journal. Each
 * test below is one of those facts. If a future Claude release changes one —
 * starts writing permission rows, stops writing usage on assistant rows — the
 * corresponding family decision has to be revisited, so it fails here rather
 * than quietly making AUTHORITY.md wrong.
 */
describe('Phase 4: the source facts the claude-code-tmux decisions rest on', () => {
  const phase4 = AUTHORITY_MD.split('## Phase 4:')[1]?.split('\n## ')[0] ?? ''

  test('the session JSONL has no permission vocabulary, so `permission` cannot leave hook', () => {
    // `permission-mode` is the UI LATCH (which mode the TUI is in), not a
    // request or a decision — which is why it is an ignored row and not
    // permission evidence.
    expect(CLAUDE_IGNORED_ROW_TYPES.has('permission-mode')).toBe(true)
    for (const type of [...CLAUDE_IGNORED_ROW_TYPES, ...CLAUDE_KNOWN_SYSTEM_SUBTYPES]) {
      expect(type).not.toMatch(/permission_(request|resolved)|approval/)
    }
    for (const attachment of CLAUDE_IGNORED_ATTACHMENT_TYPES) {
      expect(attachment).not.toMatch(/permission|approval/)
    }
    // The only evidence there is:
    expect(CLAUDE_KNOWN_HOOK_NAMES.has('PermissionRequest')).toBe(true)
    expect(CLAUDE_KNOWN_HOOK_NAMES.has('PermissionResolved')).toBe(true)
    expect(CLAUDE_CODE_TMUX_AUTHORITY.permission).toBe('hook')
  })

  test('the turn terminal rows EXIST and are pinned — this is a completeness gap, not a vocabulary one', () => {
    // Stated as a test so the distinction survives: `turn_duration` and
    // `stop_hook_summary` are read and pinned. What they lack is presence on
    // the interrupt path and on a still-running final turn, plus the fact that
    // `stop_hook_summary` records the Stop hooks' own durations and therefore
    // cannot be written before them.
    expect(CLAUDE_KNOWN_SYSTEM_SUBTYPES.has('turn_duration')).toBe(true)
    expect(CLAUDE_KNOWN_SYSTEM_SUBTYPES.has('stop_hook_summary')).toBe(true)
    expect(CLAUDE_IGNORED_ROW_TYPES.has('system')).toBe(false)
    expect(CLAUDE_CODE_TMUX_AUTHORITY['turn-bracket']).toBe('hook')
  })

  test('the measured turn-bracket numbers are published, not just asserted in a commit message', () => {
    // The decision is only auditable if the numbers behind it are in the
    // published document. These are the archived-corpus measurements.
    expect(phase4).toContain('33 of 36')
    expect(phase4).toContain('0 of 2')
    expect(phase4).toContain('2 of 3')
    expect(phase4).toContain('min 57 / p50 68 / max 1085 ms')
  })

  test('usage is on EVERY assistant row, which is why `usage` finally emits', () => {
    expect(CLAUDE_CODE_TMUX_AUTHORITY.usage).toBe('native')
    expect(phase4).toContain('155 of 155')
    // `cost-state` stopped being an ignored row when it became a usage record.
    expect(CLAUDE_IGNORED_ROW_TYPES.has('cost-state')).toBe(false)
  })

  test('the tool hooks and the transcript share ONE id space, which is what lets `tool` move', () => {
    // If `PreToolUse.tool_use_id` were a different id space from the
    // `tool_use` block id, a transcript-primary `tool` would sever the
    // permission-to-tool join — the exact reason codex's `tool` stays hook.
    expect(CLAUDE_CODE_TMUX_AUTHORITY.tool).toBe('native')
    expect(CLAUDE_CODE_TMUX_AUTHORITY.permission).toBe('hook')
    expect([...CLAUDE_TRANSCRIPT_OWNED_HOOK_FACTS.keys()].sort()).toEqual([
      'MessageDisplay',
      'PostToolUse',
      'PreToolUse',
    ])
    // Those hooks are still REGISTERED — they are controls, not removed.
    for (const hook of CLAUDE_TRANSCRIPT_OWNED_HOOK_FACTS.keys()) {
      expect(CLAUDE_KNOWN_HOOK_NAMES.has(hook)).toBe(true)
    }
  })

  test('structured output has no transcript row at all, so it can never be native', () => {
    expect(phase4.length).toBeGreaterThan(0)
    for (const type of [...CLAUDE_IGNORED_ROW_TYPES, ...CLAUDE_KNOWN_SYSTEM_SUBTYPES]) {
      expect(type).not.toMatch(/structured/)
    }
    expect(AUTHORITY_MD).toContain('broker-synthesized')
  })
})
