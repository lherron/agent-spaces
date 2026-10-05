import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { promisify } from 'node:util'

import { parseScopeRef } from 'agent-scope'
import chalk from 'chalk'
import type { Command } from 'commander'
import type { HarnessInvocationSpec } from 'spaces-harness-broker-protocol'
import { readPraesidiumContextBlock } from 'spaces-harness-codex'

import { exitWithAspError } from '../helpers.js'

const execFileAsync = promisify(execFile)
const SECTION_SEPARATOR = '\n\n---\n\n'
const DEFAULT_HRC_DB = '/Users/lherron/praesidium/var/state/hrc/state.sqlite'
const DEFAULT_AGENTS_ROOT = '/Users/lherron/praesidium/var/agents'
const MS_PER_DAY = 24 * 60 * 60 * 1000
const SQLITE_MAX_BUFFER = 128 * 1024 * 1024

interface TokenRentOptions {
  agent?: string | undefined
  fleet?: boolean | undefined
  json?: boolean | undefined
  hrcDb?: string | undefined
  agentsRoot?: string | undefined
  usageSince?: string | undefined
  since?: string | undefined
  now?: string | undefined
}

interface RunUsage {
  agent: string
  runs: number
  sessionsPerDay: number
  firstRunAt: string | null
  lastRunAt: string | null
}

interface PlanArtifact {
  agent: string
  scopeRef: string
  createdAt: string
  /** File the resident prompt was read from (system-prompt.md, or a codex home's AGENTS.md). */
  systemPromptFile: string
  /** The resident prompt itself; for codex, only the praesidium-context block. */
  prompt: string
  harness?: string | undefined
  invocationId: string
}

export interface PromptSectionRent {
  index: number
  label: string
  source: string
  chars: number
  bytes: number
  tokens: number
  sessionsPerDay: number
  tokensPerDay: number
  preview: string
}

interface AgentRentReport {
  agent: string
  runs: number
  sessionsPerDay: number
  usageWindowDays: number
  scopeRef?: string | undefined
  systemPromptFile?: string | undefined
  planCreatedAt?: string | undefined
  invocationId?: string | undefined
  harness?: string | undefined
  residentTokens: number
  residentTokensPerDay: number
  sections: PromptSectionRent[]
  missingPromptArtifact?: string | undefined
  /** Resident prompt text; internal to report building, never serialized. */
  prompt?: string | undefined
}

interface FleetRollupRow {
  source: string
  tokens: number
  tokensPerDay: number
  agents: string[]
}

interface TopLineRow {
  source: string
  preview: string
  tokens: number
  tokensPerDay: number
  agents: string[]
}

interface DeadLayerCandidate {
  path: string
  regime: 'resident-zero' | 'session-start'
  tokens: number
  reason: string
}

interface DeltaRow {
  path: string
  regime: 'resident' | 'session-start' | 'unknown'
  beforeTokens: number
  afterTokens: number
  deltaTokens: number
  estimatedTokensPerDay: number
}

interface TokenRentReport {
  generatedAt: string
  usageSince: string
  usageNow: string
  usageWindowDays: number
  hrcDb: string
  agentsRoot: string
  agents: AgentRentReport[]
  fleetRollup: FleetRollupRow[]
  topLines: TopLineRow[]
  deadLayerCandidates: DeadLayerCandidate[]
  delta?: { since: string; rows: DeltaRow[] } | undefined
}

interface RunsRow {
  agent_id?: string | undefined
  runs?: number | undefined
  first_run_at?: string | null | undefined
  last_run_at?: string | null | undefined
}

interface InvocationRow {
  invocation_id?: string | undefined
  created_at?: string | undefined
  spec_projection_json?: string | null | undefined
}

type InvocationPromptSpec = Partial<
  Pick<HarnessInvocationSpec, 'harness' | 'process' | 'launch' | 'correlation'>
>

function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / 4)
}

function defaultUsageSince(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString()
}

