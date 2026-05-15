#!/usr/bin/env bun
// codex-homes-archive.ts
//
// Archives codex session JSONLs from orphaned codex-home directories and
// optionally prunes the originals. See proposal in conversation for design.
//
// Defaults to dry-run. Pass --execute to actually do anything.
//
// Examples:
//   bun run scripts/codex-homes-archive.ts                                # dry-run plan
//   bun run scripts/codex-homes-archive.ts --execute --archive-only       # archive only
//   bun run scripts/codex-homes-archive.ts --execute --prune-only         # delete only
//   bun run scripts/codex-homes-archive.ts --execute                      # archive + delete
//
// Flags:
//   --root <path>                  codex-homes root (default: ~/praesidium/var/spaces-repo/codex-homes)
//   --archive-dir <path>           archive output (default: <root>/archive/<ts>)
//   --execute                      actually do it (default is dry-run)
//   --archive-only                 preserve but do not delete originals
//   --prune-only                   delete without preserving (assumes archive is current)
//   --include-logs                 also copy logs_2.sqlite (default: skip)
//   --include-valid                also process directories whose slug is fully valid
//   --keep-empty-after-days <N>    only delete zero-rollout dirs older than N days (default: 0)
//   --gzip                         gzip archived rollout JSONLs (saves ~80%)
//   --help                         show this header

import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

interface CliOpts {
  root: string
  archiveDir: string | undefined
  execute: boolean
  archiveOnly: boolean
  pruneOnly: boolean
  includeLogs: boolean
  includeValid: boolean
  keepEmptyAfterDays: number
  gzip: boolean
}

interface ThreadRow {
  id: string
  rollout_path: string
  created_at: number
  updated_at: number
  title: string
  cwd: string
  source: string
}

interface HomeEntry {
  slug: string
  path: string
  layout: 'slug' | 'hash'
  codexHomePath: string // for hash-shaped, includes '/home' suffix; for slug, same as path
  projectSlug: string | null
  agentSlug: string | null
  projectValid: boolean
  agentValid: boolean
  category: 'valid' | 'unknown_project' | 'unknown_agent' | 'unknown_both' | 'hash_orphan'
  threadCount: number
  rolloutCount: number
  rolloutBytes: number
  newestRolloutMs: number
  threads: ThreadRow[]
}

const SCRIPT_NAME = 'codex-homes-archive'

function parseArgs(argv: readonly string[]): CliOpts {
  const root = pickArg(argv, '--root') ?? join(homedir(), 'praesidium/var/spaces-repo/codex-homes')
  const archiveDir = pickArg(argv, '--archive-dir')
  const keepRaw = pickArg(argv, '--keep-empty-after-days') ?? '0'
  const keep = Number.parseInt(keepRaw, 10)
  if (!Number.isFinite(keep) || keep < 0) {
    fail(`--keep-empty-after-days must be a non-negative integer (got: ${keepRaw})`)
  }
  return {
    root: resolve(root),
    archiveDir: archiveDir ? resolve(archiveDir) : undefined,
    execute: hasFlag(argv, '--execute'),
    archiveOnly: hasFlag(argv, '--archive-only'),
    pruneOnly: hasFlag(argv, '--prune-only'),
    includeLogs: hasFlag(argv, '--include-logs'),
    includeValid: hasFlag(argv, '--include-valid'),
    keepEmptyAfterDays: keep,
    gzip: hasFlag(argv, '--gzip'),
  }
}

function pickArg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name)
}

function fail(msg: string): never {
  process.stderr.write(`${SCRIPT_NAME}: ${msg}\n`)
  process.exit(2)
}

function showHelp(): void {
  const lines = readFileSync(new URL(import.meta.url), 'utf8').split('\n')
  let started = false
  for (const line of lines) {
    if (line.startsWith('//')) {
      started = true
      process.stdout.write(`${line.slice(line.startsWith('// ') ? 3 : 2)}\n`)
    } else if (started) {
      break
    }
  }
}

function sanitizeSegment(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-_.]+|[-_.]+$/g, '') || 'default'
  )
}

