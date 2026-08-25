import { createPiSdkDriver } from 'spaces-harness-broker-pi-sdk'

import { createResolvedAgentSession } from './invocation-session-factory.js'

/** Compose the generic Pi broker driver with the first-party ASP session factory. */
export function createAgentHarnessDriver() {
  return createPiSdkDriver({
    driverKind: 'agent-harness',
    createSession: createResolvedAgentSession,
  })
}