function parseDate(value: string, label: string): Date {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} must be a valid ISO date: ${value}`)
  }
  return parsed
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function sqliteJson<T>(dbPath: string, sql: string): Promise<T[]> {
  const { stdout } = await execFileAsync('sqlite3', ['-readonly', '-json', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: SQLITE_MAX_BUFFER,
  })
  const text = String(stdout)
  if (text.trim().length === 0) return []
  return JSON.parse(text) as T[]
}

function normalizePreview(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}...`
}

function sectionLabel(content: string, index: number): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return `section-${index}`
  return firstLine.replace(/^#+\s*/, '').slice(0, 80)
}

function inferSectionSource(label: string, index: number, agentName?: string | undefined): string {
  if (label === 'Praesidium Platform') return 'AGENT_MOTD.md'
  if (label === 'Conventions') return 'conventions.md'
  if (label === 'Runtime scope') return 'runtime:scope'
  if (label.startsWith('Today is ')) return 'runtime:date'
  if (label.startsWith('Services ')) return 'runtime:services'
  if (agentName) {
    const normalizedAgent = agentName.toLowerCase()
    const normalizedLabel = label.toLowerCase()
    if (
      normalizedLabel === normalizedAgent ||
      normalizedLabel.startsWith(`you are ${normalizedAgent}`) ||
      normalizedLabel.includes(`you are ${normalizedAgent},`) ||
      normalizedLabel.includes(`you are ${normalizedAgent}.`)
    ) {
      return 'SOUL.md'
    }
  }
  if (index === 2) return 'SOUL.md'
  return `artifact:section-${index}`
}

export function analyzeSystemPromptArtifact(
  content: string,
  sessionsPerDay: number,
  agentName?: string | undefined
): PromptSectionRent[] {
  return content.split(SECTION_SEPARATOR).map((section, offset) => {
    const index = offset + 1
    const label = sectionLabel(section, index)
    const tokens = estimateTokens(section)
    const bytes = Buffer.byteLength(section, 'utf8')
    return {
      index,
      label,
      source: inferSectionSource(label, index, agentName),
      chars: section.length,
      bytes,
      tokens,
      sessionsPerDay,
      tokensPerDay: tokens * sessionsPerDay,
      preview: normalizePreview(section),
    }
  })
}

async function loadUsage(
  dbPath: string,
  usageSince: string,
  usageNow: string,
  agentFilter: string | undefined
): Promise<Map<string, RunUsage>> {
  const sql = [
    'select c.agent_id, count(*) as runs, min(r.updated_at) as first_run_at, max(r.updated_at) as last_run_at',
    'from runs r join continuities c on c.scope_ref = r.scope_ref and c.lane_ref = r.lane_ref',
    `where c.agent_id is not null and r.updated_at >= ${sqlString(usageSince)} and r.updated_at <= ${sqlString(usageNow)}`,
    'group by c.agent_id',
  ].join(' ')
  const rows = await sqliteJson<RunsRow>(dbPath, sql)
  const usage = new Map<
    string,
    { runs: number; firstRunAt: string | null; lastRunAt: string | null }
  >()

  for (const row of rows) {
    const agent = row.agent_id
    if (!agent || (agentFilter && agent !== agentFilter)) continue
    const existing = usage.get(agent)
    usage.set(agent, {
      runs: (existing?.runs ?? 0) + Number(row.runs ?? 0),
      firstRunAt: minIso(existing?.firstRunAt ?? null, row.first_run_at ?? null),
      lastRunAt: maxIso(existing?.lastRunAt ?? null, row.last_run_at ?? null),
    })
  }

  const windowDays = Math.max(
    (parseDate(usageNow, 'usage now').getTime() - parseDate(usageSince, 'usage since').getTime()) /
      MS_PER_DAY,
    1 / 24
  )
  const result = new Map<string, RunUsage>()
  for (const [agent, row] of usage) {
    result.set(agent, {
      agent,
      runs: row.runs,
      sessionsPerDay: row.runs / windowDays,
      firstRunAt: row.firstRunAt,
      lastRunAt: row.lastRunAt,
    })
  }
  return result
}

