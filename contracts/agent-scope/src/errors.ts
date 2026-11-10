/**
 * Coarse refusal codes shared by every implementation of the scope grammar
 * (contracts/agent-scope/conformance/README.md). Messages stay each language's
 * own; the code is what the conformance fixture checks.
 */
export type ScopeErrorCode =
  | 'empty'
  | 'token_invalid'
  | 'shape_invalid'
  | 'directive_not_allowed'
  | 'task_requires_project'

export const SCOPE_ERROR_CODES: readonly ScopeErrorCode[] = [
  'empty',
  'token_invalid',
  'shape_invalid',
  'directive_not_allowed',
  'task_requires_project',
]

/**
 * The error every grammar operation throws. It stays a plain `Error` to
 * callers (same message, same `name`); the only addition is `code`.
 */
export class ScopeGrammarError extends Error {
  readonly code: ScopeErrorCode

  constructor(message: string, code: ScopeErrorCode) {
    super(message)
    this.code = code
  }
}
