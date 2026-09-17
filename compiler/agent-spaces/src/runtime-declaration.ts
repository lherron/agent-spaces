import { constants, accessSync, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  buildRuntimeBundleRef,
  findProjectMarker,
  getAgentRootSearchPathForProject,
  getAgentsRoot,
  mergeAgentWithProjectTarget,
  parseAgentProfile,
  parseTargetsToml,
  resolveAgentPrimingPrompt,
  resolveHarnessCatalogEntry,
} from 'spaces-config'
import { createCanonicalHasher } from 'spaces-runtime-contracts'

export const RESOLVE_RUNTIME_DECLARATION_REQUEST_VERSION =
  'aspc-resolve-runtime-declaration-request/v1'
export const RESOLVE_RUNTIME_DECLARATION_RESPONSE_VERSION =
  'aspc-resolve-runtime-declaration-response/v1'

export type RuntimeDeclarationOptions = {
  aspHome?: string | undefined
  agentsRoot?: string | undefined
  environment?: Record<string, string | undefined> | undefined
  now?: (() => Date) | undefined
}

export type RuntimeDeclarationContext = {
  agentId: string
  agentRoot?: string | undefined
  project:
    | { mode: 'root'; projectRoot: string; projectId?: string | undefined }
    | { mode: 'infer-from-cwd' }
    | { mode: 'none' }
  cwd: string
  runMode: 'query' | 'heartbeat' | 'task' | 'maintenance'
  taskId?: string | undefined
  agentSources?: { aspHome?: string | undefined; agentsRoot?: string | undefined } | undefined
  provisionDirectives?: Record<string, string | number | boolean> | undefined
}

type Request = { schemaVersion: string; context?: RuntimeDeclarationContext | undefined }
type SourceObservation =
  | { state: 'absent'; code: 'not_declared' }
  | { state: 'valid'; code: 'parsed'; contentHash: string }
  | { state: 'invalid'; diagnostics: Diagnostic[] }
type Diagnostic = {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
  source: 'agent-profile' | 'project-targets' | 'selected-target' | 'priming' | 'directive'
  path?: string | undefined
}

const hasher = createCanonicalHasher()
const DIRECTIVE_KEYS = new Set([
  'harness',
  'model',
  'reasoning',
  'sandbox',
  'approval',
  'node',
  'viewer',
  'yolo',
  'remote',
])

