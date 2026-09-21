import { runBrokerCli } from 'spaces-harness-broker'

import {
  createAgentHarnessDriver,
  createAgentHarnessTmuxDriver,
} from '../../../harness/agent-harness/src/index.js'
import { embeddedReleaseIdentity } from './embedded-identity.js'

// This is deliberately not the package bin: a release worker must compile its
// complete first-party broker closure and report the identity frozen into this
// payload. Both first-party identities belong to this worker; the interactive
// factory reports unavailable until Earendil exposes the required embedded
// non-exiting TUI lifecycle.
await runBrokerCli({
  additionalDrivers: [createAgentHarnessDriver, createAgentHarnessTmuxDriver],
  releaseIdentity: embeddedReleaseIdentity,
  rendererLauncher: { command: process.execPath, args: ['renderer'] },
  codexTuiLauncher: { command: process.execPath },
  tmuxHelperLauncher: { command: process.execPath },
})
