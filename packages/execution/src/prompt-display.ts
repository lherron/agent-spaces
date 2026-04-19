/**
 * Terminal display formatting for harness invocations.
 *
 * Renders system prompt, session reminder, and priming prompt in framed
 * sections, plus a shell-shaped command line with long prompt values
 * elided to `<N chars>`. Shared by `asp run` and `hrc launch exec` so
 * both produce the same output.
 */

import chalk from 'chalk'

import { paginate } from './pager.js'

const FRAME_WIDTH = 72
const PROMPT_FLAGS = new Set(['--system-prompt', '--append-system-prompt'])
const LONG_ARG_THRESHOLD = 200

export interface PromptSection {
  title: string
  content: string
  color: (text: string) => string
  sectionSizes?: string[] | undefined
}

export interface PromptBudget {
  promptChars: number
  reminderChars: number
  totalChars: number
  maxChars?: number | undefined
  nearMaxChars?: boolean | undefined
}

/**
 * Render a single framed prompt section to lines.
 */
export function renderSection(section: PromptSection): string[] {
  const { title, content, color, sectionSizes } = section
  const chars = content.length
  const lines: string[] = []

  const titleSegment = `─ ${title} `
  const remainingWidth = Math.max(0, FRAME_WIDTH - titleSegment.length - 1)
  const topRule = '─'.repeat(remainingWidth)
  lines.push(color(`┌${titleSegment}`) + chalk.dim(topRule))

  lines.push(chalk.dim('│'))
  for (const line of content.split('\n')) {
    lines.push(chalk.dim('│  ') + line)
  }
  lines.push(chalk.dim('│'))

  const meta: string[] = [`${chars.toLocaleString()} chars`]
  if (sectionSizes && sectionSizes.length > 0) {
    meta.push(sectionSizes.join(', '))
  }
  const metaStr = meta.join(' · ')
  const metaSegment = ` ${metaStr}`
  const bottomWidth = Math.max(0, FRAME_WIDTH - metaSegment.length - 1)
  const bottomRule = '─'.repeat(bottomWidth)
  lines.push(chalk.dim(`└${bottomRule}`) + chalk.dim(metaSegment))

  return lines
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Format command for display, replacing long prompt values with
 * `'<N chars>'` placeholders so the line stays readable.
 */
export function formatDisplayCommand(commandPath: string, args: string[]): string {
  const parts: string[] = [shellQuote(commandPath)]
  let pastSeparator = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) {
      continue
    }
    if (arg === '--') {
      pastSeparator = true
      parts.push(arg)
      continue
    }
    if (PROMPT_FLAGS.has(arg) && i + 1 < args.length) {
      const value = args[i + 1]
      if (value === undefined) {
        continue
      }
      parts.push(shellQuote(arg))
      parts.push(`'<${value.length.toLocaleString()} chars>'`)
      i++
    } else if (pastSeparator && arg.length > LONG_ARG_THRESHOLD) {
      parts.push(`'<${arg.length.toLocaleString()} chars>'`)
    } else {
      parts.push(shellQuote(arg))
    }
  }
  return parts.join(' ')
}

/**
 * Render a key-value section (e.g. env vars, launch metadata).
 */
export function renderKeyValueSection(
  title: string,
  entries: Array<[string, string]>,
  color: (text: string) => string = chalk.cyan
): string[] {
  if (entries.length === 0) {
    return []
  }
  const lines: string[] = []
  lines.push(color(`── ${title} ──`))
  const keyWidth = Math.max(...entries.map(([k]) => k.length))
  for (const [k, v] of entries) {
    lines.push(chalk.dim(`  ${k.padEnd(keyWidth)}  `) + v)
  }
  return lines
}

function renderBudget(budget: PromptBudget): string[] {
  const lines: string[] = ['']
  if (budget.maxChars !== undefined) {
    const pct = Math.round((budget.totalChars / budget.maxChars) * 100)
    lines.push(
      chalk.dim(
        `  Budget: ${budget.totalChars.toLocaleString()}/${budget.maxChars.toLocaleString()} chars (${pct}%)`
      )
    )
    if (budget.nearMaxChars) {
      lines.push(chalk.yellow('  ⚠ Approaching max_chars budget'))
    }
  } else {
    const parts = [
      `prompt: ${budget.promptChars.toLocaleString()}`,
      `reminder: ${budget.reminderChars.toLocaleString()}`,
    ]
    lines.push(
      chalk.dim(
        `  Total context: ${budget.totalChars.toLocaleString()} chars (${parts.join(', ')})`
      )
    )
  }
  return lines
}