export async function resolveRuntimeDeclaration(
  request: Request,
  options: RuntimeDeclarationOptions = {}
): Promise<Record<string, unknown>> {
  if (request.schemaVersion !== RESOLVE_RUNTIME_DECLARATION_REQUEST_VERSION || !request.context) {
    return failure('incompatible', 'unsupported_schema', 'Unsupported runtime declaration schema')
  }
  const context = request.context
  const environment = options.environment ?? process.env
  const sourceRoots = resolveSourceRoots(context, options, environment)
  if (!sourceRoots.ok) return sourceRoots.response
  const { aspHome, agentsRoot: configuredAgentsRoot } = sourceRoots

  let suppliedAgentRoot: string | undefined
  try {
    if (context.agentRoot) suppliedAgentRoot = canonicalDirectory(context.agentRoot)
  } catch (error) {
    return failure('incompatible', 'configured_context_mismatch', formatError(error))
  }

  let projectRoot: string | undefined
  let markerProjectId: string | undefined
  try {
    if (context.project.mode === 'root') {
      projectRoot = canonicalDirectory(context.project.projectRoot)
      markerProjectId = context.project.projectId
    } else if (context.project.mode === 'infer-from-cwd') {
      const marker = findProjectMarker(context.cwd, {
        ...(configuredAgentsRoot ? { agentsRoot: configuredAgentsRoot } : {}),
      })
      if (marker) {
        projectRoot = canonicalDirectory(marker.dir)
        markerProjectId = marker.id
      }
    }
  } catch (error) {
    return failure('incompatible', 'configured_context_mismatch', formatError(error))
  }

  let searchRoots: string[] = []
  if (!suppliedAgentRoot && configuredAgentsRoot) searchRoots.push(configuredAgentsRoot)
  if (!suppliedAgentRoot && projectRoot) {
    try {
      searchRoots = getAgentRootSearchPathForProject(projectRoot, {
        ...(aspHome ? { aspHome } : {}),
        env: sourceSearchEnvironment(environment, context, aspHome, configuredAgentsRoot),
      }).roots
    } catch (error) {
      return declarationInvalid('project_targets_invalid', 'project-targets', error, {
        agentSources: resolvedSources(aspHome, configuredAgentsRoot, context),
        markerProjectId,
        searchedAgentRoots: searchRoots.map((root) => join(root, context.agentId)),
      })
    }
  }
  const searchedAgentRoots = searchRoots.map((root) => join(root, context.agentId))

  let agentRoot: string | undefined
  try {
    if (suppliedAgentRoot) agentRoot = suppliedAgentRoot
    else {
      const found = searchedAgentRoots.find((root) => {
        try {
          return statSync(root).isDirectory()
        } catch {
          return false
        }
      })
      if (found) agentRoot = canonicalDirectory(found)
    }
  } catch (error) {
    return failure('incompatible', 'configured_context_mismatch', formatError(error))
  }

  const agentSources = resolvedSources(aspHome, configuredAgentsRoot, context)
  if (!agentRoot) {
    return {
      schemaVersion: RESOLVE_RUNTIME_DECLARATION_RESPONSE_VERSION,
      ok: false,
      agentSources,
      ...(markerProjectId ? { markerProjectId } : {}),
      searchedAgentRoots,
      source: emptySources(),
      resolution: {
        state: 'absent',
        code: 'agent_not_found',
        message: `Agent ${context.agentId} was not found`,
        diagnostics: [],
      },
    }
  }

  const profilePath = join(agentRoot, 'agent-profile.toml')
  let profileContent: string | undefined
  let profile: ReturnType<typeof parseAgentProfile>
  if (existsSync(profilePath)) {
    try {
      profileContent = readFileSync(profilePath, 'utf8')
    } catch (error) {
      return failure('unavailable', 'source_read_unavailable', formatError(error))
    }
    try {
      profile = parseAgentProfile(profileContent, profilePath)
    } catch (error) {
      return declarationInvalid('agent_profile_invalid', 'agent-profile', error, {
        agentSources,
        markerProjectId,
        searchedAgentRoots,
        source: emptySources(),
      })
    }
  } else {
    profile = parseAgentProfile('version = 3', profilePath)
  }
  const observedProfileSource = profileContent
    ? profileSource(profileContent, profile.provisioning?.harness)
    : ({ state: 'absent', code: 'not_declared' } as const)

  const targetsPath = projectRoot ? join(projectRoot, 'asp-targets.toml') : undefined
  let targetSource: SourceObservation = { state: 'absent', code: 'not_declared' }
  let selectedTargetSource: SourceObservation = { state: 'absent', code: 'not_declared' }
  let target: Parameters<typeof mergeAgentWithProjectTarget>[1]
  if (targetsPath && existsSync(targetsPath)) {
    let content: string
    try {
      content = readFileSync(targetsPath, 'utf8')
    } catch (error) {
      return failure('unavailable', 'source_read_unavailable', formatError(error))
    }
    try {
      const manifest = parseTargetsToml(content, targetsPath)
      targetSource = validSource(content)
      target = manifest.targets[context.agentId]
      if (target) selectedTargetSource = validSource(hasher.canonicalize(target))
    } catch (error) {
      return declarationInvalid('project_targets_invalid', 'project-targets', error, {
        agentSources,
        markerProjectId,
        searchedAgentRoots,
        source: {
          ...emptySources(),
          agentProfile: observedProfileSource,
          projectTargets: invalidSource('project_targets_invalid', 'project-targets', error),
        },
      })
    }
  }

  let priming: string | undefined
  let primingSource: SourceObservation = { state: 'absent', code: 'not_declared' }
  try {
    priming = resolveAgentPrimingPrompt(profile, agentRoot)
    if (priming !== undefined) primingSource = validSource(priming)
  } catch (error) {
    if (isSourceReadError(error)) {
      return failure('unavailable', 'source_read_unavailable', formatError(error))
    }
    return declarationInvalid('priming_invalid', 'priming', error, {
      agentSources,
      markerProjectId,
      searchedAgentRoots,
      source: {
        agentProfile: observedProfileSource,
        projectTargets: targetSource,
        selectedTarget: selectedTargetSource,
        priming: invalidSource('priming_invalid', 'priming', error),
      },
    })
  }

  const effective = mergeAgentWithProjectTarget(profile, target, context.runMode)
  const baselineScalars = { ...effective.provisioning } as Record<string, string | number | boolean>
  const finalScalars = { ...baselineScalars }
  for (const [key, value] of Object.entries(context.provisionDirectives ?? {})) {
    if (!DIRECTIVE_KEYS.has(key)) {
      return failure('incompatible', 'unsupported_directive', `Unsupported directive ${key}`)
    }
    finalScalars[key] = value
  }
  const baselineHarness = String(baselineScalars['harness'] ?? effective.harness)
  const finalHarness = String(finalScalars['harness'] ?? baselineHarness)
  const baselineProvisioning = provisioning(
    baselineScalars,
    profile.provisioning?.harness,
    baselineHarness
  )
  const finalProvisioning = provisioning(finalScalars, profile.provisioning?.harness, finalHarness)
  if ('failure' in finalProvisioning) return finalProvisioning.failure

  const bundle = profileContent
    ? buildRuntimeBundleRef({
        agentName: context.agentId,
        agentRoot,
        ...(projectRoot ? { projectRoot } : {}),
      })
    : {
        kind: 'agent-project' as const,
        agentName: context.agentId,
        ...(projectRoot ? { projectRoot } : {}),
      }
  const placement = {
    agentRoot,
    ...(projectRoot ? { projectRoot } : {}),
    cwd: context.cwd,
    runMode: context.runMode,
    bundle,
  }
  const source = {
    agentProfile: observedProfileSource,
    projectTargets: targetSource,
    selectedTarget: selectedTargetSource,
    priming: primingSource,
  }
  return {
    schemaVersion: RESOLVE_RUNTIME_DECLARATION_RESPONSE_VERSION,
    ok: true,
    evaluatedAt: (options.now?.() ?? new Date()).toISOString(),
    contextHash: hasher.hash({ context, source }).value,
    agentSources,
    ...(markerProjectId ? { markerProjectId } : {}),
    searchedAgentRoots,
    source,
    identity: {
      ...(profile.identity?.role ? { role: profile.identity.role } : {}),
      operator: profile.operator === true,
    },
    policy: {
      claimsTask: profile.claims_task === true,
      ...(profile.provisioning?.node ? { provisioningNode: profile.provisioning.node } : {}),
      placement: {
        pins: { ...(profile.placement?.pins ?? {}) },
        homes: { ...(profile.placement?.homes ?? {}) },
      },
    },
    baselineProvisioning,
    provisioning: finalProvisioning,
    ...(priming !== undefined
      ? { priming: { content: priming, source: profile.priming_file ?? 'inline' } }
      : {}),
    placement,
    bundle: { ref: bundle, identity: hasher.hash(bundle).value },
    diagnostics: [],
  }
}

