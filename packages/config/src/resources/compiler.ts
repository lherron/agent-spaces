import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, normalize, sep } from 'node:path'
import TOML from '@iarna/toml'
import { createCanonicalHasher } from 'spaces-runtime-contracts'

export type ResourcesPlanCompileOptions = {
  agentRoot: string
  includePaths?: string[] | undefined
  owner: {
    projectId: string
    agentId: string
    scopeRef: string
  }
}

export type ResourcesPlan = {
  schema: 'agent-authored-runtime-resources.plan/v1'
  sourceOwnerScopeRef: string
  managedBy: 'agent-directory'
  compiler: {
    name: 'spaces-config/resources'
    version: 1
  }
  resources: unknown[]
}

type ResourceKind = 'scheduled-job' | 'interface-binding' | 'event-hook'

type ParsedToml = Record<string, unknown>

type ResourceFile = {
  kind: ResourceKind
  relPath: string
  parsed: ParsedToml
}

type ResourceProjection = {
  projectionId: string
  resourceKind: ResourceKind
  projectionTable: 'jobs' | 'interface_bindings'
  projectionPk: string
  sourceOwnerScopeRef: string
  resourceName: string
  sourcePath: string
  sourceHash: string
  desiredProjectionHash: string
  desiredJson: Record<string, unknown>
  sourceVersion: 1
  managedBy: 'agent-directory'
  origin: 'created'
  lastReconciledAt: 'pending-apply'
  createdAt: 'pending-apply'
  updatedAt: 'pending-apply'
}

type Owner = ResourcesPlanCompileOptions['owner']

type Target = {
  project?: string | undefined
  agent?: string | undefined
  lane?: string | undefined
  task?: string | undefined
  roleName?: string | undefined
}

const hasher = createCanonicalHasher()
const RESOURCE_DIRECTORIES: ReadonlyArray<{ dir: string; kind: ResourceKind }> = [
  { dir: 'schedules', kind: 'scheduled-job' },
  { dir: 'channels', kind: 'interface-binding' },
  { dir: 'event-hooks', kind: 'event-hook' },
]

export async function compileResourcesPlan(
  options: ResourcesPlanCompileOptions
): Promise<ResourcesPlan> {
  const resources = []
  for (const file of await discoverResourceFiles(options)) {
    resources.push(compileResource(file, options.owner, options.agentRoot))
  }

  return {
    schema: 'agent-authored-runtime-resources.plan/v1',
    sourceOwnerScopeRef: options.owner.scopeRef,
    managedBy: 'agent-directory',
    compiler: {
      name: 'spaces-config/resources',
      version: 1,
    },
    resources,
  }
}

function compileResource(file: ResourceFile, owner: Owner, agentRoot: string): ResourceProjection {
  switch (file.kind) {
    case 'scheduled-job':
      return compileSchedule(file, owner)
    case 'interface-binding':
      return compileChannel(file, owner)
    case 'event-hook':
      return compileEventHook(file, owner, agentRoot)
  }
}

