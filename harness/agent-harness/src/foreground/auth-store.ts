import { homedir } from 'node:os'
import { join } from 'node:path'

/** Resolve the local Pi credential store required by foreground OAuth sessions. */
export function resolveForegroundAuthStorePath(environment: NodeJS.ProcessEnv): string {
  const explicitStore = environment['HARNESS_PI_AUTH_STORE']
  if (explicitStore !== undefined && explicitStore.trim().length > 0) return explicitStore

  const agentDirectory = environment['PI_CODING_AGENT_DIR']
  if (agentDirectory !== undefined && agentDirectory.trim().length > 0)
    return join(agentDirectory, 'auth.json')

  return join(homedir(), '.pi', 'agent', 'auth.json')
}