function minIso(left: string | null, right: string | null): string | null {
  if (!left) return right
  if (!right) return left
  return left < right ? left : right
}

function maxIso(left: string | null, right: string | null): string | null {
  if (!left) return right
  if (!right) return left
  return left > right ? left : right
}

async function hasTable(dbPath: string, table: string): Promise<boolean> {
  const rows = await sqliteJson<{ name?: string }>(
    dbPath,
    `select name from sqlite_master where type = 'table' and name = ${sqlString(table)}`
  )
  return rows.length > 0
}

/**
 * Resident prompt of one v2 broker invocation. Claude-style drivers carry it as
 * launch.systemPromptFile; codex carries it in the praesidium-context block of
 * the codex home's AGENTS.md (CODEX_HOME in the spec's locked env).
 */
function invocationPrompt(
  spec: InvocationPromptSpec
): { systemPromptFile: string; prompt: string } | undefined {
  const systemPromptFile = spec.launch?.systemPromptFile
  if (systemPromptFile && existsSync(systemPromptFile)) {
    return { systemPromptFile, prompt: readFileSync(systemPromptFile, 'utf8') }
  }
  const codexHome = spec.process?.lockedEnv?.['CODEX_HOME']
  if (spec.harness?.frontend === 'codex' && codexHome) {
    const agentsFile = join(codexHome, 'AGENTS.md')
    if (!existsSync(agentsFile)) return undefined
    const prompt = readPraesidiumContextBlock(readFileSync(agentsFile, 'utf8'))
    return prompt ? { systemPromptFile: agentsFile, prompt } : undefined
  }
  return undefined
}

function agentIdOf(scopeRef: string): string | undefined {
  try {
    return parseScopeRef(scopeRef).agentId
  } catch {
    return undefined
  }
}

/**
 * Since the v2 plan cutover (2026-09-21) compiled_runtime_plans carries only the
 * selection; the resident prompt rides on each broker invocation spec. Take the
 * newest invocation per agent whose prompt is still on disk. Pre-v2 plan rows
 * are not read: none carries an agent id, and their prompts predate the cutover.
 */
async function loadLatestInvocationPrompts(
  dbPath: string,
  agentFilter: string | undefined
): Promise<Map<string, PlanArtifact>> {
  const plans = new Map<string, PlanArtifact>()
  if (!(await hasTable(dbPath, 'broker_invocations'))) return plans
  // Newest invocation per scope keeps the row set small; agents fold below.
  const sql = [
    'select invocation_id, created_at, spec_projection_json from (',
    'select invocation_id, created_at, spec_projection_json,',
    "row_number() over (partition by json_extract(spec_projection_json, '$.correlation.scopeRef') order by created_at desc) as rn",
    'from broker_invocations where spec_projection_json is not null',
    ') where rn = 1 order by created_at desc',
  ].join(' ')
  const rows = await sqliteJson<InvocationRow>(dbPath, sql)

  for (const row of rows) {
    if (!row.spec_projection_json || !row.created_at || !row.invocation_id) continue
    const spec = JSON.parse(row.spec_projection_json) as InvocationPromptSpec
    const scopeRef = spec.correlation?.['scopeRef']
    if (typeof scopeRef !== 'string') continue
    const agent = agentIdOf(scopeRef)
    if (!agent) continue
    if (plans.has(agent) || (agentFilter && agent !== agentFilter)) continue
    const resident = invocationPrompt(spec)
    if (!resident) continue
    plans.set(agent, {
      agent,
      scopeRef,
      createdAt: row.created_at,
      ...resident,
      harness: spec.harness?.frontend,
      invocationId: row.invocation_id,
    })
  }
  return plans
}

