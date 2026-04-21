/**
 * `asp self prompt [system|reminder|priming]` — owned by cody (T-01160).
 *
 * Placeholder so the dispatcher compiles while cody implements. Uses
 * resolveSelfContext + section-level template resolution.
 */

import type { Command } from 'commander'

export function registerSelfPromptCommand(self: Command): void {
  self
    .command('prompt [which]')
    .description(
      'Show effective system prompt / reminder / priming prompt (in progress — T-01160 / cody)'
    )
    .option('--json', 'Emit machine-readable JSON')
    .option('--raw', 'Show raw content without section headers')
    .option('--sections', 'Annotate per-section source and byte count')
    .action(async () => {
      process.stderr.write(
        'asp self prompt: not yet implemented (T-01160, owner: cody). ' +
          'Use `asp self inspect` for prompt metadata in the meantime.\n'
      )
      process.exit(78) // EX_CONFIG — tells wrappers this is a known stub
    })
}
