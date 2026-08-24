/**
 * Pi adapter constants: default model, search paths, component dirs, and
 * well-known host paths used by codegen and composition.
 */

import { join } from 'node:path'

/** Default Pi model id when none is specified. */
export const DEFAULT_PI_MODEL = 'gpt-5.5'

/**
 * Component directory names used across materialize/compose. Hooks live under
 * `hooks-scripts/` (not `hooks/`) to avoid clashing with Pi's incompatible
 * native hooks format.
 */
export const COMPONENT_DIR_NAMES = {
  EXTENSIONS: 'extensions',
  SKILLS: 'skills',
  HOOKS: 'hooks-scripts',
  SCRIPTS: 'scripts',
  SHARED: 'shared',
  SESSIONS: 'sessions',
} as const

/**
 * Common locations to search for the Pi binary.
 */
export const COMMON_PI_PATHS = [
  // Primary location
  join(process.env['HOME'] || '~', 'tools/pi-mono/packages/cli/bin/pi.js'),
  // Alternative locations
  join(process.env['HOME'] || '~', 'tools/pi-mono'),
  '/usr/local/bin/pi',
  '/usr/bin/pi',
  join(process.env['HOME'] || '~', '.local/bin/pi'),
]

/**
 * Events that Pi can support blocking on (none currently - best-effort only).
 */
export const PI_BLOCKING_EVENTS: string[] = []

/**
 * Relative path (under `os.homedir()`) of the Pi auth file linked into a
 * composed target so Pi can authenticate.
 */
export const PI_AUTH_RELATIVE_PATH = ['.pi', 'agent', 'auth.json'] as const

/**
 * Directory (under `os.homedir()`) where the generated hook bridge writes its
 * runtime log.
 */
export const HOOK_LOG_RELATIVE_DIR = ['praesidium', 'var', 'logs'] as const

/**
 * Default praesidium var directory (relative to `os.homedir()`) used as the
 * `aspHome` fallback when resolving HRC runtime session dirs.
 */
export const PRAESIDIUM_VAR_RELATIVE_DIR = ['praesidium', 'var'] as const

/**
 * Sub-path (under an HRC runtime dir) where Pi session files are stored.
 */
export const HRC_RUNTIME_SESSIONS_SUBPATH = 'state/hrc/runtimes'
