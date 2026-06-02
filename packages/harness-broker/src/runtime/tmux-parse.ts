/**
 * Pure parsers + format constants for tmux command output. Extracted from
 * `tmux.ts` (SRP): version parsing, pane-metadata/identity parsing, and the
 * regexes/format strings that drive them, with no dependency on the lifecycle
 * or controller classes.
 */
import type { TmuxPaneState } from './tmux'

export const MIN_SUPPORTED_TMUX_VERSION = {
  major: 3,
  minor: 2,
}

export const WINDOW_NAME = 'main'

const PANE_METADATA_PATTERN = /^(\$\d+)[\t_](@\d+)[\t_](%\d+)[\t_](.+)$/
const PANE_IDENTITY_PATTERN = /^(\$\d+)[\t_](@\d+)[\t_](%\d+)$/
export const PANE_IDENTITY_FORMAT = '#{session_id}\t#{window_id}\t#{pane_id}'

export function parseVersion(stdout: string, stderr: string): { major: number; minor: number } {
  const source = `${stdout}\n${stderr}`.trim()
  const match = source.match(/tmux\s+(\d+)\.(\d+)/i)
  if (!match) {
    throw new Error(`unable to parse tmux version from output: ${source || '<empty>'}`)
  }

  return {
    major: Number.parseInt(match[1] ?? '0', 10),
    minor: Number.parseInt(match[2] ?? '0', 10),
  }
}

export function parsePaneState(stdout: string, socketPath: string): TmuxPaneState {
  const line = stdout
    .trim()
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)

  if (!line) {
    throw new Error('tmux command did not return pane metadata')
  }

  const match = PANE_METADATA_PATTERN.exec(line)
  if (!match) {
    throw new Error(`unexpected tmux metadata line: ${line}`)
  }

  const [, sessionId, windowId, paneId, sessionName] = match
  if (!sessionName || !sessionId || !windowId || !paneId) {
    throw new Error(`tmux metadata regex captured empty groups in line: ${line}`)
  }

  return {
    socketPath,
    sessionName,
    windowName: WINDOW_NAME,
    sessionId,
    windowId,
    paneId,
  }
}

export function parsePaneIdentity(stdout: string): {
  sessionId: string
  windowId: string
  paneId: string
} {
  const line = stdout
    .trim()
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)

  if (!line) {
    throw new Error('tmux command did not return pane identity')
  }

  const match = PANE_IDENTITY_PATTERN.exec(line)
  if (!match) {
    throw new Error(`unexpected tmux pane identity line: ${line}`)
  }

  const [, sessionId, windowId, paneId] = match
  if (!sessionId || !windowId || !paneId) {
    throw new Error(`tmux pane identity regex captured empty groups in line: ${line}`)
  }

  return { sessionId, windowId, paneId }
}