function provisioning(
  scalars: Record<string, string | number | boolean>,
  declaredHarness: string | undefined,
  effectiveHarness: string
): Record<string, unknown> & { failure?: Record<string, unknown> } {
  const entry = resolveHarnessCatalogEntry(effectiveHarness)
  if (!entry || !entry.frontend) {
    return {
      failure: failure(
        'incompatible',
        'unsupported_harness',
        `Unsupported harness ${effectiveHarness}`
      ),
    }
  }
  return {
    scalars,
    ...(declaredHarness ? { declaredHarness } : {}),
    effectiveHarness: entry.id,
    frontend: entry.frontend,
    provider: entry.provider,
    family: entry.id,
    runtime: entry.frontend,
  }
}

function resolveSourceRoots(
  context: RuntimeDeclarationContext,
  options: RuntimeDeclarationOptions,
  environment: Record<string, string | undefined>
):
  | { ok: true; aspHome: string | undefined; agentsRoot: string | undefined }
  | { ok: false; response: Record<string, unknown> } {
  let callerAspHome: string | undefined
  let callerAgentsRoot: string | undefined
  try {
    callerAspHome = canonicalOptional(context.agentSources?.aspHome)
    callerAgentsRoot = canonicalOptional(context.agentSources?.agentsRoot)
  } catch (error) {
    return {
      ok: false,
      response: failure('incompatible', 'configured_context_mismatch', formatError(error)),
    }
  }
  if (context.agentSources && !callerAgentsRoot && !callerAspHome) {
    return {
      ok: false,
      response: failure(
        'incompatible',
        'configured_context_mismatch',
        'agentSources must resolve aspHome or agentsRoot'
      ),
    }
  }

  let callerConfiguredAgentsRoot: string | undefined
  if (callerAspHome) {
    try {
      const configuredPath = getAgentsRoot({
        aspHome: callerAspHome,
        env: callerSourceEnvironment(environment, callerAspHome),
      })
      callerConfiguredAgentsRoot = configuredPath
        ? canonicalConfiguredDirectory(configuredPath)
        : callerAgentsRoot
      if (
        callerAgentsRoot &&
        callerConfiguredAgentsRoot &&
        callerConfiguredAgentsRoot !== callerAgentsRoot
      ) {
        return {
          ok: false,
          response: failure(
            'incompatible',
            'configured_context_mismatch',
            `Caller agentsRoot ${callerAgentsRoot} conflicts with ${callerAspHome}`
          ),
        }
      }
      if (!callerConfiguredAgentsRoot) {
        throw new Error('No agents root is configured')
      }
    } catch (error) {
      return {
        ok: false,
        response: failure('incompatible', 'configured_context_mismatch', formatError(error)),
      }
    }
  }
  if (context.agentSources) {
    return {
      ok: true,
      aspHome: callerAspHome ?? (callerAgentsRoot ? dirname(callerAgentsRoot) : undefined),
      agentsRoot: callerAgentsRoot ?? callerConfiguredAgentsRoot,
    }
  }

  try {
    const daemonAspHome = canonicalOptional(options.aspHome ?? environment['ASP_HOME'])
    const daemonAgentsRoot = canonicalConfiguredDirectory(
      options.agentsRoot ??
        getAgentsRoot({
          ...(daemonAspHome ? { aspHome: daemonAspHome } : {}),
          env: environment,
        })
    )
    return { ok: true, aspHome: daemonAspHome, agentsRoot: daemonAgentsRoot }
  } catch (error) {
    return {
      ok: false,
      response: failure('unavailable', 'configured_source_unavailable', formatError(error)),
    }
  }
}

function canonicalOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : canonicalDirectory(value)
}

function canonicalDirectory(value: string): string {
  const stats = statSync(value)
  if (!stats.isDirectory()) throw new Error(`Configured path is not a directory: ${value}`)
  accessSync(value, constants.R_OK)
  return realpathSync(value)
}

function canonicalConfiguredDirectory(value: string | undefined): string {
  if (!value) throw new Error('No agents root is configured')
  return canonicalDirectory(value)
}

function resolvedSources(
  aspHome: string | undefined,
  agentsRoot: string | undefined,
  context: RuntimeDeclarationContext
): Record<string, unknown> {
  return {
    ...(aspHome ? { aspHome } : {}),
    ...(agentsRoot ? { agentsRoot } : {}),
    provenance: context.agentRoot
      ? 'caller-agent-root'
      : context.agentSources
        ? context.agentSources.aspHome && !context.agentSources.agentsRoot
          ? 'caller-asp-home-config'
          : 'caller'
        : 'daemon-default',
  }
}

function validSource(content: string): SourceObservation {
  return { state: 'valid', code: 'parsed', contentHash: hasher.hash(content).value }
}

function profileSource(
  content: string,
  declaredHarness: string | undefined
): SourceObservation & Record<string, unknown> {
  const entry = resolveHarnessCatalogEntry(declaredHarness)
  return {
    ...validSource(content),
    ...(declaredHarness ? { declaredHarness } : {}),
    ...(entry ? { declaredProvider: entry.provider } : {}),
  }
}

