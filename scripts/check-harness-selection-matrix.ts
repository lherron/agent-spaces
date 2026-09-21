/**
 * User-runnable resolver capability-matrix gate (T-08706).
 *
 * Proves the pure v2 resolver selects the drivers and hosting shapes fixed by
 * the approved retained-harness capability matrix
 * (docs/proposals/producer-owned-harness-selection.md, section 4).
 *
 * Run: `just check-harness-selection-matrix` (or
 * `bun scripts/check-harness-selection-matrix.ts` directly) from a normal
 * source checkout. No ASP install, no aspd, no HRC configuration.
 *
 * The expected matrix below is a deliberately independent hard-coded
 * acceptance fixture: it must never be derived from catalog projections or
 * share production resolution code. Each row resolves with omitted
 * provider/model so catalog defaults are exercised without expanding into
 * provider/model combinatorics.
 *
 * Prints a compact human-readable table and exits zero only when every row
 * matches. A mismatch prints the input row plus expected and actual fields
 * and exits nonzero.
 */
import { resolveHarnessExecution } from '../compiler/agent-spaces/src/harness-selection/resolve.ts'

type ExpectedRow = {
  /** Human label for the table. */
  name: string
  /** Selection inputs. Omitted keys exercise catalog defaults. */
  requested?: { harness?: 'agent-harness' | 'claude' | 'codex' | 'muse'; presentation?: boolean }
  expected: {
    harness: string
    presentation: boolean
    driver: string
    executionTransport: string
    terminalRequired: boolean
    terminalHost?: string | undefined
    processExecution: string
    presentationFulfillment: string
    /** JSON of the expected presentation surface; undefined means absent. */
    presentationSurface?: string | undefined
  }
}

/**
 * Independent acceptance fixture. Source: T-08706 required rows reconciled
 * with the approved capability matrix (T-08699). `presentation: false` means
 * no operator UI was requested; it never forbids a terminal the chosen
 * implementation requires internally (claude rows).
 */
const EXPECTED_ROWS: readonly ExpectedRow[] = [
  {
    name: 'agent-harness / no presentation',
    requested: { harness: 'agent-harness', presentation: false },
    expected: {
      harness: 'agent-harness',
      presentation: false,
      driver: 'agent-harness',
      executionTransport: 'native-worker',
      terminalRequired: false,
      terminalHost: undefined,
      processExecution: 'native-worker',
      presentationFulfillment: 'birth-variant',
      presentationSurface: undefined,
    },
  },
  {
    name: 'agent-harness / presentation',
    requested: { harness: 'agent-harness', presentation: true },
    expected: {
      harness: 'agent-harness',
      presentation: true,
      driver: 'agent-harness-tmux',
      executionTransport: 'native-worker',
      terminalRequired: true,
      terminalHost: 'tmux',
      processExecution: 'native-worker',
      presentationFulfillment: 'birth-variant',
      presentationSurface: undefined,
    },
  },
  {
    name: 'claude / no presentation (tmux required internally)',
    requested: { harness: 'claude', presentation: false },
    expected: {
      harness: 'claude',
      presentation: false,
      driver: 'claude-code-tmux',
      executionTransport: 'pty',
      terminalRequired: true,
      terminalHost: 'tmux',
      processExecution: 'broker-process',
      presentationFulfillment: 'intrinsic',
      presentationSurface: undefined,
    },
  },
  {
    name: 'claude / presentation',
    requested: { harness: 'claude', presentation: true },
    expected: {
      harness: 'claude',
      presentation: true,
      driver: 'claude-code-tmux',
      executionTransport: 'pty',
      terminalRequired: true,
      terminalHost: 'tmux',
      processExecution: 'broker-process',
      presentationFulfillment: 'intrinsic',
      presentationSurface: undefined,
    },
  },
  {
    name: 'codex / no presentation',
    requested: { harness: 'codex', presentation: false },
    expected: {
      harness: 'codex',
      presentation: false,
      driver: 'codex-app-server',
      executionTransport: 'jsonrpc-stdio',
      terminalRequired: false,
      terminalHost: undefined,
      processExecution: 'broker-process',
      presentationFulfillment: 'attachable',
      presentationSurface: undefined,
    },
  },
  {
    name: 'codex / presentation (attachable TUI surface)',
    requested: { harness: 'codex', presentation: true },
    expected: {
      harness: 'codex',
      presentation: true,
      driver: 'codex-app-server',
      executionTransport: 'jsonrpc-stdio',
      terminalRequired: true,
      terminalHost: 'tmux',
      processExecution: 'broker-process',
      presentationFulfillment: 'attachable',
      presentationSurface: '{"terminalHost":"tmux","transport":"websocket-unix"}',
    },
  },
  {
    name: 'muse / no presentation',
    requested: { harness: 'muse', presentation: false },
    expected: {
      harness: 'muse',
      presentation: false,
      driver: 'muse-serve',
      executionTransport: 'jsonrpc-stdio',
      terminalRequired: false,
      terminalHost: undefined,
      processExecution: 'broker-process',
      presentationFulfillment: 'birth-variant',
      presentationSurface: undefined,
    },
  },
  {
    name: 'muse / presentation',
    requested: { harness: 'muse', presentation: true },
    expected: {
      harness: 'muse',
      presentation: true,
      driver: 'muse-cli-tmux',
      executionTransport: 'pty',
      terminalRequired: true,
      terminalHost: 'tmux',
      processExecution: 'broker-process',
      presentationFulfillment: 'birth-variant',
      presentationSurface: undefined,
    },
  },
  {
    name: 'defaults omitted (harness + presentation)',
    requested: undefined,
    expected: {
      harness: 'agent-harness',
      presentation: false,
      driver: 'agent-harness',
      executionTransport: 'native-worker',
      terminalRequired: false,
      terminalHost: undefined,
      processExecution: 'native-worker',
      presentationFulfillment: 'birth-variant',
      presentationSurface: undefined,
    },
  },
]

