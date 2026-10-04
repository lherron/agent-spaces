import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { buildCodexHookTrustState } from 'spaces-harness-codex'

import {
  CODEX_CONFIG_FILE,
  CODEX_HOOKS_FILE,
  DISCOVERY_HOOK_EVENTS,
  DISCOVERY_HOOK_FILENAME,
  DISCOVERY_STATUS,
  PRE_TOOL_USE_HOOK_FILENAME,
  PRE_TOOL_USE_STATUS,
} from './constants'
import { buildDiscoveryHookScript, buildPreToolUseHookScript, hookCommand } from './hook-scripts'
import type { HooksPlan } from './types'
import { pathExists } from './util'

export function buildManagedDiscoveryHookGroup(
  scriptPath: string,
  event: (typeof DISCOVERY_HOOK_EVENTS)[number]
): Record<string, unknown> {
  return {
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: hookCommand(scriptPath),
        statusMessage: `${DISCOVERY_STATUS} (${event})`,
      },
    ],
  }
}

export function buildManagedPreToolUseHookGroup(scriptPath: string): Record<string, unknown> {
  return {
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: hookCommand(scriptPath),
        statusMessage: PRE_TOOL_USE_STATUS,
      },
    ],
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function normalizeHooksConfig(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return { hooks: {} }
  }
  const hooks = isRecord(value['hooks']) ? value['hooks'] : {}
  return { ...value, hooks: { ...hooks } }
}

export function handlerCommand(handler: unknown): string | undefined {
  return isRecord(handler) && typeof handler['command'] === 'string'
    ? handler['command']
    : undefined
}

/**
 * Drop every handler this overlay owns from one event's groups.
 *
 * Keyed on the exact command string, so an unmanaged hook a person added to the
 * same event survives untouched — the overlay's standing promise that existing
 * desktop config is preserved.
 */
export function removeManagedHook(
  groups: unknown,
  managedCommands: readonly string[]
): Array<Record<string, unknown>> {
  if (!Array.isArray(groups)) {
    return []
  }

  const nextGroups: Array<Record<string, unknown>> = []
  for (const group of groups) {
    if (!isRecord(group)) continue
    const handlers = Array.isArray(group['hooks']) ? group['hooks'] : []
    const nextHandlers = handlers.filter((handler) => {
      const command = handlerCommand(handler)
      return command === undefined || !managedCommands.includes(command)
    })
    if (nextHandlers.length === 0) continue
    nextGroups.push({ ...group, hooks: nextHandlers })
  }
  return nextGroups
}

export function mergeManagedHooksConfig(
  existing: string,
  scriptPath: string,
  discoveryScriptPath: string
): string {
  let parsed: unknown = {}
  if (existing.trim().length > 0) {
    parsed = JSON.parse(existing) as unknown
  }
  const config = normalizeHooksConfig(parsed)
  const hooks = config['hooks'] as Record<string, unknown>
  const managed = [hookCommand(scriptPath), hookCommand(discoveryScriptPath)]
  hooks['PreToolUse'] = [
    ...removeManagedHook(hooks['PreToolUse'], managed),
    buildManagedPreToolUseHookGroup(scriptPath),
  ]
  for (const event of DISCOVERY_HOOK_EVENTS) {
    hooks[event] = [
      ...removeManagedHook(hooks[event], managed),
      buildManagedDiscoveryHookGroup(discoveryScriptPath, event),
    ]
  }
  return `${JSON.stringify(config, null, 2)}\n`
}

export function ensureHooksFeature(configToml: string): string {
  const lines = configToml.split('\n')
  let featuresStart = -1
  let featuresEnd = lines.length
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*\[features\]\s*$/u.test(lines[i])) {
      featuresStart = i
      continue
    }
    if (featuresStart !== -1 && i > featuresStart && /^\s*\[.*\]\s*$/u.test(lines[i])) {
      featuresEnd = i
      break
    }
  }

  if (featuresStart === -1) {
    const suffix = configToml.endsWith('\n') || configToml.length === 0 ? '' : '\n'
    return `${configToml}${suffix}\n[features]\nhooks = true\n`
  }

  for (let i = featuresStart + 1; i < featuresEnd; i += 1) {
    if (/^\s*hooks\s*=/u.test(lines[i])) {
      if (/^\s*hooks\s*=\s*true\s*(?:#.*)?$/u.test(lines[i])) {
        return configToml
      }
      lines[i] = 'hooks = true'
      return lines.join('\n')
    }
  }

  lines.splice(featuresStart + 1, 0, 'hooks = true')
  return lines.join('\n')
}

