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
  /**
   * Runtime-scoped IPC directory (the durable broker's `--socket` parent →
   * `hooks/`). When supplied, the tmux drivers bind per-invocation hook sockets
   * under it instead of the global `tmpdir()/harness-broker` default — so two
   * durable broker runtimes never collide on a shared hook socket (T-01794
   * Phase D). Absent for stdio / in-process callers, which keep the tmpdir
   * default.
   */
  hookIpcDir?: string | undefined
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
      createDefaultClaudeCodeTmuxDriver(options.hookIpcDir),
      createDefaultCodexCliTmuxDriver(options.hookIpcDir),
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