function loadAcpRegistry(): { projects: Set<string>; agents: Set<string> } {
  const projOut = spawnSync('acp', ['project', 'list', '--json'], { encoding: 'utf8' })
  const agentOut = spawnSync('acp', ['agent', 'list', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, ACP_ACTOR_AGENT_ID: process.env['ACP_ACTOR_AGENT_ID'] ?? 'clod' },
  })
  if (projOut.status !== 0) {
    fail(`acp project list failed: ${projOut.stderr || projOut.stdout}`)
  }
  if (agentOut.status !== 0) {
    fail(`acp agent list failed: ${agentOut.stderr || agentOut.stdout}`)
  }
  const projects = new Set<string>()
  const agents = new Set<string>()
  const projData = JSON.parse(projOut.stdout) as {
    projects: { projectId: string; homeDir?: string }[]
  }
  for (const p of projData.projects) {
    projects.add(sanitizeSegment(p.projectId))
    if (p.homeDir) projects.add(sanitizeSegment(basename(p.homeDir)))
  }
  const agentData = JSON.parse(agentOut.stdout) as {
    agents: { agentId: string; status: string }[]
  }
  for (const a of agentData.agents) {
    // include disabled agents too — their old homes may still hold rollouts
    agents.add(sanitizeSegment(a.agentId))
  }
  return { projects, agents }
}

function findRollouts(dir: string): { paths: string[]; bytes: number; newestMs: number } {
  const sessions = join(dir, 'sessions')
  if (!existsSync(sessions)) return { paths: [], bytes: 0, newestMs: 0 }
  const paths: string[] = []
  let bytes = 0
  let newestMs = 0
  const walk = (d: string): void => {
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        walk(p)
      } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try {
          const st = statSync(p)
          paths.push(p)
          bytes += st.size
          if (st.mtimeMs > newestMs) newestMs = st.mtimeMs
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  walk(sessions)
  return { paths, bytes, newestMs }
}

function readThreads(codexHome: string): ThreadRow[] {
  const dbPath = join(codexHome, 'state_5.sqlite')
  if (!existsSync(dbPath)) return []
  let db: Database
  try {
    db = new Database(dbPath, { readonly: true })
  } catch {
    return []
  }
  try {
    const rows = db
      .query<ThreadRow, []>(
        `SELECT id, rollout_path, created_at, updated_at, title, cwd, source
         FROM threads ORDER BY updated_at DESC`
      )
      .all()
    return rows
  } catch {
    return []
  } finally {
    db.close()
  }
}

function classify(
  slug: string,
  projects: Set<string>,
  agents: Set<string>
): {
  layout: 'slug' | 'hash'
  projectSlug: string | null
  agentSlug: string | null
  projectValid: boolean
  agentValid: boolean
  category: HomeEntry['category']
} {
  if (!slug.includes('_')) {
    // hash-shaped, no project/agent encoded
    return {
      layout: 'hash',
      projectSlug: null,
      agentSlug: null,
      projectValid: false,
      agentValid: false,
      category: 'hash_orphan',
    }
  }
  const sep = slug.lastIndexOf('_')
  const projectSlug = slug.slice(0, sep)
  const agentSlug = slug.slice(sep + 1)
  const projectValid = projects.has(projectSlug)
  const agentValid = agents.has(agentSlug)
  let category: HomeEntry['category']
  if (projectValid && agentValid) category = 'valid'
  else if (!projectValid && !agentValid) category = 'unknown_both'
  else if (!projectValid) category = 'unknown_project'
  else category = 'unknown_agent'
  return { layout: 'slug', projectSlug, agentSlug, projectValid, agentValid, category }
}

function enumerateHomes(root: string, projects: Set<string>, agents: Set<string>): HomeEntry[] {
  const entries: HomeEntry[] = []
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    // Skip dotfiles, plus the visible archive directory itself (the script's
    // own output; named `archive/` per operator preference). Keeping it out of
    // enumeration prevents the next run from trying to archive its own
    // archive recursively.
    if (e.name.startsWith('.')) continue
    if (e.name === 'archive') continue
    const path = join(root, e.name)
    const { layout, projectSlug, agentSlug, projectValid, agentValid, category } = classify(
      e.name,
      projects,
      agents
    )
    const codexHomePath = layout === 'hash' ? join(path, 'home') : path
    const { paths, bytes, newestMs } = findRollouts(codexHomePath)
    const threads = readThreads(codexHomePath)
    entries.push({
      slug: e.name,
      path,
      layout,
      codexHomePath,
      projectSlug,
      agentSlug,
      projectValid,
      agentValid,
      category,
      threadCount: threads.length,
      rolloutCount: paths.length,
      rolloutBytes: bytes,
      newestRolloutMs: newestMs,
      threads,
    })
  }
  return entries
}

