import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EventFamily, EvidenceAuthority } from 'spaces-harness-broker-protocol'
import { EVENT_FAMILY_BY_TYPE } from 'spaces-harness-broker-protocol'
import { createPiSdkDriver } from '../../../harness-broker-pi-sdk/src/driver'
import { PI_SDK_AUTHORITY } from '../../../harness-broker-pi-sdk/src/evidence-authority'
import { createDefaultBroker } from '../../src/default-broker'
import { createDefaultCodexCliTmuxDriver } from '../../src/drivers/codex-cli-tmux/driver'
import type { Driver } from '../../src/drivers/driver'
import {
  ARRIS_RESIDENT_AUTHORITY,
  CLAUDE_CODE_HRCPTY_AUTHORITY,
  CLAUDE_CODE_TMUX_AUTHORITY,
  CODEX_APP_SERVER_AUTHORITY,
  CODEX_CLI_TMUX_AUTHORITY,
  CODEX_DESKTOP_AUTHORITY,
  MUSE_CLI_TMUX_AUTHORITY,
  MUSE_SERVE_AUTHORITY,
  PI_TUI_TMUX_AUTHORITY,
} from '../../src/drivers/evidence-authority'
import { createDefaultPiTuiTmuxDriver } from '../../src/drivers/pi-tui-tmux/driver'

/**
 * `harness-broker-evidence-authority.md` is the PUBLISHED form of the code declaration (T-07853 §6,
 * spec item 1: "check in harness-broker-evidence-authority.md AND a per-driver code declaration"). A
 * published matrix that has drifted from the enforced one is worse than no
 * published matrix, so the two are checked against each other here.
 */
const AUTHORITY_MD = readFileSync(
  join(import.meta.dir, '../../../../architecture/contracts/harness-broker-evidence-authority.md'),
  'utf8'
)

const DECLARED: Record<string, Record<EventFamily, EvidenceAuthority>> = {
  'claude-code-tmux': CLAUDE_CODE_TMUX_AUTHORITY,
  'claude-code-hrcpty': CLAUDE_CODE_HRCPTY_AUTHORITY,
  'codex-cli-tmux': CODEX_CLI_TMUX_AUTHORITY,
  'codex-app-server': CODEX_APP_SERVER_AUTHORITY,
  'muse-serve': MUSE_SERVE_AUTHORITY,
  'muse-cli-tmux': MUSE_CLI_TMUX_AUTHORITY,
  'codex-desktop': CODEX_DESKTOP_AUTHORITY,
  'arris-resident': ARRIS_RESIDENT_AUTHORITY,
  'pi-tui-tmux': PI_TUI_TMUX_AUTHORITY,
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

describe('harness-broker-evidence-authority.md matches the enforced declaration', () => {
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
    expect<string[]>([...families].sort()).toEqual([...publishedFamilies].sort())
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
})

/**
 * The Phase 4 authority decisions (T-07873) rest on facts about what a Claude
 * Code SESSION JSONL contains, measured over the three archived T-07849
 * sessions (835 rows, 36 turns) and a live seat's own raw ingress journal. Each
 * test below is one of those facts. If a future Claude release changes one —
 * starts writing permission rows, stops writing usage on assistant rows — the
 * corresponding family decision has to be revisited, so it fails here rather
 * than quietly making harness-broker-evidence-authority.md wrong.
 */
describe('Phase 4: the source facts the claude-code-tmux decisions rest on', () => {
  const phase4 = AUTHORITY_MD.split('## Phase 4:')[1]?.split('\n## ')[0] ?? ''

  test('the measured turn-bracket numbers are published, not just asserted in a commit message', () => {
    // The decision is only auditable if the numbers behind it are in the
    // published document. These are the archived-corpus measurements.
    expect(phase4).toContain('33 of 36')
    expect(phase4).toContain('0 of 2')
    expect(phase4).toContain('2 of 3')
    expect(phase4).toContain('min 57 / p50 68 / max 1085 ms')
  })
})

describe('broker hello: driver evidence authority', () => {
  test('no shipped driver advertises provider authority over broker-owned families', async () => {
    // No provider reports admission, supervision, invocation lifecycle or the
    // terminal-surface lease. A driver claiming otherwise would be declaring an
    // authority it cannot have. Read off the LIVE broker's hello, which is what
    // a consumer sees, for every built-in driver plus the composed ones.
    const broker = createDefaultBroker(undefined, undefined, {
      additionalDrivers: [
        () => createDefaultCodexCliTmuxDriver(),
        () => createDefaultPiTuiTmuxDriver(),
        // The SDK resolves the published broker type while this test imports the
        // same implementation from source; their private DispatchEnv brands
        // have distinct TypeScript identities despite sharing the runtime API.
        () => createPiSdkDriver() as unknown as Driver,
      ],
    })
    const hello = await broker.hello({
      clientInfo: { name: 'authority-matrix-test' },
      protocolVersions: ['harness-broker/0.2'],
    })
    expect(hello.drivers.map((driver) => driver.kind).sort()).toEqual(Object.keys(DECLARED).sort())
    for (const summary of hello.drivers) {
      const matrix = summary.evidenceAuthority
      expect({
        driver: summary.kind,
        admission: matrix?.['input-admission'],
        supervision: matrix?.['turn-supervision'],
        lifecycle: matrix?.['invocation-lifecycle'],
        surface: matrix?.['terminal-surface'],
      }).toEqual({
        driver: summary.kind,
        admission: 'broker',
        supervision: 'broker',
        lifecycle: 'broker',
        surface: 'broker',
      })
    }
  })
})
