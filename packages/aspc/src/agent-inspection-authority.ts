import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { catalogAgentSources, inspectAgentForContext } from 'agent-spaces'
import {
  agentCatalogResponseSchema,
  agentInspectionOutcomeSchema,
  validateAspcCatalogAgentInspectionRequest,
  validateAspcInspectAgentSelectionRequest,
} from 'spaces-aspc-protocol'
import type {
  AspcAgentCatalogRow,
  AspcAgentInspectionCatalogResponse,
  AspcAgentInspectionContextOption,
  AspcCatalogAgentInspectionRequest,
  AspcInspectAgentResponse,
  AspcInspectAgentSelectionRequest,
} from 'spaces-aspc-protocol'
import {
  DEFAULT_HARNESS,
  getAgentsRoot,
  parseAgentProfile,
  resolveHarnessCatalogEntry,
} from 'spaces-config'
import { RUNTIME_ROUTE_CATALOG } from 'spaces-runtime-contracts'
import type {
  AgentInspectionEvaluationContext,
  AgentInspectionScaffoldPacket,
  AgentInspectionServiceProbeResponse,
} from 'spaces-runtime-contracts'

import type { AspcCompiler } from './service.js'

export type AspcProjectRootResolver = (
  projectId: string
) => Promise<string | undefined> | string | undefined

export interface AspcInspectionAuthorityOptions {
  /** Trusted startup configuration. Never accepted from an operation payload. */
  agentsRoot?: string | undefined
  /** Trusted server-side project-id resolver. Never accepts or returns client input. */
  resolveProjectRoot?: AspcProjectRootResolver | undefined
  environment?: (() => Record<string, string | undefined>) | undefined
  now?: (() => string) | undefined
  serviceProbeResponses?: (() => AgentInspectionServiceProbeResponse[]) | undefined
  scaffoldPackets?: (() => AgentInspectionScaffoldPacket[]) | undefined
}

export type AspcInspectionAuthorityErrorCode =
  | 'AGENT_INSPECTION_PRODUCER_UNAVAILABLE'
  | 'AGENT_INSPECTION_PROJECT_NOT_FOUND'
  | 'AGENT_INSPECTION_AGENT_NOT_FOUND'
  | 'INVALID_AGENT_INSPECTION_SELECTION'
  | 'AGENT_INSPECTION_PRODUCER_FAILURE'

export class AspcInspectionAuthorityError extends Error {
  readonly code: AspcInspectionAuthorityErrorCode
  readonly status: 400 | 404 | 502 | 503

  constructor(
    code: AspcInspectionAuthorityErrorCode,
    status: 400 | 404 | 502 | 503,
    message: string
  ) {
    super(message)
    this.name = 'AspcInspectionAuthorityError'
    this.code = code
    this.status = status
  }
}

export interface AspcInspectionAuthority {
  catalogAgentInspection(
    req: AspcCatalogAgentInspectionRequest
  ): Promise<AspcAgentInspectionCatalogResponse>
  inspectAgentSelection(req: AspcInspectAgentSelectionRequest): Promise<AspcInspectAgentResponse>
}

type CatalogAssembly = {
  response: AspcAgentInspectionCatalogResponse
  profiles: Map<string, Record<string, unknown>>
  projectRoot?: string | undefined
}

