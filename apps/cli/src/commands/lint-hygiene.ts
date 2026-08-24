/**
 * Hygiene lint sub-command handlers for `asp lint`.
 *
 * `--hygiene [path]` runs the tier-1 W4xx deterministic rules over a target (a
 * skill, a prompt file, an agent root, or a var/agents tree), with baseline
 * suppression and a `--strict` nonzero exit on `error`-severity findings.
 *
 * `--judge <path>` runs the tier-2 rubric judge over one unit and prints the §7
 * JSON scorecard. The agent turn is executed by shelling out to the installed
 * agent-loop SDK (a generated script in the agent-loop home, which is where
 * `@praesidium/agent-loop` resolves) — spaces-config carries no cross-repo dep.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import chalk from 'chalk'
import { hygiene } from 'spaces-config'
import type { LintWarning } from 'spaces-config'

/** Options carried on the lint command for hygiene mode. */
export interface HygieneCliOptions {
  hygiene?: string | boolean | undefined
  judge?: string | undefined
  strict?: boolean | undefined
  baseline?: string | undefined
  updateBaseline?: boolean | undefined
  agentHygieneRoot?: string | undefined
  json?: boolean | undefined
}

const SEVERITY_COLOR: Record<string, (t: string) => string> = {
  error: chalk.red,
  warning: chalk.yellow,
  info: chalk.blue,
}

function printWarnings(warnings: LintWarning[]): void {
  const counts: Record<string, number> = { error: 0, warning: 0, info: 0 }
  for (const w of warnings) {
    counts[w.severity] = (counts[w.severity] ?? 0) + 1
  }
  const summary = `${counts['error'] ?? 0} error, ${counts['warning'] ?? 0} warning, ${counts['info'] ?? 0} info`
  if (warnings.length === 0) {
    console.log(chalk.green('No hygiene findings'))
    return
  }
  console.log(chalk.bold(`Hygiene findings (${summary}):\n`))
  for (const w of warnings) {
    const color = SEVERITY_COLOR[w.severity] ?? chalk.white
    console.log(color(`[${w.code}] ${w.severity}`))
    console.log(`  ${w.message}`)
    if (w.path) {
      console.log(chalk.dim(`  ${w.path}`))
    }
    console.log('')
  }
}

/** `asp lint --hygiene [path]` handler. Returns the process exit code. */
export async function runHygieneCommand(
  targetArg: string | undefined,
  options: HygieneCliOptions
): Promise<number> {
  const target = resolve(targetArg ?? process.cwd())
  const baselineRoot = target

  // When updating the baseline we capture ALL findings (pre-suppression).
  if (options.updateBaseline) {
    const baselinePath = options.baseline ?? join(target, '.hygiene-baseline.json')
    const { context } = await hygiene.runHygieneTarget(target)
    const all = await hygiene.lintHygiene(context)
    const count = await hygiene.writeBaseline(baselinePath, all, baselineRoot)
    console.log(
      chalk.green(`Wrote ${count} baseline entr${count === 1 ? 'y' : 'ies'} to ${baselinePath}`)
    )
    return 0
  }

  const runOpts: hygiene.HygieneRunOptions = { baselineRoot }
  if (options.baseline) {
    runOpts.baselinePath = resolve(options.baseline)
  }
  const result = await hygiene.runHygieneTarget(target, runOpts)

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          target,
          units: result.context.units.length,
          agents: result.context.agentRoots.length,
          suppressed: result.suppressed.length,
          warnings: result.warnings,
        },
        null,
        2
      )
    )
  } else {
    console.log(
      chalk.dim(
        `Scanned ${result.context.units.length} unit(s) across ${result.context.agentRoots.length} agent root(s); ${result.suppressed.length} suppressed by baseline.\n`
      )
    )
    printWarnings(result.warnings)
  }

  if (options.strict && hygiene.hasStrictFailure(result.warnings)) {
    console.error(chalk.red('\n--strict: error-severity hygiene findings present.'))
    return 1
  }
  return 0
}

