import { detectAgentLocalComponents, prepareAgentToolRuntime } from 'spaces-execution'
import { loadAgentSemantics } from 'spaces-runtime'
import type { LoadAgentOptions, ResolvedAgent } from './types.js'

/**
 * Direct first-party worker facade for the shared semantic preparation seam.
 * The lower-layer implementation resolves ASP sources, model, and prompt but
 * never discovers a Pi executable, builds argv, or materializes a harness home.
 */
export async function loadAgent(options: LoadAgentOptions): Promise<ResolvedAgent> {
  return loadAgentSemantics(options, {
    detectAgentLocalComponents,
    prepareAgentToolRuntime,
  })
}
