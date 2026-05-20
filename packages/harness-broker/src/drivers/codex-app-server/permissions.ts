import type { CodexAppServerDriverSpec } from 'spaces-harness-broker-protocol'
import type { JsonRpcRequest } from './rpc-client'

export async function handlePermissionRequest(
  request: JsonRpcRequest,
  driver: CodexAppServerDriverSpec
): Promise<unknown> {
  const mode = driver.permissionPolicy?.mode ?? 'deny'
  if (mode === 'allow') {
    return { decision: 'approve' }
  }

  if (
    request.method === 'item/commandExecution/requestApproval' ||
    request.method === 'item/fileChange/requestApproval'
  ) {
    return { decision: 'decline' }
  }

  throw new Error(`Unhandled Codex app-server request: ${request.method}`)
}
