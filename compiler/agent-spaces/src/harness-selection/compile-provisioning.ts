import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  type RuntimePlacement,
  parseAgentProfile,
  parseTargetsToml,
  toSelectionLayers,
} from 'spaces-config'
import type { CompileDiagnostic, RuntimeCompileRequest } from 'spaces-runtime-contracts'

import type { ProvisioningLayers } from './types.js'

export type CompileProvisioningFailureCode =
  | 'agent_profile_invalid'
  | 'project_targets_invalid'
  | 'source_read_unavailable'

export class CompileProvisioningError extends Error {
  readonly code: CompileProvisioningFailureCode
  readonly details: Record<string, unknown>

  constructor(
    code: CompileProvisioningFailureCode,
    message: string,
    details: Record<string, unknown>
  ) {
    super(message)
    this.name = 'CompileProvisioningError'
    this.code = code
    this.details = details
  }
}

function readOptionalSource(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new CompileProvisioningError(
      'source_read_unavailable',
      `Unable to read provisioning source ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { path }
    )
  }
}

/**
 * Load producer-owned selection layers from the compile subject's placement.
 * This function translates spelling only; defaults, compatibility, recipes,
 * and drivers remain the sole responsibility of the central resolver/catalog.
 */
export function resolveCompileSources(request: RuntimeCompileRequest): {
  provisioningLayers: ProvisioningLayers
  sessionMetadata: Record<
    string,
    string | number | boolean | null | (string | number | boolean | null)[]
  >
  metadataDiagnostics: CompileDiagnostic[]
} {
  const placement = request.placement as RuntimeCompileRequest['placement'] & RuntimePlacement
  const profilePath = join(placement.agentRoot, 'agent-profile.toml')
  const profileSource = readOptionalSource(profilePath) ?? 'version = 4\n'
  let profile: ReturnType<typeof parseAgentProfile>
  try {
    profile = parseAgentProfile(profileSource, profilePath)
  } catch (error) {
    throw new CompileProvisioningError(
      'agent_profile_invalid',
      `Invalid agent profile ${profilePath}: ${error instanceof Error ? error.message : String(error)}`,
      { path: profilePath }
    )
  }

  let targetMetadata: Record<string, unknown> | undefined
  let targetProvisioning: Parameters<typeof toSelectionLayers>[1]
  if (placement.bundle.kind === 'agent-project' && placement.bundle.projectRoot !== undefined) {
    const targetsPath = join(placement.bundle.projectRoot, 'asp-targets.toml')
    const targetsSource = readOptionalSource(targetsPath)
    if (targetsSource !== undefined) {
      try {
        const target = parseTargetsToml(targetsSource, targetsPath).targets[
          placement.bundle.agentName
        ]
        targetProvisioning = target?.provisioning
        targetMetadata = target?.session?.metadata
      } catch (error) {
        throw new CompileProvisioningError(
          'project_targets_invalid',
          `Invalid project targets ${targetsPath}: ${error instanceof Error ? error.message : String(error)}`,
          { path: targetsPath }
        )
      }
    }
  }

  return {
    provisioningLayers: toSelectionLayers(
      profile.provisioning,
      targetProvisioning,
      request.selectionContext?.summonDirectives
    ),
    ...layerSessionMetadata(profile.session?.metadata, targetMetadata),
  }
}

/** Cosmetic launch declarations are independent of immutable plan identity. */
function layerSessionMetadata(profile?: Record<string, unknown>, target?: Record<string, unknown>) {
  const leaves: Record<string, unknown> = Object.create(null)
  function flatten(value: Record<string, unknown>, prefix = '') {
    for (const [key, leaf] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (
        leaf !== null &&
        typeof leaf === 'object' &&
        !Array.isArray(leaf) &&
        Object.getPrototypeOf(leaf) === Object.prototype
      )
        flatten(leaf as Record<string, unknown>, path)
      else leaves[path] = leaf
    }
  }
  flatten(profile ?? {})
  flatten(target ?? {})
  const sessionMetadata: Record<
    string,
    string | number | boolean | null | (string | number | boolean | null)[]
  > = Object.create(null)
  const metadataDiagnostics: CompileDiagnostic[] = []
  const scalar = (v: unknown) =>
    v === null ||
    typeof v === 'string' ||
    typeof v === 'boolean' ||
    (typeof v === 'number' && Number.isFinite(v))
  for (const [key, value] of Object.entries(leaves)) {
    let reason: string | undefined
    if (
      !/^[a-z][a-zA-Z0-9]{0,63}(\.[a-z][a-zA-Z0-9]{0,63}){0,3}$/.test(key) ||
      Buffer.byteLength(key) > 128
    )
      reason = 'invalid metadata key'
    else if (!scalar(value) && !(Array.isArray(value) && value.every(scalar)))
      reason = 'value must be a JSON scalar or array of scalars'
    else if (Buffer.byteLength(JSON.stringify(value)) > 4096) reason = 'value exceeds 4096 bytes'
    else if (
      Object.keys(sessionMetadata).some(
        (existing) => existing.startsWith(`${key}.`) || key.startsWith(`${existing}.`)
      )
    )
      reason = 'metadata prefix collision'
    else if (Object.keys(sessionMetadata).length >= 64) reason = 'metadata exceeds 64 keys'
    if (reason !== undefined)
      metadataDiagnostics.push({
        level: 'warning',
        code: 'session_metadata_rejected',
        message: `${key}: ${reason}`,
        plane: 'asp-compiler',
      })
    else sessionMetadata[key] = value as (typeof sessionMetadata)[string]
  }
  return { sessionMetadata, metadataDiagnostics }
}

export function resolveCompileProvisioningLayers(
  request: RuntimeCompileRequest
): ProvisioningLayers {
  return resolveCompileSources(request).provisioningLayers
}
