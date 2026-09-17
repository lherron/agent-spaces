// Release entrypoint: the ordinary broker composition plus the in-process Pi
// SDK driver. It remains a distinct worker so the stock worker does not absorb
// the Pi SDK/session dependency closure.
import { createPiSdkDriver } from '../../../harness/harness-broker-pi-sdk/src/driver.js'
import { runBrokerCli } from '../../../harness/harness-broker/src/cli.js'
import { embeddedReleaseIdentity } from './embedded-identity.js'

await runBrokerCli({
  additionalDrivers: [createPiSdkDriver],
  releaseIdentity: embeddedReleaseIdentity,
  rendererLauncher: { command: process.execPath, args: ['renderer'] },
  codexTuiLauncher: { command: process.execPath },
  tmuxHelperLauncher: { command: process.execPath },
})
