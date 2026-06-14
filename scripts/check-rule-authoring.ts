import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

type CliOptions = {
  root: string
}

type Violation = {
  ruleCode: string
  file: string
  line: number
  expected: string
  got: string
  fix: string
  why: string
  exception: string
  doNotSuppress: string
}

type LedgerRow = {
  check: string
  rule: string
  why: string
  bad: string
  good: string
  exception: string
  rung: string
  sunsetCondition: string
  line: number
}

const headerCells = ['check', 'rule', 'why', 'bad', 'good', 'exception', 'rung', 'sunset-condition']
const expectedHeader = `| ${headerCells.join(' | ')} |`
const validRungs = new Set(['ELIMINATE', 'GUARD', 'WARN', 'TRAIN', 'TACIT'])
const fillerSunsets = new Set([
  'none',
  'never',
  'n/a',
  'na',
  'n.a.',
  'not applicable',
  'empty',
  '-',
])

function parseArgs(argv: string[]): CliOptions {
  let root = process.cwd()

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--root requires a directory')
      }
      root = value
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return { root: resolve(root) }
}

function toViolation(input: Omit<Violation, 'doNotSuppress'>): Violation {
  return {
    ...input,
    doNotSuppress:
      'Do not suppress, silence, disable, or route around check-rule-authoring; fix the ledger or recipe.',
  }
}

function printViolations(violations: Violation[]): void {
  console.error('Rule authoring check failed: verify-gating checks must match checks/AUTHORING.md.')

  for (const violation of violations) {
    console.error('')
    console.error(`[${violation.ruleCode}] ${violation.file}:${violation.line}`)
    console.error(`  expected: ${violation.expected}; got: ${violation.got}.`)
    console.error(`  FIX → ${violation.fix}`)
    console.error(`  WHY → ${violation.why}`)
    console.error(`  EXCEPTION → ${violation.exception}`)
    console.error(`  ${violation.doNotSuppress}`)
  }
}

function isRecipeHeader(line: string, recipeName: string): boolean {
  return new RegExp(`^${recipeName}:\\s*(?:#.*)?$`).test(line)
}

function isNextRecipe(line: string): boolean {
  if (/^\s/.test(line) || line.trim() === '' || line.trimStart().startsWith('#')) {
    return false
  }
  return /^[A-Za-z0-9_-][A-Za-z0-9_-]*(?:\s+[^:=\n]+)?\s*:/.test(line)
}

