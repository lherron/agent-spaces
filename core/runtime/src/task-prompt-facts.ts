import type { HrcTaskContext } from 'spaces-runtime-contracts'

/**
 * Typed task facts a context template may render (T-09860, EN-20230).
 *
 * Facts derive only from the preparation identity's wrkq task ID and an
 * optional producer taskContext — never from any environment. A field is
 * present only when its source value is real: null, blank, and empty values
 * are absent, so a template never renders placeholder lines.
 */
export type PromptTaskFacts = {
  id: string
  phase?: string | undefined
  role?: string | undefined
  requiredEvidence?: string[] | undefined
  hints?: string | undefined
}

export type PromptTaskField = keyof PromptTaskFacts

export const PROMPT_TASK_FIELDS: readonly PromptTaskField[] = [
  'id',
  'phase',
  'role',
  'requiredEvidence',
  'hints',
]

/**
 * A scope's task segment is also used for seat names (`primary`,
 * `primary-nova`) and sub-seats (`T-08566-b7p`). Only a whole wrkq task ID is
 * a task; the pattern stays anchored so no task ID is ever invented.
 */
const WRKQ_TASK_ID = /^T-[0-9]+$/

export function derivePromptTaskFacts(input: {
  taskId?: string | undefined
  taskContext?: HrcTaskContext | undefined
}): PromptTaskFacts | undefined {
  const context = input.taskContext
  if (context !== undefined) {
    const phase = nonBlank(context.phase)
    const role = nonBlank(context.role)
    const hints = nonBlank(context.hintsText)?.trimEnd()
    const requiredEvidence = context.requiredEvidenceKinds.filter(
      (kind) => nonBlank(kind) !== undefined
    )
    return {
      id: context.taskId,
      ...(phase !== undefined ? { phase } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(requiredEvidence.length > 0 ? { requiredEvidence } : {}),
      ...(hints !== undefined ? { hints } : {}),
    }
  }
  if (input.taskId !== undefined && WRKQ_TASK_ID.test(input.taskId)) {
    return { id: input.taskId }
  }
  return undefined
}

/** Template variables for present facts, keyed `task.<field>`. */
export function promptTaskVariables(facts: PromptTaskFacts | undefined): Record<string, string> {
  return {
    'task.id': facts?.id ?? '',
    'task.phase': facts?.phase ?? '',
    'task.role': facts?.role ?? '',
    'task.requiredEvidence': facts?.requiredEvidence?.join(', ') ?? '',
    'task.hints': facts?.hints ?? '',
  }
}

function nonBlank(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}
