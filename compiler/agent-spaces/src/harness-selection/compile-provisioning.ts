import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  type RuntimePlacement,
  parseAgentProfile,
  parseTargetsToml,
  toSelectionLayers,
} from 'spaces-config'
import type { RuntimeCompileRequest } from 'spaces-runtime-contracts'

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
export function resolveCompileProvisioningLayers(
  request: RuntimeCompileRequest
): ProvisioningLayers {
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

  let targetProvisioning: Parameters<typeof toSelectionLayers>[1]
  if (placement.bundle.kind === 'agent-project' && placement.bundle.projectRoot !== undefined) {
    const targetsPath = join(placement.bundle.projectRoot, 'asp-targets.toml')
    const targetsSource = readOptionalSource(targetsPath)
    if (targetsSource !== undefined) {
      try {
        targetProvisioning = parseTargetsToml(targetsSource, targetsPath).targets[
          placement.bundle.agentName
        ]?.provisioning
      } catch (error) {
        throw new CompileProvisioningError(
          'project_targets_invalid',
          `Invalid project targets ${targetsPath}: ${error instanceof Error ? error.message : String(error)}`,
          { path: targetsPath }
        )
      }
    }
  }

  return toSelectionLayers(
    profile.provisioning,
    targetProvisioning,
    request.selectionContext?.summonDirectives
  )
}
