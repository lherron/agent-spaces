#!/usr/bin/env bun
/**
 * Materialize an Agent Spaces agent into the default Codex home.
 *
 * This is intentionally an overlay, not a home replacement:
 * - ~/.codex/config.toml is never modified.
 * - ~/.codex/AGENTS.md is updated only inside this script's managed block.
 * - Existing skill directories win. Collisions warn and are skipped.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import type { AgentRuntimeProfile, RunMode, SpaceRefString } from 'spaces-config'
import { PathResolver, parseAgentProfile } from 'spaces-config'
import { detectAgentLocalComponents, materializeFromRefs } from 'spaces-execution'
import { materializeSystemPrompt } from 'spaces-runtime'

const PROJECT_ID = 'praesidium'
const TASK_ID = 'primary'
const RUN_MODE: RunMode = 'query'
const DEFAULT_AGENT = 'cody'
const DEFAULT_PROJECT_ROOT = join(homedir(), 'praesidium')
const DEFAULT_ASP_HOME = join(homedir(), 'praesidium/var/spaces-repo')
const DEFAULT_AGENTS_ROOT = join(homedir(), 'praesidium/var/agents')
const AGENT_BLOCK_PREFIX = 'agent-spaces:codex-default'
const SKILL_MARKER_FILE = '.asp-agent-sync.json'

export interface SyncAgentToCodexDefaultOptions {
  agentId: string
  codexHome: string
  aspHome: string
  agentsRoot: string
  projectRoot: string
  apply: boolean
  fetchRegistry: boolean
}

interface CliArgs extends SyncAgentToCodexDefaultOptions {
  json: boolean
  help: boolean
}

export interface SkillPlan {
  name: string
  sourcePath: string
  destPath: string
  action: 'copy' | 'update' | 'skip-collision'
  reason?: string | undefined
}

export interface AgentsPlan {
  path: string
  action: 'create' | 'update' | 'unchanged'
}

export interface SyncManifest {
  schemaVersion: 1
  owner: 'agent-spaces'
  agentId: string
  projectId: typeof PROJECT_ID
  taskId: typeof TASK_ID
  generatedAt: string
  agentRoot: string
  sourceHash: string
  managedSkills: string[]
  agentsPath: 'AGENTS.md'
}

export interface SyncPlan {
  agentId: string
  agentRoot: string
  codexHome: string
  aspHome: string
  projectId: typeof PROJECT_ID
  taskId: typeof TASK_ID
  targetName: string
  refs: string[]
  materializedHome: string
  agents: AgentsPlan
  skills: SkillPlan[]
  staleManagedSkills: string[]
  warnings: string[]
}

export interface SyncResult {
  applied: boolean
  plan: SyncPlan
}

function printUsage(): void {
  console.log(
    [
      'Sync an Agent Spaces agent into the default Codex home.',
      '',
      'Usage:',
      '  bun scripts/sync-agent-to-codex-default.ts [options]',
      '',
      'Options:',
      `  --agent <id>        Agent id (default: ${DEFAULT_AGENT})`,
      '  --to <path>         Codex home to overlay (default: ~/.codex)',
      `  --asp-home <path>   ASP_HOME (default: ${DEFAULT_ASP_HOME})`,
      `  --agents-root <p>   Agents root (default: ${DEFAULT_AGENTS_ROOT})`,
      `  --project-root <p>  Project root used in prompt context (default: ${DEFAULT_PROJECT_ROOT})`,
      '  --fetch            Fetch registry before materializing (default: false)',
      '  --apply            Write changes. Without this, dry-run only.',
      '  --json             Emit JSON summary.',
      '  --help             Show this help.',
      '',
      'Invariants:',
      `  projectId=${PROJECT_ID}`,
      `  taskId=${TASK_ID}`,
      `  runMode=${RUN_MODE}`,
      '',
      'Safety:',
      '  ~/.codex/config.toml is never modified.',
      '  Skill collisions warn and skip; they are not namespaced.',
    ].join('\n')
  )
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    agentId: DEFAULT_AGENT,
    codexHome: join(homedir(), '.codex'),
    aspHome: process.env['ASP_HOME'] ?? DEFAULT_ASP_HOME,
    agentsRoot: process.env['ASP_AGENTS_ROOT'] ?? DEFAULT_AGENTS_ROOT,
    projectRoot: DEFAULT_PROJECT_ROOT,
    apply: false,
    fetchRegistry: false,
    json: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue
    switch (arg) {
      case '--help':
      case '-h':
        args.help = true
        return args
      case '--agent':
        args.agentId = requiredValue(argv, ++i, arg)
        break
      case '--to':
        args.codexHome = expandHome(requiredValue(argv, ++i, arg))
        break
      case '--asp-home':
        args.aspHome = expandHome(requiredValue(argv, ++i, arg))
        break
      case '--agents-root':
        args.agentsRoot = expandHome(requiredValue(argv, ++i, arg))
        break
      case '--project-root':
        args.projectRoot = expandHome(requiredValue(argv, ++i, arg))
        break
      case '--fetch':
        args.fetchRegistry = true
        break
      case '--apply':
        args.apply = true
        break
      case '--json':
        args.json = true
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  args.codexHome = resolve(args.codexHome)
  args.aspHome = resolve(args.aspHome)
  args.agentsRoot = resolve(args.agentsRoot)
  args.projectRoot = resolve(args.projectRoot)
  return args
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`)
  }
  return value
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function isWithinPath(path: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}

function refsForProfile(profile: AgentRuntimeProfile): SpaceRefString[] {
  return dedupe([...(profile.spaces?.base ?? []), ...(profile.spaces?.byMode?.[RUN_MODE] ?? [])])
}

function readAgentProfile(agentRoot: string): AgentRuntimeProfile {
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) {
    throw new Error(`agent-profile.toml not found: ${profilePath}`)
  }
  const source = readFileSync(profilePath, 'utf8').replace(
    /^(\s*)schema_version(\s*=)/m,
    '$1schemaVersion$2'
  )
  return parseAgentProfile(source, profilePath)
}

function managedBlockMarkers(agentId: string): { begin: string; end: string } {
  return {
    begin: `<!-- BEGIN ${AGENT_BLOCK_PREFIX} agent=${agentId} -->`,
    end: `<!-- END ${AGENT_BLOCK_PREFIX} agent=${agentId} -->`,
  }
}

function stripOuterGeneratedHeader(content: string): string {
  return content.replace(/^<!-- Generated by agent-spaces\. -->\s*/u, '').trim()
}