function buildAgentReports(
  usage: Map<string, RunUsage>,
  plans: Map<string, PlanArtifact>,
  usageWindowDays: number
): AgentRentReport[] {
  const agents = Array.from(new Set([...usage.keys(), ...plans.keys()])).sort()
  return agents.map((agent) => {
    const use = usage.get(agent) ?? {
      agent,
      runs: 0,
      sessionsPerDay: 0,
      firstRunAt: null,
      lastRunAt: null,
    }
    const plan = plans.get(agent)
    if (!plan) {
      return {
        agent,
        runs: use.runs,
        sessionsPerDay: use.sessionsPerDay,
        usageWindowDays,
        residentTokens: 0,
        residentTokensPerDay: 0,
        sections: [],
        missingPromptArtifact: 'no broker invocation whose resident prompt is still on disk',
      }
    }

    const sections = analyzeSystemPromptArtifact(plan.prompt, use.sessionsPerDay, agent).sort(
      (left, right) => right.tokensPerDay - left.tokensPerDay
    )
    const residentTokens = sections.reduce((sum, section) => sum + section.tokens, 0)
    const residentTokensPerDay = sections.reduce((sum, section) => sum + section.tokensPerDay, 0)
    return {
      agent,
      runs: use.runs,
      sessionsPerDay: use.sessionsPerDay,
      usageWindowDays,
      scopeRef: plan.scopeRef,
      systemPromptFile: plan.systemPromptFile,
      planCreatedAt: plan.createdAt,
      invocationId: plan.invocationId,
      harness: plan.harness,
      residentTokens,
      residentTokensPerDay,
      sections,
      prompt: plan.prompt,
    }
  })
}

function buildFleetRollup(agents: AgentRentReport[]): FleetRollupRow[] {
  const rollup = new Map<string, { tokens: number; tokensPerDay: number; agents: Set<string> }>()
  for (const agent of agents) {
    for (const section of agent.sections) {
      const existing = rollup.get(section.source) ?? {
        tokens: 0,
        tokensPerDay: 0,
        agents: new Set<string>(),
      }
      existing.tokens += section.tokens
      existing.tokensPerDay += section.tokensPerDay
      existing.agents.add(agent.agent)
      rollup.set(section.source, existing)
    }
  }
  return Array.from(rollup.entries())
    .map(([source, row]) => ({
      source,
      tokens: row.tokens,
      tokensPerDay: row.tokensPerDay,
      agents: Array.from(row.agents).sort(),
    }))
    .sort((left, right) => right.tokensPerDay - left.tokensPerDay)
}

function buildTopLines(agents: AgentRentReport[]): TopLineRow[] {
  const lines = new Map<
    string,
    { source: string; tokens: number; tokensPerDay: number; agents: Set<string> }
  >()
  for (const agent of agents) {
    for (const section of agent.sections) {
      const sectionPrompt = agent.prompt?.split(SECTION_SEPARATOR)[section.index - 1] ?? ''
      for (const line of sectionPrompt.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        const key = `${section.source}\0${trimmed}`
        const tokens = estimateTokens(trimmed)
        const existing = lines.get(key) ?? {
          source: section.source,
          tokens: 0,
          tokensPerDay: 0,
          agents: new Set<string>(),
        }
        existing.tokens += tokens
        existing.tokensPerDay += tokens * agent.sessionsPerDay
        existing.agents.add(agent.agent)
        lines.set(key, existing)
      }
    }
  }

  return Array.from(lines.entries())
    .map(([key, row]) => {
      const preview = key.split('\0')[1] ?? ''
      return {
        source: row.source,
        preview: normalizePreview(preview, 100),
        tokens: row.tokens,
        tokensPerDay: row.tokensPerDay,
        agents: Array.from(row.agents).sort(),
      }
    })
    .sort((left, right) => right.tokensPerDay - left.tokensPerDay)
    .slice(0, 10)
}

function buildResidentCorpus(agents: AgentRentReport[]): string {
  return agents.map((agent) => agent.prompt ?? '').join('\n')
}