function invalidSource(
  code: string,
  source: Diagnostic['source'],
  error: unknown
): SourceObservation {
  return { state: 'invalid', diagnostics: [diagnostic(code, source, error)] }
}

function emptySources(): Record<string, SourceObservation> {
  return {
    agentProfile: { state: 'absent', code: 'not_declared' },
    projectTargets: { state: 'absent', code: 'not_declared' },
    selectedTarget: { state: 'absent', code: 'not_declared' },
    priming: { state: 'absent', code: 'not_declared' },
  }
}

function declarationInvalid(
  code: string,
  sourceName: Diagnostic['source'],
  error: unknown,
  fields: Record<string, unknown>
): Record<string, unknown> {
  const item = diagnostic(code, sourceName, error)
  return {
    schemaVersion: RESOLVE_RUNTIME_DECLARATION_RESPONSE_VERSION,
    ok: false,
    ...fields,
    source: fields['source'] ?? {
      ...emptySources(),
      [sourceName === 'agent-profile' ? 'agentProfile' : 'projectTargets']: {
        state: 'invalid',
        diagnostics: [item],
      },
    },
    resolution: { state: 'invalid', code, message: item.message, diagnostics: [item] },
  }
}

function diagnostic(code: string, source: Diagnostic['source'], error: unknown): Diagnostic {
  return { severity: 'error', code, message: formatError(error), source }
}

function failure(kind: 'unavailable' | 'incompatible', code: string, message: string) {
  return {
    schemaVersion: RESOLVE_RUNTIME_DECLARATION_RESPONSE_VERSION,
    ok: false,
    failure: { kind, code, message },
  }
}

function environmentWithoutProjectOverride(
  environment: Record<string, string | undefined>
): Record<string, string | undefined> {
  const copy = { ...environment }
  copy['ASP_PROJECT_ROOT_OVERRIDE'] = undefined
  return copy
}

function callerSourceEnvironment(
  environment: Record<string, string | undefined>,
  aspHome: string
): Record<string, string | undefined> {
  return {
    ...environmentWithoutProjectOverride(environment),
    ASP_HOME: aspHome,
    ASP_AGENTS_ROOT: undefined,
  }
}

function sourceSearchEnvironment(
  environment: Record<string, string | undefined>,
  context: RuntimeDeclarationContext,
  aspHome: string | undefined,
  agentsRoot: string | undefined
): Record<string, string | undefined> {
  if (!context.agentSources) return environmentWithoutProjectOverride(environment)
  return {
    ...environmentWithoutProjectOverride(environment),
    ...(aspHome ? { ASP_HOME: aspHome } : {}),
    ASP_AGENTS_ROOT: agentsRoot,
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isSourceReadError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ['ENOENT', 'EACCES', 'EPERM', 'EIO'].includes(String(error.code))
  )
}
