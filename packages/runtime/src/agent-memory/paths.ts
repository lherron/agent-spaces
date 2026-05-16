import { homedir } from 'node:os'
import { join } from 'node:path'

export const MEMORY_FILE = 'MEMORY.md'
export const USER_FILE = 'USER.md'
export const PERSONA_FILE = 'SOUL.md'

export type MemoryTargetName = 'memory' | 'user' | 'persona'

export type MemoryTargetScope = 'per-agent' | 'shared-editable'

export type MemoryTargetZone = 'reminder' | 'prompt'

export type MemoryScanCategory = 'prompt_injection' | 'exfil' | 'invisible_unicode' | 'delimiter'

export interface MemoryTargetConfig {
  path: string
  lockPath: string
  capChars: number
  scope: MemoryTargetScope
  zone: MemoryTargetZone
  scannerCategoriesToSkip: MemoryScanCategory[]
}

export function resolveMemoryPaths(
  agentName: string,
  rootOverride?: string
): Record<MemoryTargetName, MemoryTargetConfig> {
  const agentsRoot =
    rootOverride ?? process.env['ASP_AGENTS_ROOT'] ?? join(homedir(), 'praesidium', 'var', 'agents')

  const memoryPath = join(agentsRoot, agentName, 'memory', MEMORY_FILE)
  const userPath = join(agentsRoot, USER_FILE)
  const personaPath = join(agentsRoot, agentName, PERSONA_FILE)

  return {
    memory: {
      path: memoryPath,
      lockPath: `${memoryPath}.lock`,
      capChars: 2200,
      scope: 'per-agent',
      zone: 'reminder',
      scannerCategoriesToSkip: [],
    },
    user: {
      path: userPath,
      lockPath: `${userPath}.lock`,
      capChars: 1375,
      scope: 'shared-editable',
      zone: 'reminder',
      scannerCategoriesToSkip: [],
    },
    persona: {
      path: personaPath,
      lockPath: `${personaPath}.lock`,
      capChars: 8192,
      scope: 'per-agent',
      zone: 'prompt',
      scannerCategoriesToSkip: ['prompt_injection'],
    },
  }
}