function buildManagedAgentsBlock(input: {
  agentId: string
  agentRoot: string
  materializedAgents: string
  systemPrompt: string
  reminderContent?: string | undefined
}): string {
  const markers = managedBlockMarkers(input.agentId)
  const chunks: string[] = [
    markers.begin,
    '<!-- Managed by scripts/sync-agent-to-codex-default.ts. Edit agent source files, then rerun the script. -->',
    `<!-- Source agent root: ${input.agentRoot} -->`,
  ]

  const materializedAgents = stripOuterGeneratedHeader(input.materializedAgents)
  if (materializedAgents.length > 0) {
    chunks.push('', '<!-- BEGIN materialized codex AGENTS.md -->', materializedAgents)
    chunks.push('<!-- END materialized codex AGENTS.md -->')
  }

  const promptSections = [input.systemPrompt.trim(), input.reminderContent?.trim() ?? ''].filter(
    Boolean
  )
  if (promptSections.length > 0) {
    chunks.push('', '<!-- BEGIN praesidium-context -->')
    chunks.push(promptSections.join('\n\n'))
    chunks.push('<!-- END praesidium-context -->')
  }

  chunks.push(markers.end, '')
  return chunks.join('\n')
}

function replaceManagedBlock(existing: string, block: string, agentId: string): string {
  const markers = managedBlockMarkers(agentId)
  const beginIndex = existing.indexOf(markers.begin)
  if (beginIndex === -1) {
    const trimmed = existing.trimEnd()
    return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block
  }

  const endIndex = existing.indexOf(markers.end, beginIndex)
  if (endIndex === -1) {
    throw new Error(`Found ${markers.begin} without matching ${markers.end}`)
  }

  const afterEnd = endIndex + markers.end.length
  const before = existing.slice(0, beginIndex).trimEnd()
  const after = existing.slice(afterEnd).trimStart()
  return `${[before, block.trimEnd(), after].filter((part) => part.length > 0).join('\n\n')}\n`
}

