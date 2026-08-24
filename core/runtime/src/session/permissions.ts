export interface PermissionRequest {
  toolName: string
  toolUseId: string
  input: unknown
  summary?: string
}

export interface PermissionResult {
  allowed: boolean
  modifiedInput?: unknown
  reason?: string
}

export interface PermissionHandler {
  requestPermission(request: PermissionRequest): Promise<PermissionResult>
  isAutoAllowed(toolName: string): boolean
}