function ageDays(ms: number): number {
  if (ms === 0) return Number.POSITIVE_INFINITY
  return (Date.now() - ms) / (24 * 3600 * 1000)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function archiveOne(entry: HomeEntry, archiveDir: string, opts: CliOpts): void {
  const target = join(archiveDir, entry.slug)
  mkdirSync(target, { recursive: true })

  // threads.json (always — even if empty, gives provenance)
  writeFileSync(
    join(target, 'threads.json'),
    `${JSON.stringify(
      {
        originalSlug: entry.slug,
        originalPath: entry.path,
        codexHomePath: entry.codexHomePath,
        category: entry.category,
        projectSlug: entry.projectSlug,
        agentSlug: entry.agentSlug,
        threads: entry.threads,
      },
      null,
      2
    )}\n`
  )

  // sessions/ — verbatim copy (optionally gzipped per-file)
  const sessions = join(entry.codexHomePath, 'sessions')
  if (existsSync(sessions)) {
    if (opts.gzip) {
      // walk and gzip jsonl files; keep tree structure
      const walk = (src: string, dst: string): void => {
        for (const e of readdirSync(src, { withFileTypes: true })) {
          const sp = join(src, e.name)
          const dp = join(dst, e.name)
          if (e.isDirectory()) {
            mkdirSync(dp, { recursive: true })
            walk(sp, dp)
          } else if (e.isFile()) {
            if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
              const buf = readFileSync(sp)
              writeFileSync(`${dp}.gz`, gzipSync(buf))
            } else {
              copyFileSync(sp, dp)
            }
          }
        }
      }
      mkdirSync(join(target, 'sessions'), { recursive: true })
      walk(sessions, join(target, 'sessions'))
    } else {
      cpSync(sessions, join(target, 'sessions'), { recursive: true })
    }
  }

  // optionally logs_2.sqlite
  if (opts.includeLogs) {
    const logsDb = join(entry.codexHomePath, 'logs_2.sqlite')
    if (existsSync(logsDb)) {
      copyFileSync(logsDb, join(target, 'logs_2.sqlite'))
    }
  }
}

interface PlanRow {
  entry: HomeEntry
  action: 'archive_then_delete' | 'delete_only' | 'skip_recent' | 'skip_valid'
}

function buildPlan(entries: HomeEntry[], opts: CliOpts): PlanRow[] {
  const plan: PlanRow[] = []
  for (const e of entries) {
    if (e.category === 'valid' && !opts.includeValid) {
      plan.push({ entry: e, action: 'skip_valid' })
      continue
    }
    if (e.rolloutCount === 0) {
      const dirMs = (() => {
        try {
          return statSync(e.path).mtimeMs
        } catch {
          return 0
        }
      })()
      if (opts.keepEmptyAfterDays > 0 && ageDays(dirMs) < opts.keepEmptyAfterDays) {
        plan.push({ entry: e, action: 'skip_recent' })
        continue
      }
      plan.push({ entry: e, action: 'delete_only' })
    } else {
      plan.push({ entry: e, action: 'archive_then_delete' })
    }
  }
  return plan
}

function printPlan(plan: PlanRow[]): void {
  const buckets = new Map<PlanRow['action'], PlanRow[]>()
  for (const row of plan) {
    const list = buckets.get(row.action) ?? []
    list.push(row)
    buckets.set(row.action, list)
  }
  let totalArchive = 0
  let totalBytes = 0
  let totalDelete = 0
  for (const row of plan) {
    if (row.action === 'archive_then_delete') {
      totalArchive += 1
      totalBytes += row.entry.rolloutBytes
      totalDelete += 1
    } else if (row.action === 'delete_only') {
      totalDelete += 1
    }
  }
  process.stdout.write('=== plan ===\n')
  for (const [action, rows] of buckets) {
    process.stdout.write(`\n[${action}] ${rows.length} entries\n`)
    if (action === 'archive_then_delete' || action === 'skip_valid') {
      const top = rows
        .slice()
        .sort((a, b) => b.entry.rolloutCount - a.entry.rolloutCount)
        .slice(0, 15)
      for (const r of top) {
        process.stdout.write(
          `  ${r.entry.slug.padEnd(40)} rollouts=${String(r.entry.rolloutCount).padStart(4)}  ` +
            `${formatBytes(r.entry.rolloutBytes).padStart(10)}  cat=${r.entry.category}\n`
        )
      }
      if (rows.length > top.length) {
        process.stdout.write(`  ... and ${rows.length - top.length} more\n`)
      }
    } else if (action === 'delete_only' || action === 'skip_recent') {
      // count by category
      const byCat = new Map<string, number>()
      for (const r of rows) {
        byCat.set(r.entry.category, (byCat.get(r.entry.category) ?? 0) + 1)
      }
      for (const [cat, n] of byCat) {
        process.stdout.write(`  ${cat}: ${n}\n`)
      }
    }
  }
  process.stdout.write(
    `\n=== totals ===\narchive then delete: ${totalArchive}\ndelete only:         ${totalDelete - totalArchive}\nbytes to archive:    ${formatBytes(totalBytes)}\n`
  )
}