export interface DisplayPromptOptions {
  systemPrompt?: string | undefined
  systemPromptMode?: 'replace' | 'append' | undefined
  reminderContent?: string | undefined
  primingPrompt?: string | undefined
  promptSectionSizes?: string[] | undefined
  reminderSectionSizes?: string[] | undefined
  totalContextChars?: number | undefined
  maxChars?: number | undefined
  nearMaxChars?: boolean | undefined
  command?: string | undefined
  /** When true, show the harness command at the end */
  showCommand?: boolean | undefined
  /** Page output one screenful at a time */
  pagePrompts?: boolean | undefined
  /** Optional header lines printed before the prompt sections (e.g. launch metadata) */
  headerLines?: string[] | undefined
  /** Optional lines printed between prompts and command (e.g. env vars, agentchat) */
  betweenLines?: string[] | undefined
}

/**
 * Display computed prompts in a visually structured format.
 *
 * Layout:
 *   headerLines     (optional — caller supplies, e.g. launch IDs)
 *   System Prompt   (framed, full content)
 *   Session Reminder (framed, full content)
 *   Priming Prompt  (framed, full content)
 *   Total summary   (chars breakdown)
 *   betweenLines    (optional — caller supplies, e.g. env / agentchat)
 *   Command:        (with `<N chars>` placeholders for long prompt args)
 */
export async function displayPrompts(opts: DisplayPromptOptions): Promise<void> {
  const hasPrompt = !!opts.systemPrompt
  const hasReminder = !!opts.reminderContent
  const hasPriming = !!opts.primingPrompt
  const hasCommand = !!(opts.showCommand && opts.command)
  const hasHeader = !!(opts.headerLines && opts.headerLines.length > 0)
  const hasBetween = !!(opts.betweenLines && opts.betweenLines.length > 0)

  if (!hasPrompt && !hasReminder && !hasPriming && !hasCommand && !hasHeader && !hasBetween) {
    return
  }

  const allLines: string[] = []
  const summary: string[] = []

  if (hasHeader) {
    allLines.push(...(opts.headerLines ?? []))
  }

  if (hasPrompt) {
    allLines.push('')
    allLines.push(
      ...renderSection({
        title:
          opts.systemPromptMode === 'append' ? 'System Prompt (append)' : 'System Prompt (replace)',
        content: opts.systemPrompt ?? '',
        color: chalk.cyan,
        sectionSizes: opts.promptSectionSizes,
      })
    )
    summary.push(`system: ${opts.systemPrompt?.length.toLocaleString()}`)
  }

  if (hasReminder) {
    allLines.push('')
    allLines.push(
      ...renderSection({
        title: 'Session Reminder',
        content: opts.reminderContent ?? '',
        color: chalk.yellow,
        sectionSizes: opts.reminderSectionSizes,
      })
    )
    summary.push(`reminder: ${opts.reminderContent?.length.toLocaleString()}`)
  }

  if (hasPrompt || hasReminder) {
    const promptChars = opts.systemPrompt?.length ?? 0
    const reminderChars = opts.reminderContent?.length ?? 0
    const totalChars = opts.totalContextChars ?? promptChars + reminderChars
    allLines.push(
      ...renderBudget({
        promptChars,
        reminderChars,
        totalChars,
        maxChars: opts.maxChars,
        nearMaxChars: opts.nearMaxChars,
      })
    )
  }

  if (hasPriming) {
    allLines.push('')
    allLines.push(
      ...renderSection({
        title: 'Priming Prompt',
        content: opts.primingPrompt ?? '',
        color: chalk.green,
      })
    )
    summary.push(`priming: ${opts.primingPrompt?.length.toLocaleString()}`)
  }

  if (summary.length > 0) {
    const totalChars =
      (opts.systemPrompt?.length ?? 0) +
      (opts.reminderContent?.length ?? 0) +
      (opts.primingPrompt?.length ?? 0)
    allLines.push('')
    allLines.push(
      chalk.dim(`  Total: ${totalChars.toLocaleString()} chars (${summary.join(', ')})`)
    )
  }

  if (hasBetween) {
    allLines.push('')
    allLines.push(...(opts.betweenLines ?? []))
  }

  if (hasCommand) {
    allLines.push('')
    allLines.push(chalk.cyan('── command ──'))
    allLines.push(opts.command ?? '')
  }

  if (opts.pagePrompts) {
    await paginate(allLines)
  } else {
    // Use process.stdout.write directly so callers that intercept
    // stdout (e.g. test harnesses patching process.stdout.write) see
    // the output. console.log keeps its own stream reference and
    // bypasses such patches.
    for (const line of allLines) {
      process.stdout.write(`${line}\n`)
    }
  }
}

/**
 * Display the harness command being executed (for normal run mode).
 */
export function displayCommand(command: string): void {
  process.stdout.write(`${chalk.dim(`$ ${command}`)}\n\n`)
}