export function createAspcInspectionAuthority(
  compiler: AspcCompiler,
  options: AspcInspectionAuthorityOptions = {}
): AspcInspectionAuthority {
  // Resolve once at service startup. A live request re-enumerates this pinned
  // root, but cannot redirect the producer with cwd/env/path payloads.
  const configuredAgentsRoot = normalizeConfiguredRoot(options.agentsRoot ?? getAgentsRoot())
  const environment = options.environment ?? (() => process.env)
  const now = options.now ?? (() => new Date().toISOString())
  const serviceProbeResponses = options.serviceProbeResponses ?? (() => [])
  const scaffoldPackets = options.scaffoldPackets ?? (() => [])

  async function assembleCatalog(projectId?: string): Promise<CatalogAssembly> {
    const agentsRoot = requireAgentsRoot(configuredAgentsRoot)
    const sourceCatalog = await catalogAgentSources({ agentsRoot })
    if (projectId === undefined) {
      return {
        response: agentCatalogResponseSchema.parse({
          projectId: null,
          agents: sourceCatalog.agents.map(withoutDefaultContext),
          contexts: {},
        }),
        profiles: new Map(),
      }
    }

    const projectRoot = await resolveTrustedProjectRoot(projectId, options.resolveProjectRoot)
    const contexts: Record<string, AspcAgentInspectionContextOption[]> = {}
    const profiles = new Map<string, Record<string, unknown>>()
    const agents: AspcAgentCatalogRow[] = sourceCatalog.agents.map((sourceRow) => {
      const profilePath = join(agentsRoot, sourceRow.agentId, 'agent-profile.toml')
      let optionsForAgent: AspcAgentInspectionContextOption[] = []
      let profile: Record<string, unknown> | undefined
      try {
        profile = parseAgentProfile(
          readFileSync(profilePath, 'utf8'),
          profilePath
        ) as unknown as Record<string, unknown>
        profiles.set(sourceRow.agentId, profile)
        optionsForAgent = contextOptions(sourceRow.agentId, projectId, profile)
      } catch {
        // The source catalog already carries the stable parse diagnostic. A
        // malformed or concurrently removed profile has no selectable context.
      }

      if (optionsForAgent.length > 0) contexts[sourceRow.agentId] = optionsForAgent
      const defaultContextSummary = optionsForAgent[0]
        ? summary(optionsForAgent[0].identifiers)
        : undefined
      if (profile !== undefined && optionsForAgent.length === 0) {
        const diagnostics = [
          ...sourceRow.diagnostics,
          {
            severity: 'error' as const,
            code: 'inspection_context_unavailable',
            message: 'The declared harness has no producer-supported inspection context',
          },
        ]
        return {
          ...sourceRow,
          diagnostics,
          warningCount: diagnostics.filter(({ severity }) => severity === 'warning').length,
          errorCount: diagnostics.filter(({ severity }) => severity === 'error').length,
        }
      }
      return {
        ...sourceRow,
        ...(defaultContextSummary !== undefined ? { defaultContextSummary } : {}),
      }
    })

    return {
      response: agentCatalogResponseSchema.parse({ projectId, agents, contexts }),
      profiles,
      projectRoot,
    }
  }

  return {
    async catalogAgentInspection(
      raw: AspcCatalogAgentInspectionRequest
    ): Promise<AspcAgentInspectionCatalogResponse> {
      const req = validateAspcCatalogAgentInspectionRequest(raw)
      return (await assembleCatalog(req.projectId)).response
    },

    async inspectAgentSelection(
      raw: AspcInspectAgentSelectionRequest
    ): Promise<AspcInspectAgentResponse> {
      const req = validateAspcInspectAgentSelectionRequest(raw)
      if (req.agentId !== req.request.identifiers.agentId) {
        throw authorityError(
          'INVALID_AGENT_INSPECTION_SELECTION',
          400,
          'The selected agent id does not match the inspection request'
        )
      }

      const assembly = await assembleCatalog(req.request.identifiers.projectId)
      const row = assembly.response.agents.find(({ agentId }) => agentId === req.agentId)
      if (row === undefined) {
        throw authorityError(
          'AGENT_INSPECTION_AGENT_NOT_FOUND',
          404,
          `Agent source not found: ${req.agentId}`
        )
      }

      const selected = assembly.response.contexts[req.agentId]?.find((candidate) =>
        sameSelection(candidate, req.request)
      )
      if (selected === undefined) {
        throw authorityError(
          'INVALID_AGENT_INSPECTION_SELECTION',
          400,
          'The requested inspection context is not producer-listed'
        )
      }

      const agentsRoot = requireAgentsRoot(configuredAgentsRoot)
      const projectRoot = assembly.projectRoot
      const profile = assembly.profiles.get(req.agentId)
      if (projectRoot === undefined || profile === undefined) {
        throw authorityError(
          'AGENT_INSPECTION_PRODUCER_FAILURE',
          502,
          'The producer could not assemble the selected inspection context'
        )
      }

      try {
        const evaluatedAt = now()
        const agentRoot = join(agentsRoot, req.agentId)
        const pinnedEnvironment = nonEmptyEnvironment(environment())
        const evaluationContext: AgentInspectionEvaluationContext = {
          schemaVersion: 'agent-inspection-evaluation-context/v1',
          identifiers: selected.identifiers,
          paths: {
            agentRoot,
            agentsRoot,
            projectRoot,
            cwd: projectRoot,
          },
          nowIso: evaluatedAt,
          environment: pinnedEnvironment,
          predicateInputs: { cwd: projectRoot, environment: pinnedEnvironment },
          execInputs: { cwd: agentRoot, environment: pinnedEnvironment },
          serviceProbeInputs: { responses: serviceProbeResponses() },
          scaffoldPackets: scaffoldPackets(),
          agentProfile: profile,
          declaredOverrides: selected.declaredOverrides,
          compileContext: {
            nowIso: evaluatedAt,
            idSalt: `aspc-agent-inspection:${selected.identifiers.projectId}`,
            toolchainManifest: { schemaVersion: 'compile-toolchain/v1' },
          },
        }
        const outcome = await inspectAgentForContext(
          { request: req.request, evaluationContext },
          {
            compileRuntimePlan: (compileRequest, compileOptions) =>
              compiler(compileRequest, { compileContext: compileOptions?.compileContext }),
          }
        )
        return agentInspectionOutcomeSchema.parse(outcome)
      } catch (error) {
        if (error instanceof AspcInspectionAuthorityError) throw error
        throw authorityError(
          'AGENT_INSPECTION_PRODUCER_FAILURE',
          502,
          error instanceof Error ? error.message : String(error)
        )
      }
    },
  }
}

