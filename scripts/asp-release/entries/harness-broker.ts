import { embeddedReleaseIdentity } from './embedded-identity.js'

if (process.argv[2] === 'evidence-read') {
  // Keep the read-only release mode out of the worker/driver module graph at
  // runtime. It only opens the explicit retained files supplied by HRC.
  const { runOfflineEvidenceCli } = await import(
    '../../../harness/harness-broker/src/offline-evidence.js'
  )
  await runOfflineEvidenceCli(process.argv.slice(3), embeddedReleaseIdentity)
} else {
  // Release entrypoint: bypass the checkout-friendly source/dist probe in the
  // package bin and compile the broker implementation plus dependency closure.
  const { runBrokerCli } = await import('../../../harness/harness-broker/src/cli.js')

  // T-08554: the viewer renderer runs from this same compiled payload.
  // T-08556: so do the interactive codex-tui wrapper and the codex hook receiver.
  await runBrokerCli({
    releaseIdentity: embeddedReleaseIdentity,
    rendererLauncher: { command: process.execPath, args: ['renderer'] },
    codexTuiLauncher: { command: process.execPath },
    tmuxHelperLauncher: { command: process.execPath },
  })
}