function hashString(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function loadManifest(manifestPath: string): Promise<SyncManifest | undefined> {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8')) as SyncManifest
  } catch {
    return undefined
  }
}

function skillMarker(agentId: string, sourcePath: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      owner: 'agent-spaces',
      agentId,
      kind: 'skill',
      sourcePath,
    },
    null,
    2
  )}\n`
}

async function hasManagedSkillMarker(skillDir: string, agentId: string): Promise<boolean> {
  const markerPath = join(skillDir, SKILL_MARKER_FILE)
  try {
    const parsed = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>
    return parsed['owner'] === 'agent-spaces' && parsed['agentId'] === agentId
  } catch {
    return false
  }
}

async function listSkillDirs(skillsDir: string): Promise<string[]> {
  if (!(await pathExists(skillsDir))) return []
  const entries = await readdir(skillsDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

async function planSkills(input: {
  sourceSkillsDir: string
  destSkillsDir: string
  agentId: string
  previousManifest?: SyncManifest | undefined
}): Promise<{ skills: SkillPlan[]; staleManagedSkills: string[]; warnings: string[] }> {
  const warnings: string[] = []
  const sourceNames = await listSkillDirs(input.sourceSkillsDir)
  const previousManaged = new Set(input.previousManifest?.managedSkills ?? [])
  const sourceSet = new Set(sourceNames)
  const staleManagedSkills = [...previousManaged].filter((name) => !sourceSet.has(name)).sort()

  const skills: SkillPlan[] = []
  for (const name of sourceNames) {
    const sourcePath = join(input.sourceSkillsDir, name)
    const destPath = join(input.destSkillsDir, name)
    const destExists = await pathExists(destPath)
    if (!destExists) {
      skills.push({ name, sourcePath, destPath, action: 'copy' })
      continue
    }

    const managed =
      previousManaged.has(name) || (await hasManagedSkillMarker(destPath, input.agentId))
    if (managed) {
      skills.push({ name, sourcePath, destPath, action: 'update' })
      continue
    }

    const reason = `skill "${name}" already exists in target; leaving existing skill unchanged`
    warnings.push(reason)
    skills.push({ name, sourcePath, destPath, action: 'skip-collision', reason })
  }

  return { skills, staleManagedSkills, warnings }
}

async function materializeAgent(input: {
  agentId: string
  agentRoot: string
  aspHome: string
  projectRoot: string
  fetchRegistry: boolean
}): Promise<{
  targetName: string
  refs: string[]
  outputPath: string
  codexHome: string
  agentsPath: string
  skillsDir: string
  systemPrompt: string
  reminderContent?: string | undefined
}> {
  process.env['ASP_HOME'] = input.aspHome
  const paths = new PathResolver({ aspHome: input.aspHome })
  const profile = readAgentProfile(input.agentRoot)
  const refs = refsForProfile(profile)
  const targetName = `codex-default-${input.agentId}`
  const agentLocalComponents = await detectAgentLocalComponents(input.agentRoot)
  const lockPath = join(paths.temp, `${targetName}.lock.json`)
  const materialized = await materializeFromRefs({
    targetName,
    refs,
    registryPath: paths.repo,
    aspHome: input.aspHome,
    lockPath,
    harness: 'codex',
    fetchRegistry: input.fetchRegistry,
    projectPath: input.projectRoot,
    agentRoot: input.agentRoot,
    projectRoot: input.projectRoot,
    ...(agentLocalComponents ? { agentLocalComponents } : {}),
  })

  const codexHome = join(materialized.materialization.outputPath, 'codex.home')
  const systemPrompt = await materializeSystemPrompt(materialized.materialization.outputPath, {
    agentRoot: input.agentRoot,
    agentId: input.agentId,
    projectRoot: input.projectRoot,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    runMode: RUN_MODE,
  })

  return {
    targetName,
    refs,
    outputPath: materialized.materialization.outputPath,
    codexHome,
    agentsPath: join(codexHome, 'AGENTS.md'),
    skillsDir: join(codexHome, 'skills'),
    systemPrompt: systemPrompt?.content ?? '',
    reminderContent: systemPrompt?.reminderContent,
  }
}

async function buildPlan(args: SyncAgentToCodexDefaultOptions): Promise<SyncPlan> {
  const agentRoot = join(args.agentsRoot, args.agentId)
  if (!(await pathExists(agentRoot))) {
    throw new Error(`Agent root not found: ${agentRoot}`)
  }

  const materialized = await materializeAgent({
    agentId: args.agentId,
    agentRoot,
    aspHome: args.aspHome,
    projectRoot: args.projectRoot,
    fetchRegistry: args.fetchRegistry,
  })

  const materializedAgents = await readFile(materialized.agentsPath, 'utf8')
  const managedBlock = buildManagedAgentsBlock({
    agentId: args.agentId,
    agentRoot,
    materializedAgents,
    systemPrompt: materialized.systemPrompt,
    reminderContent: materialized.reminderContent,
  })
  const agentsPath = join(args.codexHome, 'AGENTS.md')
  const existingAgents = (await pathExists(agentsPath)) ? await readFile(agentsPath, 'utf8') : ''
  const nextAgents = replaceManagedBlock(existingAgents, managedBlock, args.agentId)
  const agentsAction: AgentsPlan['action'] =
    existingAgents.length === 0 ? 'create' : nextAgents === existingAgents ? 'unchanged' : 'update'

  const manifestPath = join(args.codexHome, '.asp-agent-sync', `${args.agentId}.json`)
  const previousManifest = await loadManifest(manifestPath)
  const skillPlan = await planSkills({
    sourceSkillsDir: materialized.skillsDir,
    destSkillsDir: join(args.codexHome, 'skills'),
    agentId: args.agentId,
    previousManifest,
  })

  return {
    agentId: args.agentId,
    agentRoot,
    codexHome: args.codexHome,
    aspHome: args.aspHome,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    targetName: materialized.targetName,
    refs: materialized.refs,
    materializedHome: materialized.codexHome,
    agents: {
      path: agentsPath,
      action: agentsAction,
    },
    skills: skillPlan.skills,
    staleManagedSkills: skillPlan.staleManagedSkills,
    warnings: skillPlan.warnings,
  }
}

async function removeManagedSkillIfSafe(
  codexHome: string,
  agentId: string,
  name: string
): Promise<void> {
  const destPath = join(codexHome, 'skills', name)
  if (!(await hasManagedSkillMarker(destPath, agentId))) return
  await rm(destPath, { recursive: true, force: true })
}

async function writeSkill(plan: SkillPlan, agentId: string): Promise<void> {
  await rm(plan.destPath, { recursive: true, force: true })
  await mkdir(dirname(plan.destPath), { recursive: true })
  await cp(plan.sourcePath, plan.destPath, { recursive: true })
  await writeFile(join(plan.destPath, SKILL_MARKER_FILE), skillMarker(agentId, plan.sourcePath))
}

async function assertWritableTarget(path: string, codexHome: string): Promise<void> {
  if (!isWithinPath(path, codexHome)) {
    throw new Error(`Refusing to write outside Codex home: ${path}`)
  }
  if (await pathExists(path)) {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symlink in Codex home: ${path}`)
    }
  }
}

