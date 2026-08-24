/**
 * tmux id shape rules — enforced at the protocol layer so consumers can rely
 * on the lease carrying canonical tmux ids without re-parsing.
 *
 *   - sessionId: tmux session ids look like `$3`
 *   - windowId:  tmux window  ids look like `@7`
 *   - paneId:    tmux pane    ids look like `%12`
 *
 * Extracted from schemas.ts (behavior-preserving). Not part of the public
 * package surface — schemas.ts imports these internally.
 */

import type { ValidationIssue } from './errors.js'
import { joinPath, makeIssue } from './validation-primitives.js'

export const TMUX_SESSION_ID_PATTERN = /^\$\d+$/
export const TMUX_WINDOW_ID_PATTERN = /^@\d+$/
export const TMUX_PANE_ID_PATTERN = /^%\d+$/

export type TmuxIdField = 'sessionId' | 'windowId' | 'paneId'

const TMUX_ID_PATTERNS: Record<TmuxIdField, RegExp> = {
  sessionId: TMUX_SESSION_ID_PATTERN,
  windowId: TMUX_WINDOW_ID_PATTERN,
  paneId: TMUX_PANE_ID_PATTERN,
}

/**
 * Validate a single required tmux id (`value`) against its canonical regex,
 * pushing issues onto the shared list. `objectLabel` names the enclosing DTO
 * for the human-readable message (e.g. `terminalSurface` or `payload`).
 * Returns true when the id is a non-empty string matching the pattern.
 */
export function validateTmuxId(
  value: unknown,
  field: TmuxIdField,
  basePath: string,
  objectLabel: string,
  issues: ValidationIssue[]
): boolean {
  const pattern = TMUX_ID_PATTERNS[field]
  const fieldPath = joinPath(basePath, field)
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(
      makeIssue(fieldPath, 'required', `${objectLabel}.${field} must be a non-empty string`)
    )
    return false
  }
  if (!pattern.test(value)) {
    issues.push(
      makeIssue(
        fieldPath,
        'invalid_tmux_id',
        `${objectLabel}.${field} must match ${String(pattern)}`
      )
    )
    return false
  }
  return true
}

/**
 * Validate the `{ sessionId, windowId, paneId }` id triple carried by a tmux
 * pane lease / surface report. Reads each id from `source` and validates it.
 * Returns true only when all three ids are well-formed.
 */
export function validateTmuxPaneIds(
  source: Record<string, unknown>,
  basePath: string,
  objectLabel: string,
  issues: ValidationIssue[]
): boolean {
  let ok = true
  ok = validateTmuxId(source['sessionId'], 'sessionId', basePath, objectLabel, issues) && ok
  ok = validateTmuxId(source['windowId'], 'windowId', basePath, objectLabel, issues) && ok
  ok = validateTmuxId(source['paneId'], 'paneId', basePath, objectLabel, issues) && ok
  return ok
}
