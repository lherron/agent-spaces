/**
 * Terminal display formatting for computed prompts.
 *
 * Renders system prompt, session reminder, and priming prompt
 * in visually distinct framed sections using box-drawing characters.
 */

import chalk from 'chalk'

import { paginate } from 'spaces-execution'

const FRAME_WIDTH = 72

interface PromptSection {
  title: string
  content: string
  color: (text: string) => string
  sectionSizes?: string[] | undefined
}

interface PromptBudget {
  promptChars: number
  reminderChars: number
  totalChars: number
  maxChars?: number | undefined
  nearMaxChars?: boolean | undefined
}

/**
 * Render a single framed prompt section to lines.
 */
function renderSection(section: PromptSection): string[] {
  const { title, content, color, sectionSizes } = section
  const chars = content.length
  const lines: string[] = []

  // Top border: ┌─ Title ───────────────────────
  const titleSegment = `─ ${title} `
  const remainingWidth = Math.max(0, FRAME_WIDTH - titleSegment.length - 1)
  const topRule = '─'.repeat(remainingWidth)
  lines.push(color(`┌${titleSegment}`) + chalk.dim(topRule))

  // Content with left border
  lines.push(chalk.dim('│'))
  for (const line of content.split('\n')) {
    lines.push(chalk.dim('│  ') + line)
  }
  lines.push(chalk.dim('│'))

  // Bottom border with metadata: └──────────── 2,340 chars · 3 sections
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

/**
 * Render the budget summary lines.
 */
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
}

/**
 * Display computed prompts in a visually structured format.
 *
 * Used by both normal run and dry-run modes.
 */
export async function displayPrompts(opts: DisplayPromptOptions): Promise<void> {
  const hasPrompt = !!opts.systemPrompt
  const hasReminder = !!opts.reminderContent
  const hasPriming = !!opts.primingPrompt

  if (!hasPrompt && !hasReminder && !hasPriming) {
    return
  }

  const allLines: string[] = []
  const summary: string[] = []

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

  // Final summary line
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

  if (opts.showCommand && opts.command) {
    allLines.push('')
    allLines.push(chalk.cyan('Command:'))
    allLines.push(opts.command)
  }

  if (opts.pagePrompts) {
    await paginate(allLines)
  } else {
    for (const line of allLines) {
      console.log(line)
    }
  }
}

/**
 * Display the harness command being executed (for normal run mode).
 */
export function displayCommand(command: string): void {
  console.log(chalk.dim(`$ ${command}`))
  console.log('')
}
