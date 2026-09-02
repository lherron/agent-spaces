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
import type { Driver } from './drivers/driver'
import { createDefaultPiTuiTmuxDriver } from './drivers/pi-tui-tmux/driver'
import type { EventLedger } from './event-ledger'

export interface DefaultBrokerOptions {
  additionalDrivers?: Array<() => Driver> | undefined
  advertisedTransports?: BrokerTransportKind[] | undefined
  advertiseAttachReplay?: boolean | undefined
  eventLedger?: EventLedger | undefined
  /**
   * Directory the raw ingress journal and disposition index live in (T-07853
   * §7.1, §8.1) — beside the normalized ledger. ABSENT keeps capture in memory,
   * exactly as the ledger itself does.
   *
   * This MUST be forwarded. The durable unix broker is the only one that has a
   * ledger path, so it is the only one whose capture can be durable at all; if
   * this option is dropped here the CLI's `captureDir` reaches nothing, every
   * production seat commits its raw evidence to memory, and `replayPending`
   * has nothing to find after a restart — while every event still carries a
   * plausible-looking `rawRecordId` pointing at a journal that was never
   * written.
   */
  captureDir?: string | undefined
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
      createDefaultPiTuiTmuxDriver(options.hookIpcDir),
      ...(options.additionalDrivers?.map((createDriver) => createDriver()) ?? []),
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
    ...(options.captureDir !== undefined ? { captureDir: options.captureDir } : {}),
    ...(options.attachIdentity !== undefined ? { attachIdentity: options.attachIdentity } : {}),
    ...(options.brokerInstanceId !== undefined
      ? { brokerInstanceId: options.brokerInstanceId }
      : {}),
  })
}
