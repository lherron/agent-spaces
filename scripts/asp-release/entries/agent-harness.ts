import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'
import { runBrokerCli } from 'spaces-harness-broker'

import {
  createAgentHarnessDriver,
  createAgentHarnessTmuxDriver,
  createAgentHarnessTmuxLeafDriver,
  isTuiChild,
} from '../../../harness/agent-harness/src/index.js'
import { embeddedReleaseIdentity } from './embedded-identity.js'

const tuiChild = isTuiChild(process.argv.slice(2))

// pi-ai intentionally loads OAuth flows through variable imports in ordinary
// Node/Bun execution. A standalone Bun binary has no adjacent module files, so
// bind the statically bundled loaders before either worker role creates Pi.
registerBunOAuthFlows()

// The outer worker and its TUI child are the same immutable payload. The role
// flag selects only the worker-local driver set; both sides speak the standard
// harness-broker protocol and report the same embedded release identity.
await runBrokerCli({
  additionalDrivers: tuiChild
    ? [createAgentHarnessTmuxLeafDriver]
    : [
        createAgentHarnessDriver,
        () =>
          createAgentHarnessTmuxDriver({
            childLauncher: { command: process.execPath },
            releaseIdentity: embeddedReleaseIdentity,
          }),
      ],
  releaseIdentity: embeddedReleaseIdentity,
  rendererLauncher: { command: process.execPath, args: ['renderer'] },
  codexTuiLauncher: { command: process.execPath },
  tmuxHelperLauncher: { command: process.execPath },
})
