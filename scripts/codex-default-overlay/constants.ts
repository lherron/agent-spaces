import { homedir } from 'node:os'
import { join } from 'node:path'

import type { RunMode } from 'spaces-config'

export const PROJECT_ID = 'praesidium'
export const TASK_ID = 'primary'
export const RUN_MODE: RunMode = 'query'
export const DEFAULT_AGENT = 'stella'
export const DEFAULT_PROJECT_ROOT = join(homedir(), 'praesidium')
export const DEFAULT_ASP_HOME = join(homedir(), 'praesidium/var/spaces-repo')
export const DEFAULT_AGENTS_ROOT = join(homedir(), 'praesidium/var/agents')
export const AGENT_BLOCK_PREFIX = 'agent-spaces:codex-default'
export const SKILL_MARKER_FILE = '.asp-agent-sync.json'
export const CODEX_HOOKS_FILE = 'hooks.json'
export const CODEX_CONFIG_FILE = 'config.toml'
export const PRE_TOOL_USE_HOOK_FILENAME = 'pre-tool-use-praesidium-env.mjs'
export const PRE_TOOL_USE_STATUS = 'injecting Praesidium command env'
export const DISCOVERY_HOOK_FILENAME = 'desktop-registration-discovery.mjs'
export const DISCOVERY_STATUS = 'registering this conversation with HRC'
export const DISCOVERY_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit'] as const
export const CODEX_APP_OVERLAY_ENV = 'ASP_CODEX_APP_OVERLAY'

/**
 * Location of the aspd service activation record (T-08594 component 5).
 *
 * The discovery hook reads this file AT HOOK RUN TIME and spawns
 * `<releasePath>/harness-broker` from the release it names, so an aspd
 * activation changes which release new brokers run without reinstalling the
 * overlay. Only this path is embedded; there is no aspd namespace in the
 * overlay and never a checkout path, a bunfs path, or a PATH lookup.
 * `ASPD_ACTIVE_JSON` overrides it (test seam and operator escape hatch).
 */
export const ASPD_ACTIVE_JSON_PATH = join(
  homedir(),
  'praesidium',
  'var',
  'aspd',
  'service',
  'active.json'
)
/**
 * Hard ceiling on the discovery callback, measured from the overlay side.
 *
 * The helper carries its own 1.5 s socket deadline; this is the outer bound on
 * the whole spawn, because a helper that never exits would otherwise sit in
 * front of a turn Lance is waiting on. Contract §4: hooks have "bounded
 * callback time".
 */
export const DISCOVERY_TIMEOUT_MS = 4_000
