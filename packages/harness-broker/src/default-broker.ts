import type {
  BrokerTransportKind,
  InvocationEventEnvelope,
  PermissionDecision,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import { type BrokerAttachIdentity, createBroker } from './broker'
import { createDefaultClaudeCodeTmuxDriver } from './drivers/claude-code-tmux/driver'
import { createCodexAppServerDriver } from './drivers/codex-app-server/driver'
import { createDefaultCodexCliTmuxDriver } from './drivers/codex-cli-tmux/driver'
import type { EventLedger } from './event-ledger'

export interface DefaultBrokerOptions {
  advertisedTransports?: BrokerTransportKind[] | undefined
  advertiseAttachReplay?: boolean | undefined
  eventLedger?: EventLedger | undefined
  attachIdentity?: BrokerAttachIdentity | undefined
  brokerInstanceId?: string | undefined
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
    ...(options.eventLedger !== undefined ? { eventLedger: options.eventLedger } : {}),
    ...(options.attachIdentity !== undefined ? { attachIdentity: options.attachIdentity } : {}),
    ...(options.brokerInstanceId !== undefined
      ? { brokerInstanceId: options.brokerInstanceId }
      : {}),
  })
}