const AGENT_LOOP_HOME =
  process.env['ASP_AGENT_LOOP_HOME'] ?? join(process.env['HOME'] ?? '', 'praesidium/agent-loop')
// The judge runs from the agent-loop home (where @praesidium/agent-loop resolves),
// so the scope's project must resolve from that cwd — use `agent-loop`.
const JUDGE_SCOPE = process.env['ASP_HYGIENE_JUDGE_SCOPE'] ?? 'clod@agent-loop:hygiene-judge/worker'

const JUDGE_SCRIPT = `import { agent, scope } from '@praesidium/agent-loop'
const [promptFile, schemaFile, outFile, scopeRef] = process.argv.slice(2)
const prompt = await Bun.file(promptFile).text()
const schema = await Bun.file(schemaFile).json()
const res = await agent(scope(scopeRef), prompt, {
  output: 'json',
  schema,
  permissions: { mode: 'deny' },
  timeoutMs: 600_000,
})
await Bun.write(outFile, JSON.stringify(res.data))
`

/** Execute one judge turn via the installed agent-loop SDK. Returns parsed JSON. */
async function runJudgeViaSdk(prompt: hygiene.JudgePrompt): Promise<unknown> {
  const work = await mkdtemp(join(tmpdir(), 'asp-judge-'))
  // The runner script must live where @praesidium/agent-loop resolves.
  const scriptPath = join(AGENT_LOOP_HOME, `.asp-judge-${process.pid}.ts`)
  const promptFile = join(work, 'prompt.txt')
  const schemaFile = join(work, 'schema.json')
  const outFile = join(work, 'out.json')
  try {
    await writeFile(scriptPath, JUDGE_SCRIPT)
    await writeFile(promptFile, `${prompt.system}\n\n${prompt.user}`)
    await writeFile(schemaFile, JSON.stringify(hygiene.RUBRIC_SCORECARD_SCHEMA))

    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn('bun', [scriptPath, promptFile, schemaFile, outFile, JUDGE_SCOPE], {
        cwd: AGENT_LOOP_HOME,
        stdio: ['ignore', 'inherit', 'inherit'],
      })
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) {
          resolvePromise()
        } else {
          reject(new Error(`judge runner exited with code ${code}`))
        }
      })
    })

    const { readFile } = await import('node:fs/promises')
    return JSON.parse(await readFile(outFile, 'utf-8'))
  } finally {
    await rm(scriptPath, { force: true })
    await rm(work, { recursive: true, force: true })
  }
}

/** `asp lint --judge <path>` handler. Returns the process exit code. */
export async function runJudgeCommand(target: string, options: HygieneCliOptions): Promise<number> {
  const resolved = resolve(target)
  const context = await hygiene.scanHygieneTarget(resolved)
  if (context.units.length === 0) {
    console.error(chalk.red(`No hygiene unit found at ${resolved}`))
    return 1
  }
  if (context.units.length > 1) {
    console.error(
      chalk.red(
        `--judge assesses ONE unit; ${resolved} resolves to ${context.units.length} units. Point it at a single skill dir or prompt file.`
      )
    )
    return 1
  }
  const unit = context.units[0]
  if (!unit) {
    return 1
  }

  // Embed tier-1 mechanical results for this unit so the judge does not re-derive them.
  const tier1 = await hygiene.lintHygiene({ units: [unit], agentRoots: context.agentRoots })

  console.error(
    chalk.dim(`Judging ${unit.kind} ${unit.key} (embedding ${tier1.length} tier-1 findings)...`)
  )

  const judgeOpts: hygiene.JudgeOptions = { runner: (p) => runJudgeViaSdk(p) }
  if (options.agentHygieneRoot) {
    judgeOpts.agentHygieneRoot = resolve(options.agentHygieneRoot)
  }
  try {
    const scorecard = await hygiene.judgeUnit(unit, tier1, judgeOpts)
    console.log(JSON.stringify(scorecard, null, 2))
    return 0
  } catch (err) {
    console.error(chalk.red(`Judge failed: ${err instanceof Error ? err.message : String(err)}`))
    return 1
  }
}
