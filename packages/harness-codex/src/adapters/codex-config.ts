/**
 * Codex config.toml assembly: dotted-key override merging and base-config
 * construction (model defaults, MCP servers, status line, hooks feature flag).
 */
import type { McpConfig } from 'spaces-config'

const DEFAULT_SANDBOX_MODE = 'workspace-write'
const DEFAULT_APPROVAL_POLICY = 'on-request'
export const DEFAULT_CODEX_CLI_MODEL = 'gpt-5.6-terra'
export const DEFAULT_CODEX_REASONING_EFFORT = 'high'
const DEFAULT_TUI_STATUS_LINE = ['model-with-reasoning', 'context-remaining', 'current-dir']

function applyDottedKey(target: Record<string, unknown>, dottedKey: string, value: unknown): void {
  const parts = dottedKey.split('.').filter(Boolean)
  if (parts.length === 0) {
    return
  }

  let cursor: Record<string, unknown> = target
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] as string
    const existing = cursor[part]
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      cursor[part] = {}
    }
    cursor = cursor[part] as Record<string, unknown>
  }

  cursor[parts[parts.length - 1] as string] = value
}

function mergeCodexConfig(
  base: Record<string, unknown>,
  overrides: Array<Record<string, unknown>>
): Record<string, unknown> {
  const merged = { ...base }
  for (const override of overrides) {
    for (const [key, value] of Object.entries(override)) {
      applyDottedKey(merged, key, value)
    }
  }
  return merged
}

function ensureHooksFeature(config: Record<string, unknown>): Record<string, unknown> {
  const features =
    config['features'] &&
    typeof config['features'] === 'object' &&
    !Array.isArray(config['features'])
      ? { ...(config['features'] as Record<string, unknown>) }
      : {}

  features['hooks'] = true
  return {
    ...config,
    features,
  }
}

export function buildCodexConfig(
  mcpConfig: McpConfig,
  overrides: Array<Record<string, unknown>>
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    model: DEFAULT_CODEX_CLI_MODEL,
    model_reasoning_effort: DEFAULT_CODEX_REASONING_EFFORT,
    sandbox_mode: DEFAULT_SANDBOX_MODE,
    approval_policy: DEFAULT_APPROVAL_POLICY,
    project_doc_fallback_filenames: ['AGENTS.md', 'AGENT.md'],
    tui: {
      status_line: DEFAULT_TUI_STATUS_LINE,
    },
  }

  if (Object.keys(mcpConfig.mcpServers).length > 0) {
    const mcpServers: Record<string, unknown> = {}
    for (const [name, server] of Object.entries(mcpConfig.mcpServers)) {
      const entry: Record<string, unknown> = {
        command: server.command,
        enabled: true,
      }
      if (server.args && server.args.length > 0) {
        entry['args'] = server.args
      }
      if (server.env && Object.keys(server.env).length > 0) {
        entry['env'] = server.env
      }
      mcpServers[name] = entry
    }
    base['mcp_servers'] = mcpServers
  }

  return ensureHooksFeature(mergeCodexConfig(base, overrides))
}
