export type AgentchatExposurePolicy =
  | { mode: 'none' }
  | { mode: 'hrc-registers-target'; targetKind: 'broker-runtime' }
  | { mode: 'broker-reports-target'; targetKind: string }

export type BrokerTerminalSurface = {
  host: 'tmux'
  startupMethod: 'create-terminal' | 'reuse-existing' | 'adopt-terminal'
  turnDelivery: 'terminal-literal-input'
  operatorAttach: true
  exposurePolicy: { mode: 'broker-reports-target'; targetKind: 'tmux-session' }
}

export type { BrokerTerminalSurfaceReport } from 'spaces-harness-broker-protocol'
