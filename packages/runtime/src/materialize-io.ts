import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SystemPromptMode } from './context-template.js'

export interface MaterializeResult {
  path: string
  content: string
  mode: SystemPromptMode
  reminderContent?: string | undefined
  maxChars?: number | undefined
  promptSectionSizes?: string[] | undefined
  reminderSectionSizes?: string[] | undefined
  totalContextChars?: number | undefined
  nearMaxChars?: boolean | undefined
}

const SYSTEM_PROMPT_FILENAME = 'system-prompt.md'
const SESSION_REMINDER_FILENAME = 'session-reminder.md'

/** Write a built-in (prompt-only) system prompt to `outputPath`. */
export function writeMaterializedPrompt(
  outputPath: string,
  prompt: { content: string; mode: SystemPromptMode }
): MaterializeResult {
  const promptPath = join(outputPath, SYSTEM_PROMPT_FILENAME)
  mkdirSync(outputPath, { recursive: true })
  writeFileSync(promptPath, prompt.content, 'utf8')

  return {
    path: promptPath,
    content: prompt.content,
    mode: prompt.mode,
  }
}

/** Write a context-template prompt plus its session-reminder companion file. */
export function writeMaterializedContext(
  outputPath: string,
  prompt: {
    content: string
    mode: SystemPromptMode
    reminderContent: string | undefined
    maxChars?: number | undefined
  }
): MaterializeResult {
  const promptPath = join(outputPath, SYSTEM_PROMPT_FILENAME)
  const reminderPath = join(outputPath, SESSION_REMINDER_FILENAME)
  mkdirSync(outputPath, { recursive: true })
  writeFileSync(promptPath, prompt.content, 'utf8')
  writeFileSync(reminderPath, prompt.reminderContent ?? '', 'utf8')

  return {
    path: promptPath,
    content: prompt.content,
    mode: prompt.mode,
    reminderContent: prompt.reminderContent,
    ...(prompt.maxChars !== undefined ? { maxChars: prompt.maxChars } : {}),
  }
}