export function upsertTrustedHookState(
  configToml: string,
  hooksPath: string,
  hooksConfigJson: string
): string {
  const hooksConfig = JSON.parse(hooksConfigJson) as Record<string, unknown>
  const trustState = buildCodexHookTrustState(hooksPath, hooksConfig)
  let next = ensureHooksFeature(configToml)

  for (const [key, value] of Object.entries(trustState)) {
    const table = `[hooks.state.${JSON.stringify(key)}]`
    const lines = next.split('\n')
    const start = lines.findIndex((line) => line.trim() === table)
    if (start === -1) {
      const suffix = next.endsWith('\n') || next.length === 0 ? '' : '\n'
      next = `${next}${suffix}\n${table}\ntrusted_hash = ${JSON.stringify(value.trusted_hash)}\n`
      continue
    }

    let end = lines.length
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\s*\[.*\]\s*$/u.test(lines[i])) {
        end = i
        break
      }
    }
    let found = false
    for (let i = start + 1; i < end; i += 1) {
      if (/^\s*trusted_hash\s*=/u.test(lines[i])) {
        lines[i] = `trusted_hash = ${JSON.stringify(value.trusted_hash)}`
        found = true
        break
      }
    }
    if (!found) {
      lines.splice(start + 1, 0, `trusted_hash = ${JSON.stringify(value.trusted_hash)}`)
    }
    next = lines.join('\n')
  }

  return next.endsWith('\n') ? next : `${next}\n`
}

export async function buildHooksPlan(input: {
  codexHome: string
  agentId: string
  aspHome: string
  installHooks: boolean
}): Promise<HooksPlan> {
  const hooksPath = join(input.codexHome, CODEX_HOOKS_FILE)
  const configPath = join(input.codexHome, CODEX_CONFIG_FILE)
  const scriptPath = join(input.codexHome, '.asp-agent-sync', PRE_TOOL_USE_HOOK_FILENAME)
  const discoveryScriptPath = join(input.codexHome, '.asp-agent-sync', DISCOVERY_HOOK_FILENAME)

  if (!input.installHooks) {
    return {
      enabled: false,
      hooksPath,
      configPath,
      scriptPath,
      discoveryScriptPath,
      hooksAction: 'skip',
      configAction: 'skip',
      scriptAction: 'skip',
      discoveryScriptAction: 'skip',
    }
  }

  const existingHooks = (await pathExists(hooksPath)) ? await readFile(hooksPath, 'utf8') : ''
  const nextHooks = mergeManagedHooksConfig(existingHooks, scriptPath, discoveryScriptPath)
  const existingScript = (await pathExists(scriptPath)) ? await readFile(scriptPath, 'utf8') : ''
  const nextScript = buildPreToolUseHookScript(input.agentId, input.aspHome)
  const existingDiscovery = (await pathExists(discoveryScriptPath))
    ? await readFile(discoveryScriptPath, 'utf8')
    : ''
  const nextDiscovery = buildDiscoveryHookScript(input.agentId, input.aspHome)
  const existingConfig = (await pathExists(configPath)) ? await readFile(configPath, 'utf8') : ''
  const nextConfig = upsertTrustedHookState(existingConfig, hooksPath, nextHooks)

  return {
    enabled: true,
    hooksPath,
    configPath,
    scriptPath,
    discoveryScriptPath,
    discoveryScriptAction:
      existingDiscovery.length === 0
        ? 'create'
        : existingDiscovery === nextDiscovery
          ? 'unchanged'
          : 'update',
    hooksAction:
      existingHooks.length === 0 ? 'create' : existingHooks === nextHooks ? 'unchanged' : 'update',
    configAction:
      existingConfig.length === 0
        ? 'create'
        : existingConfig === nextConfig
          ? 'unchanged'
          : 'update',
    scriptAction:
      existingScript.length === 0
        ? 'create'
        : existingScript === nextScript
          ? 'unchanged'
          : 'update',
  }
}
