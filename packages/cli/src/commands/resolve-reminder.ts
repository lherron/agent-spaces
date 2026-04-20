/**
 * Resolve-reminder command — resolve [[reminder]] sections from context template.
 *
 * WHY: SessionStart hooks call `asp resolve-reminder` to inject dynamic
 * reminder content into <system-reminder> blocks. This command discovers
 * the active context template, resolves only the reminder
 * sections, and outputs the result to stdout for hook consumption.
 *
 * Exit behavior:
 * - Exit 0 with empty stdout when no reminder content exists
 * - Exit 0 with reminder content on stdout when reminders resolve
 * - Exit 1 on errors (template parse failure, required file missing, etc.)
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { parse as parseToml } from '@iarna/toml'
import chalk from 'chalk'
import type { Command } from 'commander'

import { getAgentsRoot, getAspHome } from 'spaces-config'
import {
  type ContextResolverContext,
  discoverContextTemplate,
  resolveContextTemplateDetailed,
} from 'spaces-runtime'

interface ResolveReminderOptions {
  agentRoot?: string
  agentsRoot?: string
  aspHome?: string
  target?: string
  debug?: boolean
}

/**
 * Resolve the agent root from options and environment.
 *
 * Priority:
 * 1. Explicit --agent-root
 * 2. --target + agents-root → <agents-root>/<target>
 * 3. undefined (no agent-specific template discovery)
 */
function resolveAgentRoot(
  options: ResolveReminderOptions,
  agentsRoot: string | undefined
): string | undefined {
  if (options.agentRoot) {
    return options.agentRoot
  }

  if (options.target && agentsRoot) {
    return join(agentsRoot, options.target)
  }

  return undefined
}

function inferTargetFromEnvironment(): string | undefined {
  const claudeTarget = inferTargetFromClaudePluginRoot(process.env['CLAUDE_PLUGIN_ROOT'])
  if (claudeTarget) {
    return claudeTarget
  }

  const bundleTarget = inferTargetFromBundleRoot(process.env['ASP_PLUGIN_ROOT'])
  if (bundleTarget) {
    return bundleTarget
  }

  return inferTargetFromCodexHome(process.env['CODEX_HOME'])
}

function inferTargetFromClaudePluginRoot(pluginRoot: string | undefined): string | undefined {
  if (!pluginRoot) {
    return undefined
  }

  const pluginsDir = dirname(pluginRoot)
  if (pluginsDir.split('/').pop() !== 'plugins') {
    return undefined
  }

  return inferTargetFromBundleRoot(dirname(pluginsDir))
}

function inferTargetFromCodexHome(codexHome: string | undefined): string | undefined {
  if (!codexHome) {
    return undefined
  }

  const metadataPath = join(codexHome, '.asp-runtime.json')
  if (!existsSync(metadataPath)) {
    return undefined
  }

  try {
    const parsed = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
      targetName?: unknown
    }
    return typeof parsed.targetName === 'string' && parsed.targetName.length > 0
      ? parsed.targetName
      : undefined
  } catch {
    return undefined
  }
}

function inferTargetFromBundleRoot(bundleRoot: string | undefined): string | undefined {
  if (!bundleRoot) {
    return undefined
  }

  const harnessDir = bundleRoot
  const targetDir = dirname(harnessDir)
  const harnessName = harnessDir.split('/').pop()
  if (!harnessName || dirname(targetDir) === targetDir) {
    return undefined
  }

  const targetName = targetDir.split('/').pop()
  return targetName && targetName.length > 0 ? targetName : undefined
}

/**
 * Register the resolve-reminder command.
 */
export function registerResolveReminderCommand(program: Command): void {
  program
    .command('resolve-reminder')
    .description('Resolve session reminder sections from the context template')
    .argument('[target]', 'Target/agent name (used to locate agent-specific template)')
    .option('--agent-root <path>', 'Explicit agent root directory')
    .option('--agents-root <path>', 'Override agents root directory')
    .option('--asp-home <path>', 'Override ASP_HOME')
    .option('--debug', 'Print diagnostic info to stderr')
    .action(async (target: string | undefined, options: ResolveReminderOptions) => {
      try {
        if (target !== undefined) {
          options.target = target
        }
        const aspHome = options.aspHome ?? getAspHome()
        const agentsRoot: string = options.agentsRoot ?? getAgentsRoot() ?? aspHome
        const inferredTarget = options.target ?? inferTargetFromEnvironment()
        if (inferredTarget !== undefined) {
          options.target = inferredTarget
        }
        const agentRoot = resolveAgentRoot(options, agentsRoot)

        if (options.debug) {
          console.error(chalk.gray(`[resolve-reminder] aspHome=${aspHome}`))
          console.error(chalk.gray(`[resolve-reminder] agentsRoot=${agentsRoot}`))
          console.error(chalk.gray(`[resolve-reminder] agentRoot=${agentRoot ?? '(none)'}`))
        }

        // discoverContextTemplate requires agentRoot; when absent we fall back
        // to agentsRoot as a synthetic agent root so template discovery still
        // checks agentsRoot and aspHome convention paths.
        const discovered = discoverContextTemplate({
          agentRoot: agentRoot ?? agentsRoot,
          agentsRoot,
          aspHome,
        })

        if (!discovered.templateSource) {
          if (options.debug) {
            console.error(chalk.gray('[resolve-reminder] no context template found'))
          }
          process.exit(0)
        }

        const contextTemplate = discovered.templateSource.template

        if (contextTemplate.reminderSections.length === 0) {
          if (options.debug) {
            console.error(chalk.gray('[resolve-reminder] template has no reminder sections'))
          }
          process.exit(0)
        }

        // Build resolver context
        const resolverContext: ContextResolverContext = {
          agentRoot: agentRoot ?? agentsRoot,
          agentName: basename(agentRoot ?? agentsRoot),
          agentsRoot: discovered.agentsRoot,
          projectRoot: process.cwd(),
          runMode: 'query',
        }

        // Use profile from discovery for slot resolution
        if (discovered.profile.rawProfile) {
          resolverContext.agentProfile = discovered.profile.rawProfile
        } else if (agentRoot) {
          // Fallback: load agent profile directly if discovery didn't include it
          const profilePath = join(agentRoot, 'agent-profile.toml')
          if (existsSync(profilePath)) {
            resolverContext.agentProfile = parseToml(readFileSync(profilePath, 'utf8')) as Record<
              string,
              unknown
            >
          }
        }

        const resolved = await resolveContextTemplateDetailed(contextTemplate, resolverContext, {
          includePrompt: false,
        })

        if (resolved.reminder && resolved.reminder.length > 0) {
          process.stdout.write(resolved.reminder)
        }

        process.exit(0)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`resolve-reminder: ${message}`)
        process.exit(1)
      }
    })
}
