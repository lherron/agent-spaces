/**
 * Codex hooks: HRC hooks.json construction, deterministic hook-trust hashing,
 * and the helpers that seed/refresh a config.toml's hook-trust store.
 */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import TOML from '@iarna/toml'
import type { CanonicalHookDefinition } from 'spaces-config'
import { createCanonicalHasher } from 'spaces-runtime-contracts'

/** Codex defaults the hook execution timeout to 600 seconds. */
const DEFAULT_HOOK_TIMEOUT_SECONDS = 600

const CODEX_HOOK_EVENT_KEY_LABELS: Record<string, string> = {
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  Stop: 'stop',
}

const CODEX_HOOK_EVENTS_WITH_MATCHERS = new Set([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
])

/** Shared HRC capture command: invokes the launch hook CLI when HRC wires one in. */
const HRC_CODEX_HOOK_COMMAND =
  'if [ -n "${HRC_LAUNCH_HOOK_CLI:-}" ]; then bun "$HRC_LAUNCH_HOOK_CLI"; fi'

/**
 * Lifecycle events the interactive (codex-cli-tmux) broker driver needs to
 * normalize a turn. The headless codex-app-server path only needs `Stop` (turn
 * completion), which stays the default so existing materialization is unchanged.
 */
export const CODEX_INTERACTIVE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
] as const

function buildCodexHookGroup(eventName: string): Record<string, unknown> {
  const statusMessage =
    eventName === 'Stop' ? 'capturing Codex turn' : `capturing Codex ${eventName}`
  const handler = { type: 'command', command: HRC_CODEX_HOOK_COMMAND, statusMessage }
  // Matcher-bearing events take a group-level matcher; "" = match all tools.
  return CODEX_HOOK_EVENTS_WITH_MATCHERS.has(eventName)
    ? { matcher: '', hooks: [handler] }
    : { hooks: [handler] }
}

/**
 * Build the HRC codex hooks.json. Defaults to `Stop`-only (headless turn capture,
 * unchanged behavior); pass the full lifecycle event list to capture every event
 * the interactive broker driver normalizes.
 */
export function buildHrcCodexHooksConfig(
  events: readonly string[] = ['Stop']
): Record<string, unknown> {
  const hooks: Record<string, unknown> = {}
  for (const eventName of events) {
    hooks[eventName] = [buildCodexHookGroup(eventName)]
  }
  return { hooks }
}

/**
 * Space hooks (hooks.toml entries with `harness = "codex"`). A space artifact
 * carries its `hooks/` tree plus this fragment; the composed codex home copies
 * each tree to `space-hooks/<spaceId>/` and merges the fragment into hooks.json.
 * Only explicitly codex-targeted entries are wired: harness-neutral entries were
 * written against Claude's payloads and stay Claude/Pi-only.
 */
export const CODEX_SPACE_HOOKS_FILE = 'space-hooks.json'
export const CODEX_SPACE_HOOKS_DIR = 'space-hooks'

/** hooks.toml events a codex space hook may declare, mapped to codex event names. */
const CODEX_SPACE_HOOK_EVENTS: Record<string, string> = {
  pre_tool_use: 'PreToolUse',
}

export interface CodexSpaceHook {
  event: string
  script: string
  tools?: string[] | undefined
}

const SAFE_HOOK_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/

/** Pick the hooks.toml entries that codex honours. */
export function selectCodexSpaceHooks(hooks: CanonicalHookDefinition[]): CodexSpaceHook[] {
  return hooks
    .filter((h) => h.harness === 'codex' && h.event in CODEX_SPACE_HOOK_EVENTS)
    .map((h) => ({ event: h.event, script: h.script, ...(h.tools ? { tools: h.tools } : {}) }))
}

/**
 * Build hooks.json groups for space hooks. The command resolves the script
 * under $CODEX_HOME so no staging or bundle path is baked in, and exits 0 when
 * the script is absent: a missing hook must never wedge a seat.
 */
export function buildCodexSpaceHooksConfig(
  spaces: ReadonlyArray<{ spaceId: string; hooks: readonly CodexSpaceHook[] }>
): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {}
  for (const { spaceId, hooks: spaceHooks } of spaces) {
    for (const hook of spaceHooks) {
      const eventName = CODEX_SPACE_HOOK_EVENTS[hook.event]
      if (!eventName) continue
      if (!SAFE_HOOK_PATH.test(spaceId) || !SAFE_HOOK_PATH.test(hook.script)) {
        throw new Error(`unsafe codex space hook path: ${spaceId}/${hook.script}`)
      }
      const scriptPath = `\${CODEX_HOME:-}/${CODEX_SPACE_HOOKS_DIR}/${spaceId}/${hook.script}`
      const command = `p="${scriptPath}"; [ -x "$p" ] || exit 0; exec "$p"`
      const matcher = !hook.tools || hook.tools.includes('*') ? '' : hook.tools.join('|')
      const groups = hooks[eventName] ?? []
      groups.push({ matcher, hooks: [{ type: 'command', command }] })
      hooks[eventName] = groups
    }
  }
  return { hooks }
}

