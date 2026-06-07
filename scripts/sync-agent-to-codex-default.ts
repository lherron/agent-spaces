#!/usr/bin/env bun
/**
 * Materialize an Agent Spaces agent into the default Codex home.
 *
 * This is intentionally an overlay, not a home replacement:
 * - ~/.codex/config.toml is never modified.
 * - ~/.codex/AGENTS.md is updated only inside this script's managed block.
 * - Existing unmanaged skill directories win. Collisions warn and are skipped.
 * - Managed skill directories carry a marker and are replaced only when clean.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import type { AgentRuntimeProfile, RunMode, SpaceRefString } from 'spaces-config'
import { PathResolver, parseAgentProfile } from 'spaces-config'
import { detectAgentLocalComponents, materializeFromRefs } from 'spaces-execution'
import { buildCodexHookTrustState } from 'spaces-harness-codex'
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
const CODEX_HOOKS_FILE = 'hooks.json'
const CODEX_CONFIG_FILE = 'config.toml'
const PRE_TOOL_USE_HOOK_FILENAME = 'pre-tool-use-praesidium-env.mjs'
const PRE_TOOL_USE_STATUS = 'injecting Praesidium command env'
const CODEX_APP_OVERLAY_ENV = 'ASP_CODEX_APP_OVERLAY'

export interface SyncAgentToCodexDefaultOptions {
  agentId: string
  codexHome: string
  aspHome: string
  agentsRoot: string
  projectRoot: string
  apply: boolean
  fetchRegistry: boolean
  installHooks: boolean
}

interface CliArgs extends SyncAgentToCodexDefaultOptions {
  json: boolean
  help: boolean
}

export interface SkillPlan {
  name: string
  sourcePath: string
  destPath: string
  action: 'copy' | 'update' | 'skip-collision' | 'skip-dirty-managed'
  reason?: string | undefined
}

export interface AgentsPlan {
  path: string
  action: 'create' | 'update' | 'unchanged'
}

export interface HooksPlan {
  enabled: boolean
  hooksPath: string
  configPath: string
  scriptPath: string
  hooksAction: 'create' | 'update' | 'unchanged' | 'skip'
  configAction: 'create' | 'update' | 'unchanged' | 'skip'
  scriptAction: 'create' | 'update' | 'unchanged' | 'skip'
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
  hooks: HooksPlan
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
      '  --install-hooks    Install managed Codex PreToolUse hook for Praesidium CLI env injection',
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
      '  ~/.codex/config.toml is modified only with --install-hooks.',
      '  Markerless skill collisions warn and skip; they are not namespaced.',
      '  Managed skills are overwritten only when their marker hash still matches.',
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
    installHooks: false,
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
      case '--install-hooks':
        args.installHooks = true
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

function hookCommand(scriptPath: string): string {
  return `node ${shellQuote(scriptPath)}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function buildPreToolUseHookScript(agentId: string, aspHome: string): string {
  const escapedAgentId = JSON.stringify(agentId)
  const escapedAspHome = JSON.stringify(aspHome)
  return `#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const AGENT_ID = ${escapedAgentId}
const DEFAULT_ASP_HOME = ${escapedAspHome}
const PRAESIDIUM_COMMANDS = new Set(['asp', 'wrkq', 'wrkf', 'hrc', 'hrcchat', 'acp'])

function readStdin() {
  return new Promise((resolveText) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolveText(data))
  })
}

function shellQuote(value) {
  return \`'\${String(value).replace(/'/g, "'\\\\''")}'\`
}

function readEnvLocalValue(startDir, names) {
  const wanted = new Set(names)
  let dir = resolve(startDir || process.cwd())
  while (true) {
    const candidate = join(dir, '.env.local')
    if (existsSync(candidate)) {
      const lines = readFileSync(candidate, 'utf8').split(/\\r?\\n/u)
      const values = new Map()
      for (const line of lines) {
        const match = /^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.+?)\\s*$/u.exec(line)
        if (!match || !wanted.has(match[1])) continue
        values.set(match[1], match[2].replace(/^['"]|['"]$/g, ''))
      }
      for (const name of names) {
        if (values.has(name)) return values.get(name)
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function readEnvLocalProject(startDir) {
  return readEnvLocalValue(startDir, ['WRKQ_PROJECT_ROOT'])
}

function readEnvLocalAspHome(startDir) {
  return readEnvLocalValue(startDir, ['ASP_HOME', 'ASP_ROOT_DIR'])
}

function projectFromPraesidiumPath(cwd) {
  const root = join(homedir(), 'praesidium')
  const resolved = resolve(cwd || process.cwd())
  if (resolved === root) return 'praesidium'
  if (!resolved.startsWith(root + '/')) return undefined
  const rest = resolved.slice(root.length + 1)
  const first = rest.split('/')[0]
  return first || undefined
}

function projectFromWrkqProjects(cwd) {
  try {
    const raw = execFileSync('wrkq', ['projects', '--json'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const rows = JSON.parse(raw)
    const resolved = resolve(cwd)
    const root = join(homedir(), 'praesidium')
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeof row?.path !== 'string' || typeof row?.slug !== 'string') continue
      const path = row.path.startsWith('/') ? row.path : join(root, row.path)
      if (resolved === path || resolved.startsWith(path + '/')) {
        return row.slug
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

function projectFromGitRemote(cwd) {
  try {
    const raw = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const tail = raw.split(/[/:]/u).pop() || ''
    return tail.replace(/\\.git$/u, '') || undefined
  } catch {
    return undefined
  }
}

function resolveProject(cwd) {
  return (
    readEnvLocalProject(cwd) ||
    projectFromPraesidiumPath(cwd) ||
    projectFromWrkqProjects(cwd) ||
    projectFromGitRemote(cwd) ||
    basename(resolve(cwd || process.cwd()))
  )
}

function resolveAspHome(cwd) {
  return readEnvLocalAspHome(cwd) || process.env.ASP_HOME || DEFAULT_ASP_HOME
}

function splitShellSegments(command) {
  const segments = []
  let current = ''
  let quote = undefined
  let escaped = false

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]
    const next = command[i + 1]
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\\\' && quote !== "'") {
      current += char
      escaped = true
      continue
    }
    if (quote) {
      current += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') {
      current += char
      quote = char
      continue
    }
    if (char === '&' && next === '&') {
      segments.push(current)
      current = ''
      i += 1
      continue
    }
    if (char === '|' && next === '|') {
      segments.push(current)
      current = ''
      i += 1
      continue
    }
    if (char === ';' || char === '|' || char === '(' || char === ')' || char === '\\n') {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)
  return segments
}

function tokenizeShellWords(segment) {
  const words = []
  let current = ''
  let quote = undefined
  let escaped = false

  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i]
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = undefined
      } else {
        current += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\\s/u.test(char)) {
      if (current.length > 0) {
        words.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current.length > 0) words.push(current)
  return words
}

function isAssignment(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)
}

function commandName(word) {
  return basename(word)
}

function firstCommandWord(words) {
  let index = 0
  while (index < words.length && isAssignment(words[index])) index += 1
  if (words[index] === 'command' || words[index] === 'exec') index += 1
  if (words[index] === 'env') {
    index += 1
    while (index < words.length && (words[index].startsWith('-') || isAssignment(words[index]))) {
      index += 1
    }
  }
  return words[index]
}

function usesPraesidiumCommand(command) {
  for (const segment of splitShellSegments(command)) {
    const words = tokenizeShellWords(segment)
    const first = firstCommandWord(words)
    if (first && PRAESIDIUM_COMMANDS.has(commandName(first))) {
      return true
    }
  }
  return false
}

function resolvedScope(input) {
  const cwd = input.cwd || process.cwd()
  const project = resolveProject(cwd)
  const aspHome = resolveAspHome(cwd)
  const sessionId = String(input.session_id || 'codex-app')
  const taskId = sessionId.startsWith('codex-') ? sessionId : \`codex-\${sessionId}\`
  const scopeRef = \`agent:\${AGENT_ID}:project:\${project}:task:\${taskId}\`
  const sessionRef = \`\${scopeRef}/lane:main\`
  const entries = {
    ASP_AGENT_ID: AGENT_ID,
    ASP_HOME: aspHome,
    ASP_PROJECT: project,
    ASP_TASK_ID: taskId,
    ASP_SCOPE_REF: scopeRef,
    HRC_SESSION_REF: sessionRef,
  }
  const exportsLine =
    'export ' +
    Object.entries(entries)
      .map(([key, value]) => \`\${key}=\${shellQuote(value)}\`)
      .join(' ')
  return { project, aspHome, taskId, scopeRef, sessionRef, exportsLine }
}

const raw = await readStdin()
if (raw.trim().length === 0) process.exit(0)

let input
try {
  input = JSON.parse(raw)
} catch {
  process.exit(0)
}

if (input.hook_event_name !== 'PreToolUse') process.exit(0)
if (input.tool_name !== 'Bash') process.exit(0)

const command = input.tool_input?.command
if (typeof command !== 'string' || command.trim().length === 0) process.exit(0)
if (!usesPraesidiumCommand(command)) process.exit(0)

const scope = resolvedScope(input)
const updatedCommand = \`\${scope.exportsLine}
\${command}\`

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: \`Praesidium env: ASP_PROJECT=\${scope.project}, ASP_HOME=\${scope.aspHome}, ASP_SCOPE_REF=\${scope.scopeRef}\`,
      updatedInput: { command: updatedCommand },
    },
  })
)
`
}

function buildManagedPreToolUseHookGroup(scriptPath: string): Record<string, unknown> {
  return {
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: hookCommand(scriptPath),
        statusMessage: PRE_TOOL_USE_STATUS,
      },
    ],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizeHooksConfig(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return { hooks: {} }
  }
  const hooks = isRecord(value['hooks']) ? value['hooks'] : {}
  return { ...value, hooks: { ...hooks } }
}

function handlerCommand(handler: unknown): string | undefined {
  return isRecord(handler) && typeof handler['command'] === 'string'
    ? handler['command']
    : undefined
}

function removeManagedPreToolUseHook(
  groups: unknown,
  managedCommand: string
): Array<Record<string, unknown>> {
  if (!Array.isArray(groups)) {
    return []
  }

  const nextGroups: Array<Record<string, unknown>> = []
  for (const group of groups) {
    if (!isRecord(group)) continue
    const handlers = Array.isArray(group['hooks']) ? group['hooks'] : []
    const nextHandlers = handlers.filter((handler) => handlerCommand(handler) !== managedCommand)
    if (nextHandlers.length === 0) continue
    nextGroups.push({ ...group, hooks: nextHandlers })
  }
  return nextGroups
}

function mergeManagedHooksConfig(existing: string, scriptPath: string): string {
  let parsed: unknown = {}
  if (existing.trim().length > 0) {
    parsed = JSON.parse(existing) as unknown
  }
  const config = normalizeHooksConfig(parsed)
  const hooks = config['hooks'] as Record<string, unknown>
  const managedCommand = hookCommand(scriptPath)
  hooks['PreToolUse'] = [
    ...removeManagedPreToolUseHook(hooks['PreToolUse'], managedCommand),
    buildManagedPreToolUseHookGroup(scriptPath),
  ]
  return `${JSON.stringify(config, null, 2)}\n`
}

function ensureHooksFeature(configToml: string): string {
  const lines = configToml.split('\n')
  let featuresStart = -1
  let featuresEnd = lines.length
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*\[features\]\s*$/u.test(lines[i])) {
      featuresStart = i
      continue
    }
    if (featuresStart !== -1 && i > featuresStart && /^\s*\[.*\]\s*$/u.test(lines[i])) {
      featuresEnd = i
      break
    }
  }

  if (featuresStart === -1) {
    const suffix = configToml.endsWith('\n') || configToml.length === 0 ? '' : '\n'
    return `${configToml}${suffix}\n[features]\nhooks = true\n`
  }

  for (let i = featuresStart + 1; i < featuresEnd; i += 1) {
    if (/^\s*hooks\s*=/u.test(lines[i])) {
      if (/^\s*hooks\s*=\s*true\s*(?:#.*)?$/u.test(lines[i])) {
        return configToml
      }
      lines[i] = 'hooks = true'
      return lines.join('\n')
    }
  }

  lines.splice(featuresStart + 1, 0, 'hooks = true')
  return lines.join('\n')
}

function upsertTrustedHookState(
  configToml: string,
  hooksPath: string,
  hooksConfigJson: string
): string {
  const hooksConfig = JSON.parse(hooksConfigJson) as Record<string, unknown>
  const trustState = buildCodexHookTrustState(hooksPath, hooksConfig)
  let next = ensureHooksFeature(configToml)

  for (const [key, value] of Object.entries(trustState)) {
    const table = `[hooks.state.${JSON.stringify(key)}]`
    const lines = next.split('\n')
    const start = lines.findIndex((line) => line.trim() === table)
    if (start === -1) {
      const suffix = next.endsWith('\n') || next.length === 0 ? '' : '\n'
      next = `${next}${suffix}\n${table}\ntrusted_hash = ${JSON.stringify(value.trusted_hash)}\n`
      continue
    }

    let end = lines.length
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\s*\[.*\]\s*$/u.test(lines[i])) {
        end = i
        break
      }
    }
    let found = false
    for (let i = start + 1; i < end; i += 1) {
      if (/^\s*trusted_hash\s*=/u.test(lines[i])) {
        lines[i] = `trusted_hash = ${JSON.stringify(value.trusted_hash)}`
        found = true
        break
      }
    }
    if (!found) {
      lines.splice(start + 1, 0, `trusted_hash = ${JSON.stringify(value.trusted_hash)}`)
    }
    next = lines.join('\n')
  }

  return next.endsWith('\n') ? next : `${next}\n`
}

async function buildHooksPlan(input: {
  codexHome: string
  agentId: string
  aspHome: string
  installHooks: boolean
}): Promise<HooksPlan> {
  const hooksPath = join(input.codexHome, CODEX_HOOKS_FILE)
  const configPath = join(input.codexHome, CODEX_CONFIG_FILE)
  const scriptPath = join(input.codexHome, '.asp-agent-sync', PRE_TOOL_USE_HOOK_FILENAME)

  if (!input.installHooks) {
    return {
      enabled: false,
      hooksPath,
      configPath,
      scriptPath,
      hooksAction: 'skip',
      configAction: 'skip',
      scriptAction: 'skip',
    }
  }

  const existingHooks = (await pathExists(hooksPath)) ? await readFile(hooksPath, 'utf8') : ''
  const nextHooks = mergeManagedHooksConfig(existingHooks, scriptPath)
  const existingScript = (await pathExists(scriptPath)) ? await readFile(scriptPath, 'utf8') : ''
  const nextScript = buildPreToolUseHookScript(input.agentId, input.aspHome)
  const existingConfig = (await pathExists(configPath)) ? await readFile(configPath, 'utf8') : ''
  const nextConfig = upsertTrustedHookState(existingConfig, hooksPath, nextHooks)

  return {
    enabled: true,
    hooksPath,
    configPath,
    scriptPath,
    hooksAction:
      existingHooks.length === 0 ? 'create' : existingHooks === nextHooks ? 'unchanged' : 'update',
    configAction:
      existingConfig.length === 0
        ? 'create'
        : existingConfig === nextConfig
          ? 'unchanged'
          : 'update',
    scriptAction:
      existingScript.length === 0
        ? 'create'
        : existingScript === nextScript
          ? 'unchanged'
          : 'update',
  }
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

interface SkillMarker {
  schemaVersion: 1
  owner: 'agent-spaces'
  kind: 'codex-skill' | 'skill'
  agentId: string
  skillName?: string | undefined
  contentHash?: string | undefined
}

interface ManagedSkillState {
  marker: SkillMarker
  dirty: boolean
  currentHash?: string | undefined
}

async function hashSkillDirectory(skillDir: string): Promise<string> {
  const hash = createHash('sha256')

  async function walk(dir: string, relDir: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )

    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
      if (relPath === SKILL_MARKER_FILE) continue

      const path = join(dir, entry.name)
      const stats = await lstat(path)

      if (stats.isDirectory()) {
        hash.update(`dir\u0000${relPath}\u0000`)
        await walk(path, relPath)
        continue
      }

      if (stats.isSymbolicLink()) {
        hash.update(`symlink\u0000${relPath}\u0000${await readlink(path)}\u0000`)
        continue
      }

      if (stats.isFile()) {
        hash.update(`file\u0000${relPath}\u0000`)
        hash.update(await readFile(path))
        hash.update('\u0000')
        continue
      }

      hash.update(`other\u0000${relPath}\u0000${stats.mode}\u0000${stats.size}\u0000`)
    }
  }

  await walk(skillDir, '')
  return `sha256:${hash.digest('hex')}`
}

function skillMarker(agentId: string, skillName: string, contentHash: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      owner: 'agent-spaces',
      agentId,
      kind: 'codex-skill',
      skillName,
      contentHash,
    },
    null,
    2
  )}\n`
}

async function readManagedSkillState(
  skillDir: string,
  agentId: string
): Promise<ManagedSkillState | undefined> {
  const markerPath = join(skillDir, SKILL_MARKER_FILE)
  try {
    const parsed = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>
    if (parsed['owner'] !== 'agent-spaces') return undefined
    if (parsed['agentId'] !== agentId) return undefined
    if (parsed['kind'] !== 'codex-skill' && parsed['kind'] !== 'skill') return undefined

    const marker: SkillMarker = {
      schemaVersion: 1,
      owner: 'agent-spaces',
      kind: parsed['kind'],
      agentId,
      ...(typeof parsed['skillName'] === 'string' ? { skillName: parsed['skillName'] } : {}),
      ...(typeof parsed['contentHash'] === 'string' ? { contentHash: parsed['contentHash'] } : {}),
    }

    if (marker.contentHash === undefined) {
      return { marker, dirty: false }
    }

    const currentHash = await hashSkillDirectory(skillDir)
    return { marker, dirty: currentHash !== marker.contentHash, currentHash }
  } catch {
    return undefined
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

    const managed = await readManagedSkillState(destPath, input.agentId)
    if (managed && !managed.dirty) {
      skills.push({ name, sourcePath, destPath, action: 'update' })
      continue
    }

    if (managed?.dirty) {
      const reason = `skill "${name}" has local edits since the last overlay; leaving existing skill unchanged`
      warnings.push(reason)
      skills.push({ name, sourcePath, destPath, action: 'skip-dirty-managed', reason })
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
    env: { ...process.env, [CODEX_APP_OVERLAY_ENV]: '1' },
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
  const hooksPlan = await buildHooksPlan({
    codexHome: args.codexHome,
    agentId: args.agentId,
    aspHome: args.aspHome,
    installHooks: args.installHooks,
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
    hooks: hooksPlan,
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
  const managed = await readManagedSkillState(destPath, agentId)
  if (!managed || managed.dirty) return
  await rm(destPath, { recursive: true, force: true })
}

async function writeSkill(plan: SkillPlan, agentId: string): Promise<void> {
  await rm(plan.destPath, { recursive: true, force: true })
  await mkdir(dirname(plan.destPath), { recursive: true })
  await cp(plan.sourcePath, plan.destPath, { recursive: true })
  const contentHash = await hashSkillDirectory(plan.destPath)
  await writeFile(
    join(plan.destPath, SKILL_MARKER_FILE),
    skillMarker(agentId, plan.name, contentHash)
  )
}

async function applyHooksPlan(plan: SyncPlan): Promise<void> {
  if (!plan.hooks.enabled) {
    return
  }

  const hookScript = buildPreToolUseHookScript(plan.agentId, plan.aspHome)
  const existingHooks = (await pathExists(plan.hooks.hooksPath))
    ? await readFile(plan.hooks.hooksPath, 'utf8')
    : ''
  const hooksJson = mergeManagedHooksConfig(existingHooks, plan.hooks.scriptPath)
  const existingConfig = (await pathExists(plan.hooks.configPath))
    ? await readFile(plan.hooks.configPath, 'utf8')
    : ''
  const configToml = upsertTrustedHookState(existingConfig, plan.hooks.hooksPath, hooksJson)

  await assertWritableTarget(plan.hooks.scriptPath, plan.codexHome)
  await assertWritableTarget(plan.hooks.hooksPath, plan.codexHome)
  await assertWritableTarget(plan.hooks.configPath, plan.codexHome)
  await mkdir(dirname(plan.hooks.scriptPath), { recursive: true })
  await writeFile(plan.hooks.scriptPath, hookScript, { mode: 0o755 })
  await writeFile(plan.hooks.hooksPath, hooksJson)
  await writeFile(plan.hooks.configPath, configToml)
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
    if (skill.action === 'skip-collision' || skill.action === 'skip-dirty-managed') continue
    await assertWritableTarget(skill.destPath, plan.codexHome)
    await writeSkill(skill, plan.agentId)
  }

  await applyHooksPlan(plan)

  const managedSkills = plan.skills
    .filter((skill) => skill.action === 'copy' || skill.action === 'update')
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
  console.log(`config.toml:  ${plan.hooks.enabled ? plan.hooks.configAction : 'untouched'}`)
  console.log(`AGENTS.md:    ${plan.agents.action}`)
  console.log(`spaces:       ${plan.refs.length > 0 ? plan.refs.join(', ') : '(none)'}`)

  const copied = plan.skills.filter((skill) => skill.action === 'copy')
  const updated = plan.skills.filter((skill) => skill.action === 'update')
  const skipped = plan.skills.filter(
    (skill) => skill.action === 'skip-collision' || skill.action === 'skip-dirty-managed'
  )
  console.log(
    `skills:       copy=${copied.length} update=${updated.length} skipped=${skipped.length}`
  )
  console.log(
    plan.hooks.enabled
      ? `hooks:        hooks.json=${plan.hooks.hooksAction} script=${plan.hooks.scriptAction}`
      : 'hooks:        skipped'
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
