export type RunMode = 'query' | 'heartbeat' | 'task' | 'maintenance'
export interface RunScaffoldPacket {
  slot: string
  content?: string | undefined
  ref?: string | undefined
  contentType?: 'markdown' | 'json' | 'text' | undefined
  version?: string | undefined
}
export type RuntimeBundleRef =
  | { kind: 'agent-project'; agentName: string; projectRoot?: string | undefined }
  | { kind: 'compose'; compose: `space:${string}@${string}`[] }
export interface HostCorrelation {
  hostSessionId?: string | undefined
  runId?: string | undefined
  generation?: number | undefined
  sessionRef?: { scopeRef: string; laneRef: string } | undefined
}
export type RuntimePlacement = {
  kind?: string | undefined
  root?: string | undefined
  targetName?: string | undefined
  targetDir?: string | undefined
  [key: string]: unknown
}
export interface ResolvedInstruction {
  slot: string
  ref: string
  contentHash: string
}
export interface ResolvedSpace {
  ref: string
  resolvedKey: string
  integrity: string
}
export type ResolvedRuntimeBundle = {
  bundleIdentity: string
  root?: string | undefined
  lockHash?: string | undefined
  targetName?: string | undefined
  targetDir?: string | undefined
  [key: string]: unknown
}
export type AttachmentRef =
  | { kind: 'local-file'; path: string; mimeType?: string | undefined }
  | { kind: 'image'; path: string; mimeType?: string | undefined }
  | { kind: 'opaque'; ref: string; mimeType?: string | undefined }

export type HrcTaskContext = {
  taskId: string
  phase: string | null
  role: string
  requiredEvidenceKinds: string[]
  hintsText: string
}