function unsupportedRecipeLine(line: string): boolean {
  return /\{\{|\$\(|`|\\\s*$/.test(line)
}

function parseCheckRecipe(
  justfilePath: string,
  content: string
): {
  checks: Map<string, number>
  violations: Violation[]
} {
  const lines = content.split('\n')
  const headerIndex = lines.findIndex((line) => isRecipeHeader(line, 'check'))
  if (headerIndex === -1) {
    return {
      checks: new Map(),
      violations: [
        toViolation({
          ruleCode: 'RULE-AUTHORING-CHECK-RECIPE-MISSING',
          file: justfilePath,
          line: 1,
          expected: "a literal 'check:' recipe in justfile",
          got: 'no check recipe',
          fix: "add a literal 'check:' recipe listing each verify-gating bun scripts/check-*.ts command",
          why: 'the ledger scope is the live just check recipe, not a filesystem glob',
          exception:
            'extend scripts/check-rule-authoring.ts through reviewed parser support if the justfile recipe form changes',
        }),
      ],
    }
  }

  const checks = new Map<string, number>()
  const violations: Violation[] = []

  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const lineNumber = index + 1
    if (isNextRecipe(line)) {
      break
    }

    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue
    }

    if (unsupportedRecipeLine(line)) {
      violations.push(
        toViolation({
          ruleCode: 'RULE-AUTHORING-CHECK-RECIPE-PARSER-SUPPORT',
          file: justfilePath,
          line: lineNumber,
          expected: 'literal recipe lines such as bun scripts/check-name.ts',
          got: `unsupported dynamic or multiline recipe line '${trimmed}'`,
          fix: 'write each verify-gating check as a literal bun scripts/check-*.ts line, or extend this parser before changing the recipe form',
          why: 'falling back to glob discovery would govern non-verify scripts and tests by accident',
          exception: 'reviewed parser-support change in scripts/check-rule-authoring.ts',
        })
      )
      continue
    }

    const match = trimmed.match(/^@?bun\s+scripts\/(check-[A-Za-z0-9_.-]+\.ts)(?:\s+.*)?$/)
    if (match) {
      const basename = match[1]
      if (!checks.has(basename)) {
        checks.set(basename, lineNumber)
      }
      continue
    }

    if (/\bcheck-[A-Za-z0-9_.-]+\.ts\b/.test(trimmed)) {
      violations.push(
        toViolation({
          ruleCode: 'RULE-AUTHORING-CHECK-RECIPE-PARSER-SUPPORT',
          file: justfilePath,
          line: lineNumber,
          expected: 'literal bun scripts/check-*.ts invocation',
          got: `unparseable check invocation '${trimmed}'`,
          fix: 'write the check as bun scripts/check-name.ts or extend this parser through review',
          why: 'the checker must derive territory from the live recipe without silent glob fallback',
          exception: 'reviewed parser-support change in scripts/check-rule-authoring.ts',
        })
      )
    }
  }

  return { checks, violations }
}

function splitMarkdownRow(line: string): string[] {
  return line
    .trim()
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim())
}

function isSeparator(line: string): boolean {
  return /^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim())
}

function normalizeFiller(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '')
}

function parseLedger(
  ledgerPath: string,
  content: string
): {
  rows: LedgerRow[]
  violations: Violation[]
  headerLine: number
} {
  const lines = content.split('\n')
  const tableLineIndex = lines.findIndex((line) => line.trim().startsWith('|'))
  if (tableLineIndex === -1) {
    return {
      rows: [],
      headerLine: 1,
      violations: [
        toViolation({
          ruleCode: 'RULE-AUTHORING-HEADER',
          file: ledgerPath,
          line: 1,
          expected: expectedHeader,
          got: 'no markdown table header',
          fix: `add the exact header '${expectedHeader}' before ledger rows`,
          why: 'a stable schema keeps rule, rationale, examples, exceptions, rung, and sunset data reviewable',
          exception:
            'reviewed schema change in scripts/check-rule-authoring.ts and checks/AUTHORING.md',
        }),
      ],
    }
  }

  const headerLine = tableLineIndex + 1
  const actualHeader = lines[tableLineIndex]?.trim() ?? ''
  const violations: Violation[] = []
  const rows: LedgerRow[] = []

  if (actualHeader !== expectedHeader) {
    violations.push(
      toViolation({
        ruleCode: 'RULE-AUTHORING-HEADER',
        file: ledgerPath,
        line: headerLine,
        expected: expectedHeader,
        got: actualHeader || 'empty header',
        fix: `replace the ledger header with '${expectedHeader}' in this exact order`,
        why: 'the authoring ledger is a contract for rule ownership and sunset discipline',
        exception:
          'reviewed schema change in scripts/check-rule-authoring.ts and checks/AUTHORING.md',
      })
    )
    return { rows, violations, headerLine }
  }

  let rowStart = tableLineIndex + 1
  if (rowStart < lines.length && isSeparator(lines[rowStart] ?? '')) {
    rowStart += 1
  }

  for (let index = rowStart; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    if (trimmed === '') {
      continue
    }
    if (!trimmed.startsWith('|')) {
      break
    }

    const cells = splitMarkdownRow(line)
    const lineNumber = index + 1
    if (cells.length !== headerCells.length) {
      violations.push(
        toViolation({
          ruleCode: 'RULE-AUTHORING-ROW-SHAPE',
          file: ledgerPath,
          line: lineNumber,
          expected: `${headerCells.length} cells matching ${expectedHeader}`,
          got: `${cells.length} cells in '${trimmed}'`,
          fix: 'rewrite the row with exactly one cell for each ledger column',
          why: 'partial rows hide required rule-authoring metadata',
          exception:
            'reviewed schema change in scripts/check-rule-authoring.ts and checks/AUTHORING.md',
        })
      )
      continue
    }

    const [check, rule, why, bad, good, exception, rung, sunsetCondition] = cells
    rows.push({ check, rule, why, bad, good, exception, rung, sunsetCondition, line: lineNumber })
  }

  return { rows, violations, headerLine }
}

function validateRows(ledgerPath: string, rows: LedgerRow[]): Violation[] {
  const violations: Violation[] = []
  const seen = new Map<string, number>()

  for (const row of rows) {
    const requiredCells: Array<[keyof LedgerRow, string]> = [
      ['check', row.check],
      ['rule', row.rule],
      ['why', row.why],
      ['bad', row.bad],
      ['good', row.good],
      ['exception', row.exception],
      ['rung', row.rung],
      ['sunsetCondition', row.sunsetCondition],
    ]

    for (const [column, value] of requiredCells) {
      if (value.trim() === '') {
        violations.push(
          toViolation({
            ruleCode: 'RULE-AUTHORING-EMPTY-CELL',
            file: ledgerPath,
            line: row.line,
            expected: `non-empty ${column === 'sunsetCondition' ? 'sunset-condition' : column} cell`,
            got: 'empty required cell',
            fix: 'fill every ledger cell with terse, concrete authoring metadata',
            why: 'empty cells make the rule impossible to review or sunset',
            exception:
              'no empty-cell exception; document the metadata or remove the verify-gating check',
          })
        )
      }
    }

    const firstLine = seen.get(row.check)
    if (firstLine !== undefined) {
      violations.push(
        toViolation({
          ruleCode: 'RULE-AUTHORING-DUPLICATE-CHECK',
          file: ledgerPath,
          line: row.line,
          expected: `one ledger row for ${row.check}`,
          got: `duplicate check key first seen at ${ledgerPath}:${firstLine}`,
          fix: `merge or remove duplicate ${row.check} rows so the key is unique`,
          why: 'duplicate rows make the governed rule metadata ambiguous',
          exception: 'no duplicate-key exception; each verify-gating check has exactly one row',
        })
      )
    } else {
      seen.set(row.check, row.line)
    }

    if (row.rung.trim() !== '' && !validRungs.has(row.rung)) {
      violations.push(
        toViolation({
          ruleCode: 'RULE-AUTHORING-RUNG',
          file: ledgerPath,
          line: row.line,
          expected: 'rung to be one of ELIMINATE, GUARD, WARN, TRAIN, TACIT',
          got: row.rung,
          fix: 'set rung to a valid ladder value; current verify-gating rows use GUARD',
          why: 'the rung class records how the rule is enforced and reviewed',
          exception: 'reviewed schema change only if the enforcement ladder changes',
        })
      )
    }

    const normalizedSunset = normalizeFiller(row.sunsetCondition)
    if (row.sunsetCondition.trim() === '' || fillerSunsets.has(normalizedSunset)) {
      violations.push(
        toViolation({
          ruleCode: 'RULE-AUTHORING-SUNSET-CONDITION',
          file: ledgerPath,
          line: row.line,
          expected: 'actionable sunset-condition trigger',
          got:
            row.sunsetCondition.trim() === ''
              ? 'empty sunset-condition'
              : `filler '${row.sunsetCondition}'`,
          fix: 'write a concrete trigger that explains when this check can be removed or replaced',
          why: 'sunset conditions prevent checks from becoming permanent folklore',
          exception: 'no filler sunset exception; define the trigger before adding the check',
        })
      )
    }
  }

  return violations
}

function validateRecipeParity(
  ledgerPath: string,
  recipeChecks: Map<string, number>,
  rows: LedgerRow[],
  headerLine: number
): Violation[] {
  const violations: Violation[] = []
  const rowByCheck = new Map<string, LedgerRow>()

  for (const row of rows) {
    if (!rowByCheck.has(row.check)) {
      rowByCheck.set(row.check, row)
    }
  }

  for (const check of [...recipeChecks.keys()].sort((left, right) => left.localeCompare(right))) {
    if (!rowByCheck.has(check)) {
      violations.push(
        toViolation({
          ruleCode: 'RULE-AUTHORING-MISSING-ROW',
          file: ledgerPath,
          line: headerLine,
          expected: `AUTHORING.md ledger row for ${check}`,
          got: `no ledger row for ${check}`,
          fix: `add a ${check} row with rule, why, bad, good, exception, rung, and sunset-condition cells`,
          why: 'every verify-gating check must carry authoring and sunset metadata before it runs in just check',
          exception:
            'no self-exemption or uncataloged-check exception; catalog the check before wiring it',
        })
      )
    }
  }

  for (const row of rows) {
    if (row.check.trim() === '' || recipeChecks.has(row.check)) {
      continue
    }

    violations.push(
      toViolation({
        ruleCode: 'RULE-AUTHORING-STALE-ROW',
        file: ledgerPath,
        line: row.line,
        expected: `${row.check} to be present as bun scripts/${row.check} in the justfile check: recipe`,
        got: 'stale ledger row absent from the check: recipe',
        fix: `remove the stale ${row.check} row or wire bun scripts/${row.check} into the check: recipe`,
        why: 'the ledger must describe exactly the verify-gating checks, not historical or non-verify scripts',
        exception: 'reviewed parser-support change only if check recipe discovery changes',
      })
    )
  }

  return violations
}

async function main(): Promise<number> {
  let options: CliOptions
  try {
    options = parseArgs(Bun.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }

  const justfilePath = 'justfile'
  const ledgerPath = 'checks/AUTHORING.md'
  const violations: Violation[] = []

  let justfileContent: string
  try {
    justfileContent = await readFile(join(options.root, justfilePath), 'utf8')
  } catch (error) {
    violations.push(
      toViolation({
        ruleCode: 'RULE-AUTHORING-JUSTFILE-READ',
        file: justfilePath,
        line: 1,
        expected: 'readable justfile at the selected root',
        got: error instanceof Error ? error.message : String(error),
        fix: 'run from the repo root or pass --root pointing at a fixture/repo with justfile',
        why: 'the live justfile check recipe defines the governed check territory',
        exception: 'no read exception; provide the correct root',
      })
    )
    printViolations(violations)
    return 1
  }

  const recipe = parseCheckRecipe(justfilePath, justfileContent)
  violations.push(...recipe.violations)

  let ledgerContent: string
  try {
    ledgerContent = await readFile(join(options.root, ledgerPath), 'utf8')
  } catch (error) {
    violations.push(
      toViolation({
        ruleCode: 'RULE-AUTHORING-LEDGER-READ',
        file: ledgerPath,
        line: 1,
        expected: 'readable checks/AUTHORING.md ledger',
        got: error instanceof Error ? error.message : String(error),
        fix: `create checks/AUTHORING.md with header '${expectedHeader}' and one row per just check script`,
        why: 'verify-gating checks need visible authoring metadata and sunset conditions',
        exception: 'no missing-ledger exception; create the ledger before adding checks',
      })
    )
    printViolations(violations)
    return 1
  }

  const ledger = parseLedger(ledgerPath, ledgerContent)
  violations.push(...ledger.violations)
  violations.push(...validateRows(ledgerPath, ledger.rows))
  violations.push(
    ...validateRecipeParity(ledgerPath, recipe.checks, ledger.rows, ledger.headerLine)
  )

  if (violations.length > 0) {
    printViolations(violations)
    return 1
  }

  console.log(`Rule authoring check passed (${recipe.checks.size} verify-gating checks cataloged).`)
  return 0
}

process.exit(await main())
