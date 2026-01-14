/**
 * Harnesses command - List available harnesses and their status.
 *
 * WHY: Provides visibility into which coding agent harnesses (Claude, Pi, etc.)
 * are available on the system and their capabilities. This helps users understand
 * what harnesses can be used with the --harness flag.
 */

import chalk from 'chalk'
import type { Command } from 'commander'
import figures from 'figures'

import { type HarnessDetection, harnessRegistry } from 'spaces-engine'

interface HarnessInfo {
  id: string
  name: string
  detection: HarnessDetection
}

interface HarnessesOutput {
  harnesses: HarnessInfo[]
  defaultHarness: string
}

/**
 * Format a single harness for text display.
 */
function formatHarnessText(harness: HarnessInfo, isDefault: boolean): void {
  const defaultMarker = isDefault ? chalk.cyan(' (default)') : ''
  const available = harness.detection.available

  if (available) {
    console.log(`  ${chalk.green(figures.tick)} ${chalk.bold(harness.id)}${defaultMarker}`)
    console.log(`    Name: ${harness.name}`)
    if (harness.detection.version) {
      console.log(`    Version: ${harness.detection.version}`)
    }
    if (harness.detection.path) {
      console.log(`    Path: ${chalk.gray(harness.detection.path)}`)
    }
    if (harness.detection.capabilities?.length) {
      console.log(`    Capabilities: ${harness.detection.capabilities.join(', ')}`)
    }
  } else {
    console.log(`  ${chalk.red(figures.cross)} ${chalk.bold(harness.id)}${defaultMarker}`)
    console.log(`    Name: ${harness.name}`)
    console.log(`    Status: ${chalk.yellow('Not available')}`)
    if (harness.detection.error) {
      console.log(`    Reason: ${chalk.gray(harness.detection.error)}`)
    }
  }
  console.log('')
}

/**
 * Format harnesses output as text.
 */
function formatHarnessesText(output: HarnessesOutput): void {
  console.log(chalk.blue('Available Harnesses:'))
  console.log('')

  const availableCount = output.harnesses.filter((h) => h.detection.available).length
  const totalCount = output.harnesses.length

  for (const harness of output.harnesses) {
    formatHarnessText(harness, harness.id === output.defaultHarness)
  }

  console.log(chalk.blue('Summary:'))
  console.log(`  ${availableCount}/${totalCount} harnesses available`)
  console.log(`  Default: ${output.defaultHarness}`)
}

/**
 * Register the harnesses command.
 */
export function registerHarnessesCommand(program: Command): void {
  program
    .command('harnesses')
    .description('List available harnesses and their status')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        // Detect all harnesses
        const detections = await harnessRegistry.detectAvailable()
        const adapters = harnessRegistry.getAll()

        const harnesses: HarnessInfo[] = adapters.map((adapter) => ({
          id: adapter.id,
          name: adapter.name,
          detection: detections.get(adapter.id) ?? {
            available: false,
            error: 'Detection not run',
          },
        }))

        const output: HarnessesOutput = {
          harnesses,
          defaultHarness: 'claude',
        }

        if (options.json) {
          console.log(JSON.stringify(output, null, 2))
        } else {
          formatHarnessesText(output)
        }
      } catch (error) {
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`))
        process.exit(1)
      }
    })
}
