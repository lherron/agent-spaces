/**
 * Human-readable text formatting for explain output.
 */

import type { ComposedContent, ExplainResult, SpaceInfo, TargetExplanation } from './types.js'

/** Short commit prefix length shown in text output. */
const COMMIT_SHORT_LEN = 12

/** Short env-hash prefix length shown in text output. */
const ENV_HASH_SHORT_LEN = 16

/** Maximum env value length before truncation in text output. */
const ENV_VALUE_MAX = 30

/**
 * Format a single space for text output.
 */
function formatSpaceText(space: SpaceInfo, lines: string[]): void {
  const version = space.pluginVersion ? `@${space.pluginVersion}` : ''
  const storeStatus = space.inStore ? '' : ' [NOT IN STORE]'
  lines.push(`    ${space.pluginName}${version}${storeStatus}`)
  lines.push(`      Key: ${space.key}`)
  lines.push(`      Commit: ${space.commit.slice(0, COMMIT_SHORT_LEN)}`)
  if (space.resolvedFrom?.selector) {
    lines.push(`      Selector: ${space.resolvedFrom.selector}`)
  }
  if (space.deps.length > 0) {
    lines.push(`      Deps: ${space.deps.join(', ')}`)
  }

  // Show content from this space
  if (space.content?.components.length) {
    lines.push(`      Components: ${space.content.components.join(', ')}`)
  }
  if (space.hooks?.length) {
    lines.push(`      Hooks: ${space.hooks.map((h) => h.event).join(', ')}`)
  }
  if (space.mcpServers && Object.keys(space.mcpServers).length > 0) {
    lines.push(`      MCP servers: ${Object.keys(space.mcpServers).join(', ')}`)
  }
  if (space.settings) {
    const parts: string[] = []
    if (space.settings.allow?.length) parts.push(`allow[${space.settings.allow.length}]`)
    if (space.settings.deny?.length) parts.push(`deny[${space.settings.deny.length}]`)
    if (space.settings.env && Object.keys(space.settings.env).length > 0) {
      parts.push(`env[${Object.keys(space.settings.env).length}]`)
    }
    if (space.settings.model) parts.push(`model=${space.settings.model}`)
    if (parts.length > 0) {
      lines.push(`      Settings: ${parts.join(', ')}`)
    }
  }
}

/**
 * Format composed content summary.
 */
function formatComposedText(composed: ComposedContent, lines: string[]): void {
  lines.push('  Composed content:')

  // Commands
  if (composed.commands.length > 0) {
    lines.push(`    Commands (${composed.commands.length}):`)
    for (const cmd of composed.commands) {
      lines.push(`      /${cmd.name} (from ${cmd.space})`)
    }
  }

  // Skills
  if (composed.skills.length > 0) {
    lines.push(`    Skills (${composed.skills.length}):`)
    for (const skill of composed.skills) {
      lines.push(`      ${skill.name} (from ${skill.space})`)
    }
  }

  // Agents
  if (composed.agents.length > 0) {
    lines.push(`    Agents (${composed.agents.length}):`)
    for (const agent of composed.agents) {
      lines.push(`      ${agent.name} (from ${agent.space})`)
    }
  }

  // Hooks
  if (composed.hooks.length > 0) {
    lines.push(`    Hooks (${composed.hooks.length}):`)
    for (const { space, hook } of composed.hooks) {
      const countInfo = hook.count > 1 ? ` (${hook.count} handlers)` : ''
      lines.push(`      ${hook.event}${countInfo} (from ${space})`)
    }
  }

  // MCP Servers
  const mcpEntries = Object.entries(composed.mcpServers)
  if (mcpEntries.length > 0) {
    lines.push(`    MCP servers (${mcpEntries.length}):`)
    for (const [name, { space, config }] of mcpEntries) {
      lines.push(`      ${name}: ${config.command} (from ${space})`)
    }
  }

  // Settings
  const hasSettings =
    composed.settings.allow.length > 0 ||
    composed.settings.deny.length > 0 ||
    Object.keys(composed.settings.env).length > 0 ||
    composed.settings.model

  if (hasSettings) {
    lines.push('    Settings:')

    if (composed.settings.allow.length > 0) {
      lines.push(`      Allow rules (${composed.settings.allow.length}):`)
      for (const { space, rule } of composed.settings.allow) {
        lines.push(`        ${rule} (from ${space})`)
      }
    }

    if (composed.settings.deny.length > 0) {
      lines.push(`      Deny rules (${composed.settings.deny.length}):`)
      for (const { space, rule } of composed.settings.deny) {
        lines.push(`        ${rule} (from ${space})`)
      }
    }

    const envEntries = Object.entries(composed.settings.env)
    if (envEntries.length > 0) {
      lines.push(`      Environment (${envEntries.length}):`)
      for (const [key, { space, value }] of envEntries) {
        // Truncate long values
        const displayValue =
          value.length > ENV_VALUE_MAX ? `${value.slice(0, ENV_VALUE_MAX)}...` : value
        lines.push(`        ${key}=${displayValue} (from ${space})`)
      }
    }

    if (composed.settings.model) {
      lines.push(
        `      Model: ${composed.settings.model.value} (from ${composed.settings.model.space})`
      )
    }
  }
}

/**
 * Format a single target for text output.
 */
function formatTargetText(name: string, target: TargetExplanation, lines: string[]): void {
  lines.push(`Target: ${name}`)
  lines.push(`  Compose: ${target.compose.join(', ')}`)
  lines.push(`  Env hash: ${target.envHash.slice(0, ENV_HASH_SHORT_LEN)}...`)
  lines.push('')
  lines.push('  Load order:')

  for (const space of target.spaces) {
    formatSpaceText(space, lines)
  }

  // Show composed content
  lines.push('')
  formatComposedText(target.composed, lines)

  if (target.warnings.length > 0) {
    lines.push('')
    lines.push('  Warnings:')
    for (const warning of target.warnings) {
      lines.push(`    [${warning.code}] ${warning.message}`)
    }
  }

  lines.push('')
}

/**
 * Format explanation as human-readable text.
 */
export function formatExplainText(result: ExplainResult): string {
  const lines: string[] = []

  lines.push(`Registry: ${result.registryUrl}`)
  lines.push(`Lock version: ${result.lockVersion}`)
  lines.push(`Generated: ${result.generatedAt}`)
  lines.push('')

  for (const [name, target] of Object.entries(result.targets)) {
    formatTargetText(name, target, lines)
  }

  return lines.join('\n')
}

/**
 * Format explanation as JSON.
 */
export function formatExplainJson(result: ExplainResult): string {
  return JSON.stringify(result, null, 2)
}
