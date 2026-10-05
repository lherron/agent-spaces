/**
 * Embedded content for the agent-spaces-manager space.
 *
 * WHY: This allows repo init to install the manager space without
 * needing to access external files. The manager space is bundled
 * into the CLI package.
 */

import { MANAGER_AGENT } from './manager-space/agents/manager'
import { ADD_COMMAND_COMMAND } from './manager-space/commands/add-command'
import { ADD_HOOK_COMMAND } from './manager-space/commands/add-hook'
import { ADD_SKILL_COMMAND } from './manager-space/commands/add-skill'
import { BUMP_VERSION_COMMAND } from './manager-space/commands/bump-version'
import { CREATE_SPACE_COMMAND } from './manager-space/commands/create-space'
import { HELP_COMMAND } from './manager-space/commands/help'
import { PUBLISH_COMMAND } from './manager-space/commands/publish'
import { UPDATE_PROJECT_TARGETS_COMMAND } from './manager-space/commands/update-project-targets'
import { SPACE_AUTHORING_SKILL } from './manager-space/skills/space-authoring'
import { SPACE_TOML } from './manager-space/space-toml'

export const MANAGER_SPACE_ID = 'agent-spaces-manager'
export const MANAGER_SPACE_VERSION = '1.0.0'

export interface SpaceFile {
  path: string
  content: string
}

/**
 * Get all files for the manager space.
 * Files are returned with paths relative to spaces/agent-spaces-manager/
 */
export function getManagerSpaceFiles(): SpaceFile[] {
  return [
    SPACE_TOML,
    HELP_COMMAND,
    CREATE_SPACE_COMMAND,
    ADD_COMMAND_COMMAND,
    ADD_SKILL_COMMAND,
    ADD_HOOK_COMMAND,
    BUMP_VERSION_COMMAND,
    PUBLISH_COMMAND,
    UPDATE_PROJECT_TARGETS_COMMAND,
    SPACE_AUTHORING_SKILL,
    MANAGER_AGENT,
  ]
}