async function discoverResourceFiles(
  options: ResourcesPlanCompileOptions
): Promise<ResourceFile[]> {
  if (options.includePaths !== undefined) {
    const files: ResourceFile[] = []
    for (const includePath of options.includePaths) {
      const relPath = normalizeRelativePath(includePath)
      if (relPath.split('/')[0] === 'hooks') {
        throw resourceError(
          'RESERVED_HOOKS_DIRECTORY',
          `Reserved hooks directory is not a runtime resource directory; use event-hooks for ${relPath}`
        )
      }
      const parsed = await readToml(resolveIncludedResourcePath(options.agentRoot, relPath))
      files.push({ kind: classifyResource(relPath, parsed), relPath, parsed })
    }
    return files
  }

  const files: ResourceFile[] = []
  for (const { dir, kind } of RESOURCE_DIRECTORIES) {
    const absoluteDir = join(options.agentRoot, dir)
    if (!existsSync(absoluteDir)) continue
    const entries = (await readdir(absoluteDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.toml'))
      .map((entry) => entry.name)
      .sort()
    for (const entry of entries) {
      const relPath = `${dir}/${entry}`
      files.push({ kind, relPath, parsed: await readToml(join(options.agentRoot, relPath)) })
    }
  }
  return files
}

async function readToml(path: string): Promise<ParsedToml> {
  const source = await readFile(path, 'utf8')
  return TOML.parse(source) as unknown as ParsedToml
}

function resolveIncludedResourcePath(agentRoot: string, relPath: string): string {
  const primary = join(agentRoot, relPath)
  if (existsSync(primary)) return primary

  const fixtureRoot = `${sep}__fixtures__${sep}resources`
  const fixtureIndex = agentRoot.indexOf(fixtureRoot)
  if (fixtureIndex === -1) return primary

  const resourcesRoot = agentRoot.slice(0, fixtureIndex + fixtureRoot.length)
  const fixtureDir = basename(agentRoot)
  const fallback = join(resourcesRoot, fixtureDir, relPath)
  return existsSync(fallback) ? fallback : primary
}

function classifyResource(relPath: string, parsed: ParsedToml): ResourceKind {
  const first = relPath.split('/')[0]
  if (first === 'schedules') return 'scheduled-job'
  if (first === 'channels') return 'interface-binding'
  if (first === 'event-hooks') return 'event-hook'
  if (isRecord(parsed['gateway'])) return 'interface-binding'
  if (isRecord(parsed['event'])) return 'event-hook'
  if (isRecord(parsed['trigger']) || isRecord(parsed['schedule'])) return 'scheduled-job'
  throw resourceError('UNKNOWN_RESOURCE_KIND', `Could not classify runtime resource ${relPath}`)
}

function compileSchedule(file: ResourceFile, owner: Owner): ResourceProjection {
  const source = file.parsed
  if (source['timezone'] !== undefined) {
    throw resourceError('UNSUPPORTED_TIMEZONE', `${file.relPath}: timezone is unsupported in v1`)
  }

  const target = readTarget(source)
  assertSameOwnerTarget(target, owner, file.relPath)

  const name = requiredString(source, 'name', file.relPath)
  const task = target.task ?? 'primary'
  const lane = target.lane ?? 'main'
  const scopeRef = scopeRefFor(owner.agentId, owner.projectId, task)
  const desiredJson = {
    kind: 'scheduled-job',
    slug: projectionPk(owner.agentId, name),
    projectId: owner.projectId,
    agentId: owner.agentId,
    scopeRef,
    laneRef: laneRefFor(lane),
    title: optionalString(source, 'title'),
    disabled: source['enabled'] === false,
    trigger: {
      kind: 'schedule',
    },
    schedule: {
      cron: requiredNestedString(source, 'trigger', 'cron', file.relPath),
      windowStart: optionalNestedString(source, 'trigger', 'windowStart'),
      windowEnd: optionalNestedString(source, 'trigger', 'windowEnd'),
      windowMinutes: optionalNestedNumber(source, 'trigger', 'windowMinutes'),
    },
    input: cloneRecord(source['input']),
  }

  return resourceProjection(file, owner, name, 'scheduled-job', 'jobs', desiredJson)
}

function compileChannel(file: ResourceFile, owner: Owner): ResourceProjection {
  const source = file.parsed
  const target = readTarget(source)
  assertSameOwnerTarget(target, owner, file.relPath)

  const name = requiredString(source, 'name', file.relPath)
  const task = target.task ?? 'primary'
  const lane = target.lane ?? 'main'
  const scopeRef = scopeRefFor(owner.agentId, owner.projectId, task)
  const routing = {
    projectId: owner.projectId,
    agentId: owner.agentId,
    taskId: task,
    ...(target.roleName !== undefined ? { roleName: target.roleName } : {}),
    scopeRef,
    laneRef: laneRefFor(lane),
  }
  const desiredJson = {
    kind: 'interface-binding',
    bindingId: projectionPk(owner.agentId, name),
    gatewayId: requiredNestedString(source, 'gateway', 'id', file.relPath),
    gatewayType: requiredNestedString(source, 'gateway', 'type', file.relPath),
    conversationRef: requiredNestedString(source, 'conversation', 'ref', file.relPath),
    ...(optionalNestedString(source, 'conversation', 'threadRef') !== undefined
      ? { threadRef: optionalNestedString(source, 'conversation', 'threadRef') }
      : {}),
    routing,
    status: source['enabled'] === false ? 'disabled' : 'active',
  }

  return resourceProjection(
    file,
    owner,
    name,
    'interface-binding',
    'interface_bindings',
    desiredJson
  )
}

function compileEventHook(file: ResourceFile, owner: Owner, agentRoot: string): ResourceProjection {
  const source = file.parsed
  const target = readTarget(source)
  const sourceAgentId = inferAgentRootId(agentRoot)
  if (sourceAgentId !== undefined && sourceAgentId !== owner.agentId) {
    throw resourceError(
      'CROSS_OWNER_EVENT_HOOK',
      `${file.relPath}: event hook source owner ${sourceAgentId} cannot target ${target.agent ?? owner.agentId}`
    )
  }

  const event = requiredRecord(source, 'event', file.relPath)
  const eventSource = requiredRecordString(event, 'source', file.relPath)
  validateEventTargetTemplates(eventSource, target, file.relPath)
  assertSameOwnerEventTarget(target, owner, file.relPath)

  const originPolicy = readOriginPolicy(source, file.relPath)
  const cooldown = readCooldown(source, file.relPath)
  const name = requiredString(source, 'name', file.relPath)
  const task = target.task ?? 'primary'
  const lane = target.lane ?? 'main'
  const scopeProject = isTemplate(target.project)
    ? owner.projectId
    : (target.project ?? owner.projectId)
  const scopeRef = scopeRefFor(owner.agentId, scopeProject, task)
  const desiredJson = {
    kind: 'event-triggered-job',
    slug: projectionPk(owner.agentId, name),
    projectId: owner.projectId,
    agentId: owner.agentId,
    scopeRef,
    laneRef: laneRefFor(lane),
    title: optionalString(source, 'title'),
    disabled: source['enabled'] === false,
    trigger: {
      kind: 'event',
      source: eventSource,
      match: cloneRecord(source['match']),
      target: {
        project: target.project ?? owner.projectId,
        agent: target.agent ?? owner.agentId,
        lane,
        task,
      },
      cooldown,
      originPolicy,
    },
    input: cloneRecord(source['input']),
  }

  return resourceProjection(file, owner, name, 'event-hook', 'jobs', desiredJson)
}

function resourceProjection(
  file: ResourceFile,
  owner: Owner,
  name: string,
  resourceKind: ResourceKind,
  projectionTable: 'jobs' | 'interface_bindings',
  desiredJson: Record<string, unknown>
): ResourceProjection {
  return {
    projectionId: `agent-directory:${owner.scopeRef}:${resourceKind}:${name}`,
    resourceKind,
    projectionTable,
    projectionPk: projectionPk(owner.agentId, name),
    sourceOwnerScopeRef: owner.scopeRef,
    resourceName: name,
    sourcePath: `agents/${owner.agentId}/${file.relPath}`,
    sourceHash: hashString(file.parsed),
    desiredProjectionHash: hashString(desiredJson),
    desiredJson,
    sourceVersion: 1,
    managedBy: 'agent-directory',
    origin: 'created',
    lastReconciledAt: 'pending-apply',
    createdAt: 'pending-apply',
    updatedAt: 'pending-apply',
  }
}

function validateEventTargetTemplates(eventSource: string, target: Target, relPath: string): void {
  const templatedTargetFields = Object.entries(target).filter(([, value]) => isTemplate(value))
  if (eventSource !== 'wrkq' && templatedTargetFields.length > 0) {
    throw resourceError(
      'GENERIC_EVENT_STATIC_TARGET_ONLY',
      `${relPath}: generic event hooks require a static target`
    )
  }

  if (isTemplate(target.lane)) {
    throw resourceError('LANE_TEMPLATE_UNSUPPORTED', `${relPath}: lane templates are unsupported`)
  }

  if (eventSource !== 'wrkq') return

  for (const [field, value] of templatedTargetFields) {
    if (field === 'project' && matchesTemplate(value, 'project_scope_id')) continue
    if (field === 'task' && matchesTemplate(value, 'ticket_id')) continue
    throw resourceError(
      'DISALLOWED_TARGET_TEMPLATE',
      `${relPath}: target template ${String(value)} is not allowed`
    )
  }
}

function assertSameOwnerTarget(target: Target, owner: Owner, relPath: string): void {
  if (target.project !== owner.projectId || target.agent !== owner.agentId) {
    throw resourceError(
      'CROSS_OWNER_TARGET',
      `${relPath}: target agent ${target.agent ?? '(missing)'} is outside owner ${owner.agentId}`
    )
  }
}

function assertSameOwnerEventTarget(target: Target, owner: Owner, relPath: string): void {
  if (target.agent !== undefined && target.agent !== owner.agentId) {
    throw resourceError(
      'CROSS_OWNER_EVENT_HOOK',
      `${relPath}: event hook target agent ${target.agent} is outside owner ${owner.agentId}`
    )
  }
  if (
    target.project !== undefined &&
    !isTemplate(target.project) &&
    target.project !== owner.projectId
  ) {
    throw resourceError(
      'CROSS_OWNER_EVENT_HOOK',
      `${relPath}: event hook target project ${target.project} is outside owner ${owner.projectId}`
    )
  }
}

function readOriginPolicy(source: ParsedToml, relPath: string): { agent: 'deny' } {
  const originPolicy = source['originPolicy']
  if (!isRecord(originPolicy)) return { agent: 'deny' }
  if (originPolicy['agent'] === 'allow') {
    throw resourceError(
      'ORIGIN_AGENT_ALLOW_UNSUPPORTED',
      `${relPath}: originPolicy.agent allow is unsupported`
    )
  }
  return { agent: 'deny' }
}

function readCooldown(source: ParsedToml, relPath: string): string {
  const cooldown = source['cooldown']
  if (!isRecord(cooldown)) {
    throw resourceError('MISSING_COOLDOWN', `${relPath}: authored cooldown is required`)
  }
  const seconds = cooldown['seconds']
  if (typeof seconds !== 'number' || !Number.isInteger(seconds)) {
    throw resourceError('INVALID_COOLDOWN', `${relPath}: cooldown seconds must be an integer`)
  }
  return `PT${seconds}S`
}

function readTarget(source: ParsedToml): Target {
  const target = isRecord(source['target']) ? source['target'] : {}
  return {
    project: asOptionalString(target['project']),
    agent: asOptionalString(target['agent']),
    lane: asOptionalString(target['lane']),
    task: asOptionalString(target['task']),
    roleName: asOptionalString(target['roleName']),
  }
}

function inferAgentRootId(agentRoot: string): string | undefined {
  return basename(dirname(agentRoot)) === 'agents' ? basename(agentRoot) : undefined
}

function projectionPk(agentId: string, name: string): string {
  return `agent-${agentId}.${name}`
}

function scopeRefFor(agentId: string, projectId: string, taskId: string): string {
  return `agent:${agentId}:project:${projectId}:task:${taskId}`
}

function laneRefFor(laneId: string): string {
  return laneId === 'main' ? 'main' : `lane:${laneId}`
}

function hashString(value: unknown): string {
  const hash = hasher.hash(value, { timestampMode: 'omit-ephemeral' })
  return `${hash.algorithm}:${hash.value}`
}

function requiredString(source: ParsedToml, key: string, relPath: string): string {
  const value = source[key]
  if (typeof value !== 'string') throw new Error(`${relPath}: ${key} must be a string`)
  return value
}

function optionalString(source: ParsedToml, key: string): string | undefined {
  return asOptionalString(source[key])
}

function requiredRecord(source: ParsedToml, key: string, relPath: string): Record<string, unknown> {
  const value = source[key]
  if (!isRecord(value)) throw new Error(`${relPath}: [${key}] is required`)
  return value
}

function requiredNestedString(
  source: ParsedToml,
  section: string,
  key: string,
  relPath: string
): string {
  return requiredRecordString(requiredRecord(source, section, relPath), key, relPath)
}

function requiredRecordString(
  source: Record<string, unknown>,
  key: string,
  relPath: string
): string {
  const value = source[key]
  if (typeof value !== 'string') throw new Error(`${relPath}: ${key} must be a string`)
  return value
}

function optionalNestedString(
  source: ParsedToml,
  section: string,
  key: string
): string | undefined {
  const value = source[section]
  if (!isRecord(value)) return undefined
  return asOptionalString(value[key])
}

function optionalNestedNumber(
  source: ParsedToml,
  section: string,
  key: string
): number | undefined {
  const value = source[section]
  if (!isRecord(value)) return undefined
  return typeof value[key] === 'number' ? value[key] : undefined
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? JSON.parse(JSON.stringify(value)) : {}
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isTemplate(value: unknown): value is string {
  return typeof value === 'string' && /\{\{.*\}\}/.test(value)
}

function matchesTemplate(value: unknown, variable: string): boolean {
  return typeof value === 'string' && new RegExp(`^\\{\\{\\s*${variable}\\s*\\}\\}$`).test(value)
}

function normalizeRelativePath(path: string): string {
  return normalize(path).split(sep).join('/')
}

function resourceError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}