async function applyPlan(plan: SyncPlan): Promise<void> {
  await mkdir(plan.codexHome, { recursive: true })
  await mkdir(join(plan.codexHome, '.asp-agent-sync'), { recursive: true })

  const materializedAgents = await readFile(join(plan.materializedHome, 'AGENTS.md'), 'utf8')
  const systemPromptPath = join(dirname(plan.materializedHome), 'system-prompt.md')
  const reminderPath = join(dirname(plan.materializedHome), 'session-reminder.md')
  const systemPrompt = (await pathExists(systemPromptPath))
    ? await readFile(systemPromptPath, 'utf8')
    : ''
  const reminderContent = (await pathExists(reminderPath))
    ? await readFile(reminderPath, 'utf8')
    : undefined
  const block = buildManagedAgentsBlock({
    agentId: plan.agentId,
    agentRoot: plan.agentRoot,
    materializedAgents,
    systemPrompt,
    reminderContent,
  })
  const existingAgents = (await pathExists(plan.agents.path))
    ? await readFile(plan.agents.path, 'utf8')
    : ''
  await assertWritableTarget(plan.agents.path, plan.codexHome)
  await writeFile(plan.agents.path, replaceManagedBlock(existingAgents, block, plan.agentId))

  for (const name of plan.staleManagedSkills) {
    await removeManagedSkillIfSafe(plan.codexHome, plan.agentId, name)
  }

  for (const skill of plan.skills) {
    if (skill.action === 'skip-collision') continue
    await assertWritableTarget(skill.destPath, plan.codexHome)
    await writeSkill(skill, plan.agentId)
  }

  const managedSkills = plan.skills
    .filter((skill) => skill.action !== 'skip-collision')
    .map((skill) => skill.name)
    .sort()
  const manifest: SyncManifest = {
    schemaVersion: 1,
    owner: 'agent-spaces',
    agentId: plan.agentId,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    generatedAt: new Date().toISOString(),
    agentRoot: plan.agentRoot,
    sourceHash: hashString(JSON.stringify({ refs: plan.refs, skills: managedSkills })),
    managedSkills,
    agentsPath: 'AGENTS.md',
  }
  await writeFile(
    join(plan.codexHome, '.asp-agent-sync', `${plan.agentId}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
}

export async function syncAgentToCodexDefault(
  args: SyncAgentToCodexDefaultOptions
): Promise<SyncResult> {
  const plan = await buildPlan(args)
  if (args.apply) {
    await applyPlan(plan)
  }
  return { applied: args.apply, plan }
}

function renderHuman(result: SyncResult): void {
  const { plan } = result
  console.log(
    result.applied ? 'Applied Codex default sync.' : 'Dry-run only; pass --apply to write.'
  )
  console.log(`agent:        ${plan.agentId}`)
  console.log(`project/task: ${plan.projectId}/${plan.taskId}`)
  console.log(`codex home:   ${plan.codexHome}`)
  console.log(`source home:  ${plan.materializedHome}`)
  console.log('config.toml:  untouched')
  console.log(`AGENTS.md:    ${plan.agents.action}`)
  console.log(`spaces:       ${plan.refs.length > 0 ? plan.refs.join(', ') : '(none)'}`)

  const copied = plan.skills.filter((skill) => skill.action === 'copy')
  const updated = plan.skills.filter((skill) => skill.action === 'update')
  const skipped = plan.skills.filter((skill) => skill.action === 'skip-collision')
  console.log(
    `skills:       copy=${copied.length} update=${updated.length} skipped=${skipped.length}`
  )
  if (plan.staleManagedSkills.length > 0) {
    console.log(`stale:        ${plan.staleManagedSkills.join(', ')}`)
  }
  for (const warning of plan.warnings) {
    console.warn(`warning: ${warning}`)
  }
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
      printUsage()
      process.exit(0)
    }
    const result = await syncAgentToCodexDefault(args)
    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      renderHuman(result)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
