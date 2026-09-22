export { dispatchAgentHarness, isTuiChild, runAgentHarness } from './cli.js'
export type { AgentHarnessCliDependencies, ForegroundInvocation } from './cli.js'
export { createAgentHarnessDriver } from './broker/driver.js'
export {
  AGENT_HARNESS_TMUX_DRIVER_KIND,
  createAgentHarnessTmuxDriver,
} from './broker/interactive-driver.js'
export type { AgentHarnessTmuxDriverOptions } from './broker/interactive-driver.js'
export { createAgentHarnessTmuxLeafDriver } from './broker/interactive-leaf-driver.js'
export {
  createResolvedAgentSession,
  resolvedAgentSessionRuntime,
  runtimeBackedPiSdkSession,
} from './broker/invocation-session-factory.js'
export { runAgentHarnessPrint } from './foreground/print.js'
export { runAgentHarnessTui } from './foreground/tui.js'
export {
  createResidentDetachControl,
  type ResidentDetachControl,
  type ResidentDetachReason,
} from './resident-detach.js'
export {
  createResidentApprovalControl,
  createResidentSurfaceController,
  type ResidentApprovalControl,
  type ResidentApprovalDecision,
  type ResidentApprovalPending,
  type ResidentSurfaceController,
  type ResidentSurfaceControllerOptions,
  type ResidentSurfaceIdentity,
  type ResidentSurfaceObservation,
  type ResidentSurfaceSnapshot,
  type ResidentSurfaceTransport,
} from './resident-controller.js'
export { loadAgent, createSession } from 'agent-harness-runtime'