/** Concatenate hooks.json configs event by event, preserving order. */
export function mergeCodexHooksConfigs(
  ...configs: ReadonlyArray<Record<string, unknown>>
): Record<string, unknown> {
  const merged: Record<string, unknown[]> = {}
  for (const config of configs) {
    const root = isRecord(config['hooks']) ? config['hooks'] : {}
    for (const [eventName, groups] of Object.entries(root)) {
      if (!Array.isArray(groups)) continue
      merged[eventName] = [...(merged[eventName] ?? []), ...groups]
    }
  }
  return { hooks: merged }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * Hook-trust versions hash the single shared canonical-JSON serialization from
 * spaces-runtime-contracts (codepoint key ordering, undefined fields omitted)
 * rather than a local canonicalizer.
 */
const canonicalHasher = createCanonicalHasher()

function versionForCodexTomlValue(value: Record<string, unknown>): string {
  return `sha256:${canonicalHasher.hash(value).value}`
}

function normalizedCodexHookHash(
  eventLabel: string,
  matcher: string | undefined,
  handler: Record<string, unknown>
): string {
  const identity: Record<string, unknown> = {
    event_name: eventLabel,
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [handler],
  }
  return versionForCodexTomlValue(identity)
}

function normalizedTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_HOOK_TIMEOUT_SECONDS
  }
  return Math.max(1, Math.trunc(value))
}

export function buildCodexHookTrustState(
  hooksPath: string,
  hooksConfig: Record<string, unknown>
): Record<string, { trusted_hash: string }> {
  const root = isRecord(hooksConfig['hooks']) ? hooksConfig['hooks'] : {}
  const trustedState: Record<string, { trusted_hash: string }> = {}
  const keySource = canonicalHookTrustPath(hooksPath)

  for (const [eventName, eventLabel] of Object.entries(CODEX_HOOK_EVENT_KEY_LABELS)) {
    const groups = root[eventName]
    if (!Array.isArray(groups)) continue

    for (const [groupIndex, groupValue] of groups.entries()) {
      if (!isRecord(groupValue)) continue
      const matcher =
        CODEX_HOOK_EVENTS_WITH_MATCHERS.has(eventName) && typeof groupValue['matcher'] === 'string'
          ? groupValue['matcher']
          : undefined
      const handlers = groupValue['hooks']
      if (!Array.isArray(handlers)) continue

      for (const [handlerIndex, handlerValue] of handlers.entries()) {
        if (!isRecord(handlerValue)) continue
        if (handlerValue['type'] !== 'command') continue
        if (handlerValue['async'] === true) continue
        const command = handlerValue['command']
        if (typeof command !== 'string' || command.trim() === '') continue

        const normalizedHandler: Record<string, unknown> = {
          type: 'command',
          command,
          timeout: normalizedTimeout(handlerValue['timeout']),
          async: false,
          ...(typeof handlerValue['statusMessage'] === 'string'
            ? { statusMessage: handlerValue['statusMessage'] }
            : {}),
        }
        const key = `${keySource}:${eventLabel}:${groupIndex}:${handlerIndex}`
        trustedState[key] = {
          trusted_hash: normalizedCodexHookHash(eventLabel, matcher, normalizedHandler),
        }
      }
    }
  }

  return trustedState
}

export function addCodexHookTrustState(
  config: Record<string, unknown>,
  hooksPath: string,
  hooksConfig: Record<string, unknown>,
  options: { replaceHooksPaths?: string[] } = {}
): Record<string, unknown> {
  const trustState = buildCodexHookTrustState(hooksPath, hooksConfig)
  if (Object.keys(trustState).length === 0) {
    return config
  }

  const hooks = isRecord(config['hooks']) ? { ...config['hooks'] } : {}
  const state = isRecord(hooks['state']) ? { ...hooks['state'] } : {}
  const keySource = canonicalHookTrustPath(hooksPath)
  for (const staleHooksPath of options.replaceHooksPaths ?? []) {
    const staleKeySource = canonicalHookTrustPath(staleHooksPath)
    for (const key of Object.keys(trustState)) {
      const suffix = key.slice(keySource.length)
      delete state[`${staleKeySource}${suffix}`]
    }
  }

  for (const [key, value] of Object.entries(trustState)) {
    const existing = isRecord(state[key]) ? state[key] : {}
    state[key] = { ...existing, ...value }
  }

  return {
    ...config,
    hooks: {
      ...hooks,
      state,
    },
  }
}

function canonicalHookTrustPath(hooksPath: string): string {
  const resolved = resolve(hooksPath)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

export function trustCodexHooksInConfigToml(
  configToml: string,
  hooksPath: string,
  hooksJson: string,
  options: { replaceHooksPaths?: string[] } = {}
): string {
  const hooksConfig = JSON.parse(hooksJson) as Record<string, unknown>
  const parsed = TOML.parse(configToml) as Record<string, unknown>
  const updated = addCodexHookTrustState(parsed, hooksPath, hooksConfig, options)
  if (updated === parsed) {
    return configToml
  }
  return `${TOML.stringify(updated as TOML.JsonMap)}\n`
}
