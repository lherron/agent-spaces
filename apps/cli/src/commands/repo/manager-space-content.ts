/**
 * Embedded content for the agent-spaces-manager space.
 *
 * WHY: `asp repo init` installs the manager space onto a shared spaces root,
 * and the published CLI ships dist/ only, so the content is bundled here.
 */

import { MANAGER_AGENT } from './manager-space/agents/manager'
import { ADD_COMMAND_COMMAND } from './manager-space/commands/add-command'
import { ADD_HOOK_COMMAND } from './manager-space/commands/add-hook'
import { ADD_SKILL_COMMAND } from './manager-space/commands/add-skill'
import { CREATE_SPACE_COMMAND } from './manager-space/commands/create-space'
import { HELP_COMMAND } from './manager-space/commands/help'
import { UPDATE_PROJECT_TARGETS_COMMAND } from './manager-space/commands/update-project-targets'
import { SPACE_AUTHORING_SKILL } from './manager-space/skills/space-authoring'
import { SPACE_TOML } from './manager-space/space-toml'

export const MANAGER_SPACE_ID = 'agent-spaces-manager'

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
    UPDATE_PROJECT_TARGETS_COMMAND,
    SPACE_AUTHORING_SKILL,
    MANAGER_AGENT,
  ]
}
