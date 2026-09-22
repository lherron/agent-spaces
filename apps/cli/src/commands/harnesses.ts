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

import { catalogCapabilities } from 'agent-spaces'
import { type HarnessDetection, harnessRegistry } from 'spaces-execution'

import { DEFAULT_HARNESS_ID } from '../harness-validator.js'
import { exitWithAspError } from '../helpers.js'

/** Harness ids surfaced as "experimental" in the `harnesses` listing. */
const EXPERIMENTAL_HARNESS_IDS = new Set(['codex'])

interface HarnessInfo {
  id: string
  name: string
  detection: HarnessDetection
  modelProviders: Array<{
    id: string
    defaultModel: string
    supportedModels: string[]
  }>
  experimental?: boolean
}

interface HarnessesOutput {
  harnesses: HarnessInfo[]
  defaultHarness: string
}

/**
 * Format a single harness for text display.
 */
function formatModels(provider: HarnessInfo['modelProviders'][number]): string {
  return provider.supportedModels
    .map((model) => `${model}${model === provider.defaultModel ? chalk.cyan(' (default)') : ''}`)
    .join(', ')
}

function formatHarnessText(harness: HarnessInfo, isDefault: boolean): void {
  const defaultMarker = isDefault ? chalk.cyan(' (default)') : ''
  const experimentalMarker = harness.experimental ? chalk.yellow(' (experimental)') : ''
  const available = harness.detection.available

  if (available) {
    console.log(
      `  ${chalk.green(figures.tick)} ${chalk.bold(harness.id)}${defaultMarker}${experimentalMarker}`
    )
    console.log(`    Name: ${harness.name}`)
    if (harness.experimental) {
      console.log(`    Stability: ${chalk.yellow('Experimental')}`)
    }
    if (harness.detection.version) {
      console.log(`    Version: ${harness.detection.version}`)
    }
    if (harness.detection.path) {
      console.log(`    Path: ${chalk.gray(harness.detection.path)}`)
    }
    if (harness.detection.capabilities?.length) {
      console.log(`    Capabilities: ${harness.detection.capabilities.join(', ')}`)
    }
    for (const provider of harness.modelProviders) {
      console.log(`    Models (${provider.id}): ${formatModels(provider)}`)
    }
  } else {
    console.log(
      `  ${chalk.red(figures.cross)} ${chalk.bold(harness.id)}${defaultMarker}${experimentalMarker}`
    )
    console.log(`    Name: ${harness.name}`)
    console.log(`    Status: ${chalk.yellow('Not available')}`)
    if (harness.experimental) {
      console.log(`    Stability: ${chalk.yellow('Experimental')}`)
    }
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
        // The catalog owns the public list/default/model projection. The
        // registry contributes volatile binary detection and adapter display
        // names only; it is never used to discover selectable harnesses.
        const detections = await harnessRegistry.detectAvailable()
        const harnesses: HarnessInfo[] = catalogCapabilities().map((capability) => {
          const adapter = harnessRegistry.getOrThrow(capability.id)
          return {
            id: capability.id,
            name: adapter.name,
            detection: detections.get(capability.id) ?? {
              available: false,
              error: 'Detection not run',
            },
            modelProviders: capability.modelProviders,
            experimental: EXPERIMENTAL_HARNESS_IDS.has(capability.id),
          }
        })

        const output: HarnessesOutput = {
          harnesses,
          defaultHarness: DEFAULT_HARNESS_ID,
        }

        if (options.json) {
          console.log(JSON.stringify(output, null, 2))
        } else {
          formatHarnessesText(output)
        }
      } catch (error) {
        exitWithAspError(error, options)
      }
    })
}
