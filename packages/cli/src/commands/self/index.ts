/**
 * `asp self` — introspection and self-modification pointers for a running
 * agent.
 *
 * WHY: a live agent (Claude Code harness) can read HRC_LAUNCH_FILE and
 * ASP_PLUGIN_ROOT directly, but the raw env/files don't explain what goes
 * into composing the prompt, which files are durable edit targets, or which
 * are derived outputs. `asp self` normalizes this surface so agents can
 * introspect their own startup and locate self-modification paths without
 * scraping internals.
 *
 * Subcommands (all accept --json):
 *   inspect   — zero-arg overview (clod / T-01159)
 *   paths     — every runtime path, classified (clod / T-01159)
 *   prompt    — effective system / reminder / priming (cody / T-01160)
 *   explain   — diagnostic "why is this (not) there?" (cody / T-01160)
 */

import type { Command } from 'commander'

import { registerSelfExplainCommand } from './explain.js'
import { registerSelfInspectCommand } from './inspect.js'
import { registerSelfPathsCommand } from './paths.js'
import { registerSelfPromptCommand } from './prompt.js'

export function registerSelfCommands(program: Command): void {
  const self = program
    .command('self')
    .description("Introspect this agent's runtime launch and locate edit targets")

  registerSelfInspectCommand(self)
  registerSelfPathsCommand(self)
  registerSelfPromptCommand(self)
  registerSelfExplainCommand(self)
}
