export type ParityRunMode = 'task' | 'query' | 'heartbeat' | 'maintenance'

export interface ParitySkill {
  name: string
  description: string
  disableModelInvocation: boolean
  filePath: `skill://${string}/SKILL.md`
}

export interface ProjectedFile {
  path: string
  kind: 'file' | 'directory' | 'symlink'
  executable?: boolean
  bytes?: Uint8Array
  target?: string
}

export interface ResourceProjection {
  agentId: string
  mode: ParityRunMode
  prompt: { mode: 'append' | 'replace'; content: Uint8Array }
  reminder: { present: boolean; content?: Uint8Array }
  skills: {
    catalog: ParitySkill[]
    catalogText: Uint8Array
    packages: Map<string, ProjectedFile[]>
  }
}

export interface ParityMismatch {
  agentId: string
  mode: ParityRunMode
  path: string
  message: string
}
