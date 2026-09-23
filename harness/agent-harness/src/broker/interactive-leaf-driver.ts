import { AGENT_HARNESS_TMUX_DRIVER_KIND } from './interactive-driver.js'
import { createResidentLeafDriver } from './resident-leaf-driver.js'

/** HRC's agent-harness-tmux child: the resident leaf with exit-on-quit. */
export function createAgentHarnessTmuxLeafDriver() {
  return createResidentLeafDriver({ driverKind: AGENT_HARNESS_TMUX_DRIVER_KIND })
}
