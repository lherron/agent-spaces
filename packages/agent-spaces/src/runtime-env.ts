import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

// ---------------------------------------------------------------------------
// SOUL.md materialization
// ---------------------------------------------------------------------------

/**
 * Materialize SOUL.md (and HEARTBEAT.md for heartbeat mode) into a base plugin
 * directory so the agent's identity instructions are included in the harness invocation.
 */
export function materializeSoulMd(outputPath: string, placement: RuntimePlacement): void {
  if (!placement.agentRoot) return

  const soulPath = join(placement.agentRoot, 'SOUL.md')
  if (!existsSync(soulPath)) return

  const pluginsDir = join(outputPath, 'plugins')
  const soulPluginDir = join(pluginsDir, '000-soul')
  mkdirSync(soulPluginDir, { recursive: true })

  let content = readFileSync(soulPath, 'utf8')
  if (placement.runMode === 'heartbeat') {
    const heartbeatPath = join(placement.agentRoot, 'HEARTBEAT.md')
    if (existsSync(heartbeatPath)) {
      content += `\n\n---\n\n${readFileSync(heartbeatPath, 'utf8')}`
    }
  }
  writeFileSync(join(soulPluginDir, 'CLAUDE.md'), content, 'utf8')
}