const AGENT_ID = 'matrix-check-agent'

function stableStringify(value: unknown): string {
  if (value === undefined) return '—'
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? String(value)
}

function terminalCell(terminalRequired: boolean, terminalHost: string | undefined): string {
  if (!terminalRequired) return 'none'
  return terminalHost ?? 'required'
}

type RowOutcome = {
  row: ExpectedRow
  actual: Record<string, string>
  mismatches: string[]
}

function checkRow(row: ExpectedRow): RowOutcome {
  const resolution = resolveHarnessExecution({
    agent: { id: AGENT_ID },
    ...(row.requested === undefined ? {} : { requested: row.requested }),
  })
  if (!resolution.ok) {
    return {
      row,
      actual: { refusal: `${resolution.code}: ${resolution.message}` },
      mismatches: [`resolution refused (${resolution.code}) instead of resolving`],
    }
  }
  const actual: Record<string, string> = {
    harness: resolution.selection.harness,
    presentation: String(resolution.selection.presentation),
    driver: resolution.recipe.driver,
    executionTransport: resolution.recipe.hosting.executionTransport,
    terminalRequired: String(resolution.recipe.hosting.terminalRequired),
    terminalHost: resolution.recipe.hosting.terminalHost ?? '—',
    processExecution: resolution.recipe.hosting.processExecution,
    presentationFulfillment: resolution.recipe.presentationFulfillment,
    presentationSurface:
      resolution.recipe.presentationSurface === undefined
        ? '—'
        : stableStringify(resolution.recipe.presentationSurface),
  }
  const expectedPairs: Array<[string, string]> = [
    ['harness', row.expected.harness],
    ['presentation', String(row.expected.presentation)],
    ['driver', row.expected.driver],
    ['executionTransport', row.expected.executionTransport],
    ['terminalRequired', String(row.expected.terminalRequired)],
    ['terminalHost', row.expected.terminalHost ?? '—'],
    ['processExecution', row.expected.processExecution],
    ['presentationFulfillment', row.expected.presentationFulfillment],
    ['presentationSurface', row.expected.presentationSurface ?? '—'],
  ]
  const mismatches = expectedPairs
    .filter(([field, want]) => actual[field] !== want)
    .map(([field, want]) => `${field}: expected ${want}, got ${actual[field]}`)
  return { row, actual, mismatches }
}

function padEnd(value: string, width: number): string {
  return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`
}

const outcomes = EXPECTED_ROWS.map(checkRow)
const failures = outcomes.filter((outcome) => outcome.mismatches.length > 0)

const headers = [
  'row',
  'driver',
  'transport',
  'terminal',
  'proc-exec',
  'fulfillment',
  'pres-surface',
  'result',
]
const tableRows = outcomes.map((outcome, index) => {
  const requested = outcome.row.requested
  return [
    `${index + 1}. ${requested?.harness ?? '(omitted)'} / ${
      requested?.presentation === undefined ? '(omitted)' : String(requested.presentation)
    }`,
    outcome.actual['driver'] ?? '?',
    outcome.actual['executionTransport'] ?? '?',
    terminalCell(
      outcome.actual['terminalRequired'] === 'true',
      outcome.actual['terminalHost'] === '—' ? undefined : outcome.actual['terminalHost']
    ),
    outcome.actual['processExecution'] ?? '?',
    outcome.actual['presentationFulfillment'] ?? '?',
    outcome.actual['presentationSurface'] ?? '?',
    outcome.mismatches.length === 0 ? 'PASS' : 'FAIL',
  ]
})
const widths = headers.map((header, column) =>
  Math.max(header.length, ...tableRows.map((cells) => cells[column]?.length ?? 0))
)
const formatLine = (cells: string[]): string =>
  cells.map((cell, column) => padEnd(cell, widths[column] ?? cell.length)).join(' | ')

console.log('resolver capability matrix (expected 9 rows, independent fixture)')
console.log(formatLine(headers))
console.log(widths.map((width) => '-'.repeat(width)).join('-|-'))
for (const cells of tableRows) console.log(formatLine(cells))

if (failures.length > 0) {
  console.log('')
  for (const failure of failures) {
    const requested = failure.row.requested
    console.log(`MISMATCH ${failure.row.name}`)
    console.log(
      `  input:    harness=${requested?.harness ?? '(omitted)'} presentation=${
        requested?.presentation === undefined ? '(omitted)' : String(requested.presentation)
      } (provider/model omitted)`
    )
    for (const mismatch of failure.mismatches) console.log(`  ${mismatch}`)
  }
  console.log(
    `\n${outcomes.length - failures.length}/${outcomes.length} rows match; ${failures.length} mismatch(es)`
  )
  process.exit(1)
}

console.log(`\n${outcomes.length}/${outcomes.length} rows match`)
process.exit(0)
