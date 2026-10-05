import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * A muse workspace keeps its config either under `muse.workspace/` or at the
 * workspace root; the nested layout wins when both exist.
 */
function workspaceCandidates(workspace: string, entry: string): string[] {
  return [join(workspace, 'muse.workspace', entry), join(workspace, entry)]
}

/** The workspace skills directory to seed the isolated HOME with, if any. */
export async function findMuseWorkspaceSkillsDir(
  workspace: string | undefined
): Promise<string | undefined> {
  if (!workspace) return undefined
  for (const candidate of workspaceCandidates(workspace, 'skills')) {
    try {
      if ((await stat(candidate)).isDirectory()) return candidate
    } catch {
      // Try the next candidate path.
    }
  }
  return undefined
}

/** The workspace's `mcpServers` settings block, forwarded on session/start. */
export async function readMuseWorkspaceMcpServers(
  workspace: string | undefined
): Promise<Record<string, unknown> | undefined> {
  if (!workspace) return undefined
  for (const candidate of workspaceCandidates(workspace, 'settings.json')) {
    try {
      const parsed = JSON.parse(await readFile(candidate, 'utf-8')) as Record<string, unknown>
      const servers = (parsed as { mcpServers?: Record<string, unknown> }).mcpServers
      if (servers && typeof servers === 'object') return servers
    } catch {
      // Try the next candidate path.
    }
  }
  return undefined
}
