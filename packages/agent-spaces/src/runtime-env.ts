import { createHash } from 'node:crypto'
import { join } from 'node:path'

import type { RuntimePlacement } from 'spaces-config'

// ---------------------------------------------------------------------------
// Environment overlay helpers
// ---------------------------------------------------------------------------

export function applyEnvOverlay(env: Record<string, string>): () => void {
  const prior = new Map<string, string | undefined>()

  for (const [key, value] of Object.entries(env)) {
    prior.set(key, process.env[key])
    process.env[key] = value
  }

  return () => {
    for (const [key, value] of prior.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

export async function withAspHome<T>(aspHome: string, fn: () => Promise<T>): Promise<T> {
  const restore = applyEnvOverlay({ ASP_HOME: aspHome })
  try {
    return await fn()
  } finally {
    restore()
  }
}

// ---------------------------------------------------------------------------
// Session path helpers
// ---------------------------------------------------------------------------

export function piSessionPath(aspHome: string, hostSessionId: string): string {
  const hash = createHash('sha256')
  hash.update(hostSessionId)
  return join(aspHome, 'sessions', 'pi', hash.digest('hex'))
}

export function resolveHostSessionId(
  input: {
    hostSessionId?: string | undefined
    cpSessionId?: string | undefined
    placement?: RuntimePlacement | undefined
  },
  required = true
): string | undefined {
  const hostSessionId =
    input.hostSessionId ?? input.cpSessionId ?? input.placement?.correlation?.hostSessionId
  if (!hostSessionId && required) {
    throw new Error('hostSessionId is required')
  }
  return hostSessionId
}

export function resolveRunId(input: {
  runId?: string | undefined
  placement?: RuntimePlacement | undefined
}): string | undefined {
  return input.runId ?? input.placement?.correlation?.runId
}

// materializeSystemPrompt is now in spaces-runtime for shared use by both
// agent-spaces client and execution CLI paths.