function buildDeadLayerCandidates(
  agentsRoot: string,
  agents: AgentRentReport[],
  agentFilter: string | undefined
): DeadLayerCandidate[] {
  if (!existsSync(agentsRoot)) return []
  const residentCorpus = buildResidentCorpus(agents)
  const rows: DeadLayerCandidate[] = []
  for (const filePath of listMarkdownFiles(agentsRoot)) {
    const relPath = relative(agentsRoot, filePath)
    if (agentFilter && !isGlobalAgentFile(relPath) && !relPath.startsWith(`${agentFilter}/`)) {
      continue
    }
    if (isKnownResidentRootFile(relPath)) continue
    const content = readFileSync(filePath, 'utf8')
    if (!looksInstructionLike(relPath, content)) continue
    const tokens = estimateTokens(content)
    if (isSessionStartFile(relPath)) {
      rows.push({
        path: relPath,
        regime: 'session-start',
        tokens,
        reason: 'boot reminder, not per-turn resident rent',
      })
      continue
    }
    if (!content.trim() || residentCorpus.includes(content.trim())) continue
    rows.push({
      path: relPath,
      regime: 'resident-zero',
      tokens,
      reason: 'instruction-looking markdown not present in any priced system-prompt artifact',
    })
  }
  return rows.sort((left, right) => right.tokens - left.tokens).slice(0, 25)
}

function isGlobalAgentFile(relPath: string): boolean {
  return !relPath.includes('/')
}

function isKnownResidentRootFile(relPath: string): boolean {
  return relPath === 'AGENT_MOTD.md' || relPath === 'conventions.md'
}

function isSessionStartFile(relPath: string): boolean {
  const name = basename(relPath)
  return name === 'USER.md' || name === 'MEMORY.md' || relPath.endsWith('/memory/MEMORY.md')
}

function listMarkdownFiles(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (
        entry === '.git' ||
        entry === 'node_modules' ||
        entry === 'skills' ||
        entry === 'var' ||
        entry === 'work' ||
        entry === 'agent-loop-backup' ||
        entry === 'refactor-tools' ||
        entry === 'impl-drain'
      ) {
        continue
      }
      const path = join(dir, entry)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        visit(path)
        continue
      }
      if (stat.isFile() && entry.endsWith('.md')) out.push(path)
    }
  }
  visit(root)
  return out
}

function looksInstructionLike(relPath: string, content: string): boolean {
  const name = basename(relPath)
  if (/^(AGENTS|CLAUDE|SOUL|USER|MEMORY|HEARTBEAT|LORE|IMPL|PBC_PARTICIPANT)\.md$/.test(name)) {
    return true
  }
  if (name === 'README.md') return false
  return /\b(you are|must|should|do not|never|always|workflow|instructions|agent|prompt)\b/i.test(
    content
  )
}

async function buildDeltaRows(
  agentsRoot: string,
  since: string,
  usage: Map<string, RunUsage>
): Promise<DeltaRow[]> {
  if (!existsSync(agentsRoot)) return []
  const { stdout } = await execFileAsync(
    'git',
    ['-C', agentsRoot, 'diff', '--name-only', since, '--', '*.md'],
    {
      encoding: 'utf8',
      maxBuffer: SQLITE_MAX_BUFFER,
    }
  )
  const changed = String(stdout)
    .split(/\r?\n/)
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0)

  const rows: DeltaRow[] = []
  for (const relPath of changed) {
    const currentPath = join(agentsRoot, relPath)
    const after = existsSync(currentPath) ? readFileSync(currentPath, 'utf8') : ''
    const before = await readGitFile(agentsRoot, since, relPath)
    const beforeTokens = estimateTokens(before)
    const afterTokens = estimateTokens(after)
    const deltaTokens = afterTokens - beforeTokens
    const regime = inferFileRegime(relPath)
    rows.push({
      path: relPath,
      regime,
      beforeTokens,
      afterTokens,
      deltaTokens,
      estimatedTokensPerDay:
        regime === 'resident' ? deltaTokens * sessionsPerDayForFile(relPath, usage) : 0,
    })
  }
  return rows.sort(
    (left, right) => Math.abs(right.estimatedTokensPerDay) - Math.abs(left.estimatedTokensPerDay)
  )
}

