/**
 * Project CLI run results into the shared prompt display renderer.
 */

import { type RunResult, displayPrompts } from 'spaces-execution'

/**
 * Render the dry-run prompt/command dump for a `RunResult`.
 *
 * The `run` and `gui` commands build a byte-identical argument object from a
 * `RunResult` in their dry-run branch; this hoists that projection so both
 * call sites share one source of truth. Pure presentation — no behavior change.
 */
export function displayRunResultPrompts(
  result: RunResult,
  pagePrompts: boolean | undefined
): Promise<void> {
  return displayPrompts({
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
    pagePrompts,
  })
}
