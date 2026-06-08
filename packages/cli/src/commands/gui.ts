/**
 * GUI command - Launch Codex.app with an ASP-prepared Codex runtime home.
 *
 * This intentionally delegates target resolution and materialization to the
 * same run() entry point as `asp run`; only the final launch surface changes.
 */

import { createCompileRuntimeFn } from 'agent-spaces'
import chalk from 'chalk'
import type { Command } from 'commander'

import { type RunResult, run } from 'spaces-execution'

import { exitWithAspError } from '../helpers.js'
import { findProjectRoot } from '../lib.js'
import { displayPrompts } from '../prompt-display.js'
import { resolveRunTarget } from '../scope-target-resolver.js'
import { buildSettingSources } from '../settings-helper.js'

interface GuiOptions {
  project?: string
  aspHome?: string
  registry?: string
  dryRun?: boolean
  printCommand?: boolean
  refresh?: boolean
  inheritAll?: boolean
  inheritProject?: boolean
  inheritUser?: boolean
  inheritLocal?: boolean
  settings?: string
  pagePrompts?: boolean
}

async function runGui(agentId: string, options: GuiOptions): Promise<RunResult> {
  const projectPath = options.project ?? (await findProjectRoot()) ?? process.cwd()
  const target = resolveRunTarget(agentId)

  if (options.dryRun && !options.printCommand) {
    console.log(chalk.yellow('Dry run - building and showing Codex.app launch command...'))
  } else if (!options.dryRun) {
    console.log(chalk.blue(`Launching Codex.app for "${target.displayTarget}"...`))
    console.log('')
  }

  return run(target.targetName, {
    aspHome: options.aspHome,
    registryPath: options.registry,
    refresh: options.refresh,
    dryRun: options.dryRun,
    harness: 'codex',
    interactive: true,
    launchSurface: 'codex-app',
    projectPath,
    projectId: target.projectId,
    taskId: target.taskId,
    settingSources: buildSettingSources(options),
    settings: options.settings,
    inheritProject: options.inheritProject,
    inheritUser: options.inheritUser,
    pagePrompts: options.pagePrompts,
    compileRuntime: createCompileRuntimeFn(options.aspHome),
  })
}

export function registerGuiCommand(program: Command): void {
  program
    .command('gui')
    .description('Launch Codex.app for an ASP agent target')
    .argument('<agentId>', 'Agent/target name, or a scope handle such as cody@project:task')
    .option('--dry-run', 'Print the Codex.app launch command without executing')
    .option('--print-command', 'Output only the command (for piping/scripting)')
    .option('--no-refresh', 'Skip refresh and use cached project bundles')
    .option('--inherit-all', 'Inherit all harness settings (user, project, local)')
    .option('--inherit-project', 'Inherit project-level settings')
    .option('--inherit-user', 'Inherit user-level settings')
    .option('--inherit-local', 'Inherit local settings')
    .option('--settings <file-or-json>', 'Path to settings JSON file or JSON string')
    .option('--page-prompts', 'Page prompt output one screenful at a time (q to skip)')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--registry <path>', 'Registry path override')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (agentId: string, options: GuiOptions) => {
      if (options.printCommand) {
        options.dryRun = true
      }

      try {
        const result = await runGui(agentId, options)

        if (options.printCommand && result.command) {
          console.log(result.command)
          process.exit(0)
        }

        if (options.dryRun) {
          await displayPrompts({
            systemPrompt: result.systemPrompt,
            systemPromptMode: result.systemPromptMode,
            reminderContent: result.reminderContent,
            primingPrompt: result.primingPrompt,
            promptSectionSizes: result.promptSectionSizes,
            reminderSectionSizes: result.reminderSectionSizes,
            totalContextChars: result.totalContextChars,
            maxChars: result.maxChars,
            nearMaxChars: result.nearMaxChars,
            command: result.displayCommand ?? result.command,
            showCommand: true,
            pagePrompts: options.pagePrompts,
          })
        }

        process.exit(result.exitCode)
      } catch (error) {
        exitWithAspError(error)
      }
    })
}
