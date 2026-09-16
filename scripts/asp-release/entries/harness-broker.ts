// Release entrypoint: bypass the checkout-friendly source/dist probe in the
// package bin and compile the broker implementation plus dependency closure.
import { runBrokerCli } from '../../../harness/harness-broker/src/cli.js'
import { embeddedReleaseIdentity } from './embedded-identity.js'

// T-08554: the viewer renderer runs from this same compiled payload.
await runBrokerCli({
  releaseIdentity: embeddedReleaseIdentity,
  rendererLauncher: { command: process.execPath, args: ['renderer'] },
})