async function readGitFile(repo: string, ref: string, relPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repo, 'show', `${ref}:${relPath}`], {
      encoding: 'utf8',
      maxBuffer: SQLITE_MAX_BUFFER,
    })
    return String(stdout)
  } catch {
    return ''
  }
}

function inferFileRegime(relPath: string): 'resident' | 'session-start' | 'unknown' {
  if (isKnownResidentRootFile(relPath) || basename(relPath) === 'SOUL.md') return 'resident'
  if (isSessionStartFile(relPath)) return 'session-start'
  return 'unknown'
}

function sessionsPerDayForFile(relPath: string, usage: Map<string, RunUsage>): number {
  if (isGlobalAgentFile(relPath)) {
    return Array.from(usage.values()).reduce((sum, row) => sum + row.sessionsPerDay, 0)
  }
  const agent = relPath.split('/')[0]
  return agent ? (usage.get(agent)?.sessionsPerDay ?? 0) : 0
}

async function buildTokenRentReport(options: TokenRentOptions): Promise<TokenRentReport> {
  const nowDate = options.now ? parseDate(options.now, 'now') : new Date()
  const usageNow = nowDate.toISOString()
  const usageSince = options.usageSince
    ? parseDate(options.usageSince, 'usage since').toISOString()
    : defaultUsageSince(nowDate)
  const usageWindowDays = Math.max(
    (parseDate(usageNow, 'usage now').getTime() - parseDate(usageSince, 'usage since').getTime()) /
      MS_PER_DAY,
    1 / 24
  )
  const hrcDb = options.hrcDb ?? DEFAULT_HRC_DB
  const agentsRoot = options.agentsRoot ?? DEFAULT_AGENTS_ROOT
  if (!existsSync(hrcDb)) {
    throw new Error(`HRC state DB not found: ${hrcDb}`)
  }

  const usage = await loadUsage(hrcDb, usageSince, usageNow, options.agent)
  const plans = await loadLatestInvocationPrompts(hrcDb, options.agent)
  const agents = buildAgentReports(usage, plans, usageWindowDays).sort(
    (left, right) => right.residentTokensPerDay - left.residentTokensPerDay
  )
  const report: TokenRentReport = {
    generatedAt: usageNow,
    usageSince,
    usageNow,
    usageWindowDays,
    hrcDb,
    agentsRoot,
    agents,
    fleetRollup: buildFleetRollup(agents),
    topLines: buildTopLines(agents),
    deadLayerCandidates: buildDeadLayerCandidates(agentsRoot, agents, options.agent),
  }
  if (options.since) {
    report.delta = {
      since: options.since,
      rows: await buildDeltaRows(agentsRoot, options.since, usage),
    }
  }
  return report
}

