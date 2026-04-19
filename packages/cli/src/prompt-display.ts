/**
 * Re-exports the shared prompt-display module from spaces-execution.
 *
 * The implementation lives in spaces-execution so `hrc launch exec`
 * can use the same renderer without depending on the cli package.
 */

export {
  displayPrompts,
  displayCommand,
  formatDisplayCommand,
  type DisplayPromptOptions,
} from 'spaces-execution'