function execute(plan: PlanRow[], archiveDir: string, opts: CliOpts): void {
  // Phase 1: archive
  if (!opts.pruneOnly) {
    mkdirSync(archiveDir, { recursive: true })
    process.stdout.write(`\n=== archiving to ${archiveDir} ===\n`)
    const manifestHomes: object[] = []
    let archived = 0
    for (const row of plan) {
      if (row.action !== 'archive_then_delete') continue
      try {
        archiveOne(row.entry, archiveDir, opts)
        manifestHomes.push({
          originalSlug: row.entry.slug,
          originalPath: row.entry.path,
          category: row.entry.category,
          projectSlug: row.entry.projectSlug,
          agentSlug: row.entry.agentSlug,
          threadCount: row.entry.threadCount,
          rolloutCount: row.entry.rolloutCount,
          bytesPreserved: row.entry.rolloutBytes,
          newestRolloutAt: row.entry.newestRolloutMs
            ? new Date(row.entry.newestRolloutMs).toISOString()
            : null,
        })
        archived += 1
        if (archived % 5 === 0) {
          process.stdout.write(`  archived ${archived}...\n`)
        }
      } catch (err) {
        process.stderr.write(
          `  FAILED to archive ${row.entry.slug}: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }
    const manifest = {
      gcRun: {
        ts: new Date().toISOString(),
        by: process.env['USER'] ?? 'unknown',
        script: SCRIPT_NAME,
        opts: { gzip: opts.gzip, includeLogs: opts.includeLogs },
      },
      homes: manifestHomes,
    }
    const manifestPath = join(archiveDir, 'manifest.json')
    const tmpPath = `${manifestPath}.tmp`
    writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`)
    // atomic rename
    spawnSync('mv', [tmpPath, manifestPath])
    process.stdout.write(`archived ${archived} homes; manifest at ${manifestPath}\n`)
  }
  // Phase 2: prune
  if (!opts.archiveOnly) {
    process.stdout.write('\n=== pruning originals ===\n')
    let deleted = 0
    for (const row of plan) {
      if (row.action !== 'archive_then_delete' && row.action !== 'delete_only') continue
      try {
        rmSync(row.entry.path, { recursive: true, force: true })
        deleted += 1
        if (deleted % 50 === 0) {
          process.stdout.write(`  deleted ${deleted}...\n`)
        }
      } catch (err) {
        process.stderr.write(
          `  FAILED to delete ${row.entry.slug}: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }
    process.stdout.write(`deleted ${deleted} directories\n`)
  }
}

function main(): void {
  const argv = process.argv.slice(2)
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    showHelp()
    return
  }
  const opts = parseArgs(argv)
  if (opts.archiveOnly && opts.pruneOnly) {
    fail('--archive-only and --prune-only are mutually exclusive')
  }
  if (!existsSync(opts.root)) {
    fail(`codex-homes root not found: ${opts.root}`)
  }
  const archiveDir =
    opts.archiveDir ?? join(opts.root, 'archive', new Date().toISOString().replace(/[:.]/g, '-'))

  process.stdout.write(`${SCRIPT_NAME}\n`)
  process.stdout.write(`  root:       ${opts.root}\n`)
  process.stdout.write(`  archive:    ${archiveDir}\n`)
  process.stdout.write(`  mode:       ${opts.execute ? 'EXECUTE' : 'dry-run'}`)
  if (opts.archiveOnly) process.stdout.write(' (archive only)')
  if (opts.pruneOnly) process.stdout.write(' (prune only)')
  process.stdout.write('\n')
  process.stdout.write(
    `  include:    valid=${opts.includeValid} logs=${opts.includeLogs} gzip=${opts.gzip}\n`
  )
  process.stdout.write(`  keep-empty-after-days: ${opts.keepEmptyAfterDays}\n`)

  const { projects, agents } = loadAcpRegistry()
  process.stdout.write(`  registry:   ${projects.size} projects, ${agents.size} agents\n`)

  const homes = enumerateHomes(opts.root, projects, agents)
  process.stdout.write(`  enumerated: ${homes.length} codex-home directories\n`)
  const plan = buildPlan(homes, opts)
  printPlan(plan)

  if (!opts.execute) {
    process.stdout.write('\n(dry-run; pass --execute to perform actions)\n')
    return
  }
  execute(plan, archiveDir, opts)
  process.stdout.write('\ndone.\n')
}

main()
