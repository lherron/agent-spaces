export type RuntimePlacement = {
  kind?: string | undefined
  root?: string | undefined
  targetName?: string | undefined
  targetDir?: string | undefined
  [key: string]: unknown
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
