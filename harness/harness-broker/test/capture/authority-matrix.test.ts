import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EventFamily, EvidenceAuthority } from 'spaces-harness-broker-protocol'
import { EVENT_FAMILY_BY_TYPE } from 'spaces-harness-broker-protocol'
import { PI_SDK_AUTHORITY } from '../../../harness-broker-pi-sdk/src/evidence-authority'
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

  test('the load-bearing families section lists the families that halt the cursor', () => {
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
