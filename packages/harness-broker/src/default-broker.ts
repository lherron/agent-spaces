import type {
  BrokerTransportKind,
  InvocationEventEnvelope,
  PermissionDecision,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import { createBroker } from './broker'
import { createDefaultClaudeCodeTmuxDriver } from './drivers/claude-code-tmux/driver'
import { createCodexAppServerDriver } from './drivers/codex-app-server/driver'
import { createDefaultCodexCliTmuxDriver } from './drivers/codex-cli-tmux/driver'

export interface DefaultBrokerOptions {
  advertisedTransports?: BrokerTransportKind[] | undefined
  advertiseAttachReplay?: boolean | undefined
}

export function createDefaultBroker(
  onEvent?: ((event: InvocationEventEnvelope) => void) | undefined,
  onPermissionRequest?:
    | ((params: PermissionRequestParams) => Promise<PermissionDecision>)
    | undefined,
  options: DefaultBrokerOptions = {}
) {
  return createBroker({
    drivers: [
      createCodexAppServerDriver(),
      createDefaultClaudeCodeTmuxDriver(),
      createDefaultCodexCliTmuxDriver(),
    ],
    ...(onEvent !== undefined ? { onEvent } : {}),
    ...(onPermissionRequest !== undefined ? { onPermissionRequest } : {}),
    ...(options.advertisedTransports !== undefined
      ? { advertisedTransports: options.advertisedTransports }
      : {}),
    ...(options.advertiseAttachReplay !== undefined
      ? { advertiseAttachReplay: options.advertiseAttachReplay }
      : {}),
  })
}