function formatNumber(value: number, digits = 0): string {
  return value.toLocaleString('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })
}

function formatMarkdown(report: TokenRentReport): string {
  const lines: string[] = []
  lines.push('# Token Rent Report')
  lines.push('')
  lines.push(`Generated: ${report.generatedAt}`)
  lines.push(
    `Usage window: ${report.usageSince} to ${report.usageNow} (${formatNumber(report.usageWindowDays, 2)} days)`
  )
  lines.push(`HRC DB: ${report.hrcDb}`)
  lines.push('')
  lines.push('## Agents')
  lines.push('')
  lines.push('| Agent | Runs | Sessions/day | Resident tokens | Resident tokens/day | Artifact |')
  lines.push('| --- | ---: | ---: | ---: | ---: | --- |')
  for (const agent of report.agents) {
    lines.push(
      `| ${agent.agent} | ${formatNumber(agent.runs)} | ${formatNumber(agent.sessionsPerDay, 2)} | ${formatNumber(agent.residentTokens)} | ${formatNumber(agent.residentTokensPerDay, 0)} | ${agent.systemPromptFile ?? agent.missingPromptArtifact ?? ''} |`
    )
  }

  for (const agent of report.agents) {
    lines.push('')
    lines.push(`## ${agent.agent}`)
    lines.push('')
    lines.push('| Layer | Source | Tokens | Sessions/day | Tokens/day | Preview |')
    lines.push('| ---: | --- | ---: | ---: | ---: | --- |')
    for (const section of agent.sections) {
      lines.push(
        `| ${section.index} | ${section.source} | ${formatNumber(section.tokens)} | ${formatNumber(section.sessionsPerDay, 2)} | ${formatNumber(section.tokensPerDay)} | ${escapeTable(section.preview)} |`
      )
    }
  }

  lines.push('')
  lines.push('## Fleet Rollup')
  lines.push('')
  lines.push('| Source | Tokens | Tokens/day | Agents |')
  lines.push('| --- | ---: | ---: | --- |')
  for (const row of report.fleetRollup) {
    lines.push(
      `| ${row.source} | ${formatNumber(row.tokens)} | ${formatNumber(row.tokensPerDay)} | ${row.agents.join(', ')} |`
    )
  }

  lines.push('')
  lines.push('## Top 10 Lines')
  lines.push('')
  lines.push('| Source | Tokens/day | Agents | Line |')
  lines.push('| --- | ---: | --- | --- |')
  for (const row of report.topLines) {
    lines.push(
      `| ${row.source} | ${formatNumber(row.tokensPerDay)} | ${row.agents.join(', ')} | ${escapeTable(row.preview)} |`
    )
  }

  lines.push('')
  lines.push('## Rent=0 Instruction-Looking Files')
  lines.push('')
  lines.push('| Path | Regime | Tokens | Reason |')
  lines.push('| --- | --- | ---: | --- |')
  for (const row of report.deadLayerCandidates) {
    lines.push(`| ${row.path} | ${row.regime} | ${formatNumber(row.tokens)} | ${row.reason} |`)
  }

  if (report.delta) {
    lines.push('')
    lines.push(`## Delta Since ${report.delta.since}`)
    lines.push('')
    lines.push('| Path | Regime | Before | After | Delta | Estimated tokens/day |')
    lines.push('| --- | --- | ---: | ---: | ---: | ---: |')
    for (const row of report.delta.rows) {
      lines.push(
        `| ${row.path} | ${row.regime} | ${formatNumber(row.beforeTokens)} | ${formatNumber(row.afterTokens)} | ${formatNumber(row.deltaTokens)} | ${formatNumber(row.estimatedTokensPerDay)} |`
      )
    }
  }

  return `${lines.join('\n')}\n`
}

function escapeTable(value: string): string {
  return value.replaceAll('|', '\\|')
}

export function registerTokenRentCommand(program: Command): void {
  program
    .command('token-rent')
    .description("Price agents' resident system-prompt sections against real HRC run frequency")
    .option('--agent <name>', 'Only report one agent')
    .option('--fleet', 'Report fleet rollup (default)')
    .option('--json', 'Output JSON instead of Markdown')
    .option('--hrc-db <path>', `HRC state SQLite DB (default: ${DEFAULT_HRC_DB})`)
    .option('--agents-root <path>', `Agent source root (default: ${DEFAULT_AGENTS_ROOT})`)
    .option('--usage-since <iso>', 'Usage window start (default: first day of previous UTC month)')
    .option('--since <git-ref>', 'Show var/agents markdown token delta since a git ref')
    .option('--now <iso>', 'Current time override for deterministic reports')
    .action(async (options: TokenRentOptions) => {
      try {
        const report = await buildTokenRentReport(options)
        if (options.json) {
          console.log(
            JSON.stringify(report, (key, value) => (key === 'prompt' ? undefined : value), 2)
          )
          return
        }
        console.log(
          chalk.gray(
            'Token estimator: ceil(chars / 4); resident sections split on blank-line --- blank-line.'
          )
        )
        console.log(formatMarkdown(report))
      } catch (error) {
        exitWithAspError(error, options)
      }
    })
}
