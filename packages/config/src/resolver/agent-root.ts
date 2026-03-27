import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseAgentProfile } from '../core/config/agent-profile-toml.js'
import type { AgentRuntimeProfile } from '../core/types/agent-profile.js'

export interface ValidatedAgentRoot {
  valid: true
  soulMd: string
  heartbeatMd?: string | undefined
  profile?: AgentRuntimeProfile | undefined
}

export function validateAgentRoot(agentRoot: string): ValidatedAgentRoot {
  const soulPath = join(agentRoot, 'SOUL.md')
  if (!existsSync(soulPath)) {
    throw new Error(`SOUL.md is required in agent root: ${agentRoot}`)
  }

  const heartbeatPath = join(agentRoot, 'HEARTBEAT.md')
  const profilePath = join(agentRoot, 'agent-profile.toml')

  return {
    valid: true,
    soulMd: readFileSync(soulPath, 'utf8'),
    heartbeatMd: existsSync(heartbeatPath) ? readFileSync(heartbeatPath, 'utf8') : undefined,
    profile: existsSync(profilePath)
      ? parseAgentProfile(readFileSync(profilePath, 'utf8'), profilePath)
      : undefined,
  }
}
