/**
 * Terminal UI utilities for asp CLI.
 *
 * Design: Refined industrial aesthetic
 * - Clean lines, purposeful spacing
 * - Unicode symbols for visual hierarchy
 * - Sparse, meaningful color
 */

import chalk from 'chalk'
import figures from 'figures'
import ora, { type Ora } from 'ora'

// ═══════════════════════════════════════════════════════════════════════════
// Color Palette - Muted, purposeful colors
// ═══════════════════════════════════════════════════════════════════════════

export const colors = {
  // Primary actions and success
  success: chalk.hex('#10b981'), // emerald
  // Informational, neutral
  info: chalk.hex('#6366f1'), // indigo
  // Warnings
  warn: chalk.hex('#f59e0b'), // amber
  // Errors
  error: chalk.hex('#ef4444'), // red
  // Muted/secondary text
  muted: chalk.hex('#6b7280'), // gray-500
  // Emphasized text
  emphasis: chalk.hex('#f3f4f6'), // gray-100
  // Accent for commands/code
  code: chalk.hex('#a78bfa'), // violet-400
  // Dim for less important info
  dim: chalk.hex('#4b5563'), // gray-600
}

// ═══════════════════════════════════════════════════════════════════════════
// Symbols - Consistent iconography
// ═══════════════════════════════════════════════════════════════════════════

export const symbols = {
  success: colors.success(figures.tick),
  error: colors.error(figures.cross),
  warning: colors.warn(figures.warning),
  info: colors.info(figures.info),
  pointer: colors.muted(figures.pointer),
  bullet: colors.muted(figures.bullet),
  arrow: colors.muted('→'),
  line: colors.dim('│'),
  corner: colors.dim('└'),
  tee: colors.dim('├'),
  dash: colors.dim('─'),
}

// ═══════════════════════════════════════════════════════════════════════════
// Spinner - Progress indication
// ═══════════════════════════════════════════════════════════════════════════

export function createSpinner(text: string): Ora {
  return ora({
    text: colors.muted(text),
    spinner: 'dots',
    color: 'gray',
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// Layout Components
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Print a section header
 */
export function header(text: string): void {
  console.log()
  console.log(colors.emphasis(text))
}

/**
 * Print a success message with checkmark
 */
export function success(text: string): void {
  console.log(`${symbols.success} ${text}`)
}

/**
 * Print an error message
 */
export function error(text: string): void {
  console.log(`${symbols.error} ${colors.error(text)}`)
}

/**
 * Print a warning message
 */
export function warning(text: string): void {
  console.log(`${symbols.warning} ${colors.warn(text)}`)
}

/**
 * Print an info line
 */
export function info(label: string, value: string): void {
  console.log(`  ${colors.muted(label)} ${value}`)
}

/**
 * Print a tree item (for hierarchical display)
 */
export function treeItem(text: string, isLast = false): void {
  const prefix = isLast ? symbols.corner : symbols.tee
  console.log(`  ${prefix}${symbols.dash} ${text}`)
}

/**
 * Print a command block - copyable with shell continuation syntax
 */
export function commandBlock(label: string, command: string): void {
  // Shorten paths in the command for display
  const shortCommand = formatPath(command)
  const lines = wrapCommandWithContinuation(shortCommand, 76)

  console.log()
  console.log(`  ${colors.muted(`${label}:`)}`)

  for (const line of lines) {
    console.log(`    ${colors.code(line)}`)
  }
}

/**
 * Print a target block with all its info
 */
export function targetBlock(
  name: string,
  pluginCount: number,
  hasMcp: boolean,
  command: string
): void {
  console.log()
  console.log(`  ${colors.emphasis(name)}`)
  console.log(`  ${colors.dim('─'.repeat(name.length))}`)

  // Stats line
  const stats: string[] = []
  stats.push(`${pluginCount} plugin${pluginCount !== 1 ? 's' : ''}`)
  if (hasMcp) {
    stats.push('mcp')
  }
  console.log(`  ${colors.muted(stats.join(' · '))}`)

  // Command
  commandBlock('run with', command)
}

/**
 * Print a summary block at the end
 */
export function summaryBlock(items: { label: string; value: string }[]): void {
  console.log()
  console.log(colors.dim('  ─'.repeat(40)))
  console.log()

  for (const item of items) {
    console.log(`  ${colors.muted(item.label.padEnd(12))} ${item.value}`)
  }
}

/**
 * Print blank line
 */
export function blank(): void {
  console.log()
}

// ═══════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wrap a command with shell continuation backslashes for copy-paste
 */
function wrapCommandWithContinuation(command: string, maxWidth: number): string[] {
  if (command.length <= maxWidth) {
    return [command]
  }

  const lines: string[] = []

  // Split command into logical segments (binary + flag-value pairs)
  const segments: string[] = []
  const flagPattern = /\s+(--\S+)(\s+(?:'[^']*'|"[^"]*"|\S+))?/g
  let match: RegExpExecArray | null

  // First segment is the binary
  const firstSpace = command.indexOf(' ')
  if (firstSpace > 0) {
    segments.push(command.slice(0, firstSpace))
  }

  // Extract flag-value pairs
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((match = flagPattern.exec(command)) !== null) {
    segments.push(match[0].trim())
  }

  // Build lines with continuation backslashes
  // Account for " \" at end of line (3 chars) when checking width
  const effectiveWidth = maxWidth - 3
  let current = ''

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? ''
    const isFirst = i === 0
    const isLast = i === segments.length - 1

    if (isFirst) {
      current = segment
    } else if (`${current} ${segment}`.length > effectiveWidth) {
      // Line would exceed width, push current with continuation
      lines.push(`${current} \\`)
      current = `  ${segment}` // indent continuation lines
    } else {
      current += ` ${segment}`
    }

    // If this is the last segment, push without continuation
    if (isLast && current) {
      lines.push(current)
    }
  }

  // Handle edge case where loop didn't push final line
  if (lines.length === 0 && current) {
    lines.push(current)
  }

  return lines.length > 0 ? lines : [command]
}

/**
 * Format a file path for display (shorten home dir)
 */
export function formatPath(filePath: string): string {
  const home = process.env['HOME'] ?? ''
  if (home) {
    // Replace all occurrences of home dir with ~
    return filePath.replaceAll(home, '~')
  }
  return filePath
}

/**
 * Format duration in ms to human readable
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`
  }
  return `${(ms / 1000).toFixed(1)}s`
}
