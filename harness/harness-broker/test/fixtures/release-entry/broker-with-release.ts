// Test entry standing in for the release entrypoint (scripts/asp-release/entries):
// runs the real broker CLI with a compiled-in-style release identity.
import { runBrokerCli } from '../../../src/cli'

await runBrokerCli({
  releaseIdentity: {
    releaseId: 'asp-0123456789ab-20260916T120000Z-abcdef',
    sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    builtAt: '2026-09-16T12:00:00.000Z',
  },
})
