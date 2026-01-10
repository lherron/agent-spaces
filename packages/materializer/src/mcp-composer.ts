/**
 * MCP configuration composition.
 *
 * WHY: Spaces can declare MCP servers that should be available when
 * running Claude. We compose these into a single config file.
 */

import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDir } from '@agent-spaces/store'

/**
 * MCP server type - currently only "stdio" is supported.
 */
export type McpServerType = 'stdio'

/**
 * MCP server definition.
 */
export interface McpServerConfig {
  /** Server type - "stdio" for command-line MCP servers */
  type: McpServerType
  /** Command to run the server */
  command: string
  /** Arguments to pass */
  args?: string[] | undefined
  /** Environment variables */
  env?: Record<string, string> | undefined
}

/**
 * MCP configuration file structure.
 */
export interface McpConfig {
  /** Named MCP servers */
  mcpServers: Record<string, McpServerConfig>
}

/**
 * Read MCP config from a space directory.
 */
export async function readMcpConfig(dir: string): Promise<McpConfig | null> {
  const mcpDir = join(dir, 'mcp')
  const configPath = join(mcpDir, 'mcp.json')

  try {
    const stats = await stat(configPath)
    if (!stats.isFile()) {
      return null
    }
    const content = await readFile(configPath, 'utf-8')
    return JSON.parse(content) as McpConfig
  } catch {
    return null
  }
}

/**
 * Compose multiple MCP configs into one.
 * Later configs override earlier ones for the same server name.
 */
export function composeMcpConfigs(configs: McpConfig[]): McpConfig {
  const composed: McpConfig = {
    mcpServers: {},
  }

  for (const config of configs) {
    for (const [name, server] of Object.entries(config.mcpServers)) {
      composed.mcpServers[name] = server
    }
  }

  return composed
}

/**
 * Check for MCP server name collisions across configs.
 */
export function checkMcpCollisions(
  configs: Array<{ spaceId: string; config: McpConfig }>
): string[] {
  const serverOwners = new Map<string, string[]>()
  const collisions: string[] = []

  for (const { spaceId, config } of configs) {
    for (const serverName of Object.keys(config.mcpServers)) {
      const owners = serverOwners.get(serverName) ?? []
      owners.push(spaceId)
      serverOwners.set(serverName, owners)
    }
  }

  for (const [serverName, owners] of serverOwners) {
    if (owners.length > 1) {
      collisions.push(`MCP server '${serverName}' defined in multiple spaces: ${owners.join(', ')}`)
    }
  }

  return collisions
}

/**
 * Write composed MCP config to output path.
 */
export async function writeMcpConfig(config: McpConfig, outputPath: string): Promise<void> {
  await ensureDir(join(outputPath, '..'))
  await writeFile(outputPath, JSON.stringify(config, null, 2))
}

/**
 * Read MCP configs from multiple space directories.
 */
export async function readAllMcpConfigs(
  dirs: Array<{ spaceId: string; dir: string }>
): Promise<Array<{ spaceId: string; config: McpConfig }>> {
  const results: Array<{ spaceId: string; config: McpConfig }> = []

  for (const { spaceId, dir } of dirs) {
    const config = await readMcpConfig(dir)
    if (config !== null) {
      results.push({ spaceId, config })
    }
  }

  return results
}

/**
 * Compose MCP configs from space directories and write to output.
 */
export async function composeMcpFromSpaces(
  dirs: Array<{ spaceId: string; dir: string }>,
  outputPath: string
): Promise<{ config: McpConfig; warnings: string[] }> {
  const configs = await readAllMcpConfigs(dirs)
  const warnings = checkMcpCollisions(configs)
  const composed = composeMcpConfigs(configs.map((c) => c.config))

  if (Object.keys(composed.mcpServers).length > 0) {
    await writeMcpConfig(composed, outputPath)
  }

  return { config: composed, warnings }
}
