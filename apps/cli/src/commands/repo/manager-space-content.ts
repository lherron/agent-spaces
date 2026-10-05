/**
 * Embedded content for the agent-spaces-manager space.
 *
 * WHY: `asp repo init` installs the manager space onto a shared spaces root,
 * and the published CLI ships dist/ only, so the content is bundled here. The
 * file list is generated from the canonical `<agents-root>/spaces/
 * agent-spaces-manager` by `just sync-manager-space` (T-10369).
 */

import { MANAGER_SPACE_FILES } from './manager-space/files.generated'

export const MANAGER_SPACE_ID = 'agent-spaces-manager'

export interface SpaceFile {
  path: string
  content: string
  /** Written with mode 0755 (hook scripts) */
  executable?: boolean | undefined
}

/**
 * Get all files for the manager space.
 * Files are returned with paths relative to spaces/agent-spaces-manager/
 */
export function getManagerSpaceFiles(): SpaceFile[] {
  return MANAGER_SPACE_FILES
}
