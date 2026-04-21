/**
 * `asp self explain [prompt|reminder|launch]` — owned by cody (T-01160).
 *
 * Placeholder so the dispatcher compiles while cody implements. Diagnostic
 * mode that answers "why is this (not) there?" (e.g. "no system-prompt.md
 * because template mode is append").
 */

import type { Command } from 'commander'

export function registerSelfExplainCommand(self: Command): void {
  self
    .command('explain [which]')
    .description(
      'Diagnose why a prompt / reminder / launch looks the way it does (in progress — T-01160 / cody)'
    )
    .option('--json', 'Emit machine-readable JSON')
    .action(async () => {
      process.stderr.write('asp self explain: not yet implemented (T-01160, owner: cody).\n')
      process.exit(78)
    })
}