function contextOptions(
  agentId: string,
  projectId: string,
  profile: Record<string, unknown>
): AspcAgentInspectionContextOption[] {
  const provisioning = asRecord(profile['provisioning'])
  const declaredHarness =
    typeof provisioning?.['harness'] === 'string' ? provisioning['harness'] : DEFAULT_HARNESS
  const harness = resolveHarnessCatalogEntry(declaredHarness)
  if (harness === undefined || harness.frontend === undefined) return []

  const family =
    harness.id === 'codex'
      ? 'codex'
      : harness.id === 'pi' || harness.id === 'pi-sdk'
        ? 'pi'
        : 'claude-code'
  const runtime =
    harness.id === 'codex'
      ? 'codex-cli'
      : harness.id === 'pi'
        ? 'pi-cli'
        : harness.id === 'pi-sdk'
          ? 'pi-sdk'
          : harness.id === 'claude-agent-sdk'
            ? 'claude-agent-sdk'
            : 'claude-code-cli'
  const interactions = RUNTIME_ROUTE_CATALOG.filter(
    (route) => route.harnessFamily === family && route.harnessRuntime === runtime
  ).map(({ interactionMode }) => interactionMode)

  return [...new Set(interactions)].map((interaction) => ({
    identifiers: {
      agentId,
      projectId,
      mode: 'task',
      scope: `agent:${agentId}:project:${projectId}`,
      lane: 'main',
      harness: declaredHarness,
      frontend: harness.frontend as string,
      interaction,
    },
    declaredOverrides: {},
  }))
}

function summary(identifiers: AspcAgentInspectionContextOption['identifiers']) {
  return {
    projectId: identifiers.projectId,
    mode: identifiers.mode,
    lane: identifiers.lane,
    harness: identifiers.harness,
    frontend: identifiers.frontend,
    interaction: identifiers.interaction,
  }
}

function sameSelection(
  option: AspcAgentInspectionContextOption,
  request: AspcInspectAgentSelectionRequest['request']
): boolean {
  return (
    sameRecord(option.identifiers, request.identifiers) &&
    sameRecord(option.declaredOverrides, request.declaredOverrides)
  )
}

function sameRecord(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  )
}

function withoutDefaultContext(row: AspcAgentCatalogRow): AspcAgentCatalogRow {
  const { defaultContextSummary: _ignored, ...neutral } = row
  return neutral
}

function normalizeConfiguredRoot(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined
  return resolve(value)
}

function requireAgentsRoot(value: string | undefined): string {
  if (value === undefined || !isDirectory(value)) {
    throw authorityError(
      'AGENT_INSPECTION_PRODUCER_UNAVAILABLE',
      503,
      'The canonical ASP agents root is unavailable'
    )
  }
  return value
}

async function resolveTrustedProjectRoot(
  projectId: string,
  resolver: AspcProjectRootResolver | undefined
): Promise<string> {
  if (resolver === undefined) {
    throw authorityError(
      'AGENT_INSPECTION_PRODUCER_UNAVAILABLE',
      503,
      'The trusted project resolver is unavailable'
    )
  }
  let projectRoot: string | undefined
  try {
    projectRoot = await resolver(projectId)
  } catch {
    throw authorityError(
      'AGENT_INSPECTION_PRODUCER_UNAVAILABLE',
      503,
      'The trusted project resolver failed'
    )
  }
  if (projectRoot === undefined || !isAbsolute(projectRoot) || !isDirectory(projectRoot)) {
    throw authorityError(
      'AGENT_INSPECTION_PROJECT_NOT_FOUND',
      404,
      `Project not found: ${projectId}`
    )
  }
  return resolve(projectRoot)
}

function nonEmptyEnvironment(source: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.length > 0) result[key] = value
  }
  return result
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function isDirectory(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function authorityError(
  code: AspcInspectionAuthorityErrorCode,
  status: 400 | 404 | 502 | 503,
  message: string
): AspcInspectionAuthorityError {
  return new AspcInspectionAuthorityError(code, status, message)
}
