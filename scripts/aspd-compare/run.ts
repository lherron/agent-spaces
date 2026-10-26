#!/usr/bin/env bun
/**
 * aspd compare runner (T-11833, plan docs/proposals/aspd-rust-front-door.md).
 *
 *   bun scripts/aspd-compare/run.ts --out <dir> [--commit <sha>]
 *     [--a-cmd '<json argv>'] [--b-cmd '<json argv>']
 *     [--a-declared-extra <case>:<path>]... [--b-declared-extra <case>:<path>]...
 *     [--raw] [--keep-scratch]
 *
 * Builds one real release from a clean clone of <commit> (default HEAD) into a
 * scratch namespace; both subjects are served from that one release directory.
 * A subject is an argv prefix the runner completes with
 * `serve --socket <ns>/run/aspd.sock --log <log>` and starts detached in its
 * own process group, cwd <ns>, with a literal environment (HOME PATH USER
 * LOGNAME SHELL TMPDIR LANG, ASP_HOME and ASP_AGENTS_ROOT under the stage,
 * ASPD_COMPARE_RELEASE=<release dir>). It is ready when aspc.hello answers and
 * stopped by SIGTERM to its group. The default subject is the release's aspd.
 *
 * Absolute paths are plan inputs (planHash covers bundle roots and prompt
 * files), so both subjects run against the SAME stage path, one after the
 * other: seed the stage once, run A, restore the stage to the identical seed,
 * run B. Per case it captures every reply and a manifest of the stage tree.
 *
 * Comparison, per case:
 *  1. Each compile reply's derived hashes are recomputed from that subject's
 *     plan as reported (derivePlanHashes) and must equal what it reported.
 *  2. Then the measured volatile inputs (volatile-mask.ts) are tokenized in
 *     both bodies, the verified hash values are excluded, declared extras are
 *     reported apart, and A is diffed against B: replies and stage trees.
 * `--raw` skips step 2's mask and tokens, which is how the mask is measured.
 *
 * Writes <out>/report.json (every case, every difference) and per-subject
 * replies, trees and final stages, then removes the scratch root (unless
 * --keep-scratch); exits 0 only when every case matches.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { join, relative, resolve } from 'node:path'

import { derivePlanHashes } from '../../compiler/agent-spaces/src/compile-plan-finalize.ts'
import { inspectRelease } from '../asp-release.ts'
import { buildScratchRelease, must, repo } from '../lib/scratch-release.ts'
import { isolateUsageMetrics } from '../lib/usage-metrics-isolation.ts'
import { loadAsp } from '../path-markers-e2e.ts'
import { type CompareCase, HELLO_PARAMS, buildCases, seedStage } from './cases.ts'
import { RESPONSE_MASK, TOKENS, TREE_MASK } from './volatile-mask.ts'

// Usage metrics from this script and its children stay out of the real day files (T-11824).
isolateUsageMetrics()

function args(name: string): string[] {
  return process.argv.flatMap((value, index) => (process.argv[index - 1] === name ? [value] : []))
}
const arg = (name: string) => args(name)[0]

type Reply = Record<string, unknown> | { unparsed: string }
type TreeEntry = string
type Capture = {
  replies: Record<string, Reply[]>
  trees: Record<string, Record<string, TreeEntry>>
  fingerprintViolations: Record<string, string[]>
  fingerprints: Fingerprints
}
type Subject = { name: 'a' | 'b'; argv: string[]; declaredExtras: Map<string, string[]> }

const INHERITED_ENV = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG']

// -- stage ----------------------------------------------------------------------

/**
 * A subject's derived fingerprints, in first-seen order. Their inputs include
 * the measured bundle staging dir, so the values move between runs of one
 * build; each is checked for consistency on its own side, then tokenized as
 * `«derived:<kind>#<n>»` (approved 2026-10-26; full recipe re-derivation is an
 * R3 close condition).
 */
type Fingerprints = Map<string, string>

const MANAGED_KINDS = ['prompts', 'skills'] as const

/** Register this capture's fingerprints; return consistency violations. */
function verifyFingerprints(root: string, registry: Fingerprints): string[] {
  const violations: string[] = []
  const register = (value: string, kind: string) => {
    if (!registry.has(value)) registry.set(value, `derived:${kind}#${registry.size + 1}`)
  }
  const codexHomes = join(root, 'asp-home', 'codex-homes')
  for (const home of existsSync(codexHomes) ? readdirSync(codexHomes).sort() : []) {
    const metadata = join(codexHomes, home, '.asp-runtime.json')
    if (!existsSync(metadata)) continue
    const fingerprint = (JSON.parse(readFileSync(metadata, 'utf8')) as { fingerprint: string })
      .fingerprint
    register(fingerprint, 'codex-runtime-fingerprint')
    for (const kind of MANAGED_KINDS) {
      const expected = `.asp-managed-directory-versions/${kind}/${fingerprint}`
      const link = join(codexHomes, home, kind)
      const target = lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()
        ? readlinkSync(link)
        : undefined
      if (target !== expected) violations.push(`${home}/${kind} -> ${target}, expected ${expected}`)
      if (!existsSync(join(codexHomes, home, expected)))
        violations.push(`${home}/${expected} missing`)
    }
  }
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      if (name === 'muse-serve-metadata.json' && dir.endsWith('muse.home')) {
        const { fingerprint } = JSON.parse(readFileSync(full, 'utf8')) as { fingerprint?: unknown }
        if (typeof fingerprint === 'string' && /^[0-9a-f]{64}$/.test(fingerprint)) {
          register(fingerprint, 'muse-serve-fingerprint')
        } else violations.push(`${relative(root, full)}: fingerprint is not a sha256`)
      } else if (lstatSync(full).isDirectory() && name !== '.git') walk(full)
    }
  }
  walk(root)
  return violations
}

/**
 * Stage-relative manifest: mode + sha256 of content, or the symlink target.
 * When masking, measured tree masks apply to content and registered
 * fingerprints are tokenized in paths, link targets and content.
 */
function treeManifest(root: string, fingerprints: Fingerprints): Record<string, TreeEntry> {
  const tokenize = (text: string) => {
    let out = text
    if (masking)
      for (const [value, token] of fingerprints) out = out.replaceAll(value, `«${token}»`)
    return out
  }
  const out: Record<string, TreeEntry> = {}
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      const rel = relative(root, full)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) out[tokenize(rel)] = `symlink -> ${tokenize(readlinkSync(full))}`
      else if (stat.isDirectory()) {
        if (name === '.git') continue
        walk(full)
      } else {
        let content = readFileSync(full)
        if (masking) {
          let text = content.toString('utf8')
          for (const entry of TREE_MASK.filter((mask) => mask.path.test(rel))) {
            text = text.replace(entry.content, `«${entry.token}»`)
          }
          content = Buffer.from(tokenize(text))
        }
        const mode = (stat.mode & 0o777).toString(8)
        out[tokenize(rel)] = `file ${mode} ${createHash('sha256').update(content).digest('hex')}`
      }
    }
  }
  walk(root)
  return out
}

function restoreStage(seed: string, stage: string): void {
  rmSync(stage, { recursive: true, force: true })
  cpSync(seed, stage, { recursive: true, verbatimSymlinks: true })
}

// -- subjects -------------------------------------------------------------------

function startSubject(subject: Subject, ns: string, socket: string, log: string, env: object) {
  const [command, ...prefix] = subject.argv
  const stderr = openSync(`${log}.stderr`, 'a')
  const child = spawn(command as string, [...prefix, 'serve', '--socket', socket, '--log', log], {
    cwd: ns,
    env: env as NodeJS.ProcessEnv,
    detached: true,
    stdio: ['ignore', stderr, stderr],
  })
  closeSync(stderr)
  return child
}

async function awaitReady(socket: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  for (;;) {
    if (exited) throw new Error('subject exited before answering aspc.hello')
    try {
      const replies = await drive(socket, [frameFor(1, 'aspc.hello', HELLO_PARAMS)], 5_000)
      if (replies.length === 1 && 'result' in (replies[0] as object)) return
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error('subject did not answer aspc.hello within 60s')
    await Bun.sleep(100)
  }
}

async function stopSubject(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return
  const exited = new Promise((done) => child.once('exit', done))
  process.kill(-child.pid, 'SIGTERM')
  await Promise.race([exited, Bun.sleep(180_000)])
}

// -- driving --------------------------------------------------------------------

const frameFor = (id: number, method: string, params: unknown) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params })

/**
 * Write `frames` on one connection and collect reply lines until one reply per
 * frame, the server closes, or `idleMs` passes without data. Replies are
 * parsed and put in request-id order (pipelined replies arrive in completion
 * order).
 */
function drive(socket: string, frames: string[], idleMs = 180_000): Promise<Reply[]> {
  return new Promise((resolveReplies, reject) => {
    const connection = connect(socket)
    const lines: string[] = []
    let buffer = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      clearTimeout(timer)
      connection.destroy()
      const replies = lines.map((line): Reply => {
        try {
          return JSON.parse(line) as Record<string, unknown>
        } catch {
          return { unparsed: line }
        }
      })
      replies.sort(
        (x, y) => Number((x as { id?: unknown }).id ?? 0) - Number((y as { id?: unknown }).id ?? 0)
      )
      resolveReplies(replies)
    }
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(finish, idleMs)
    }
    connection.on('error', (error) => (lines.length > 0 ? finish() : reject(error)))
    connection.on('close', finish)
    connection.on('connect', () => {
      for (const frame of frames) connection.write(`${frame}\n`)
      arm()
    })
    connection.on('data', (chunk) => {
      buffer += chunk.toString()
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      lines.push(...parts)
      if (lines.length >= frames.length) finish()
      else arm()
    })
  })
}

function caseFrames(entry: CompareCase): string[] {
  if (entry.kind === 'raw') return entry.frames
  return [frameFor(1, 'aspc.hello', HELLO_PARAMS), frameFor(2, entry.method, entry.params)]
}

async function runSubject(
  subject: Subject,
  cases: CompareCase[],
  paths: { seed: string; stage: string; ns: string; socket: string; out: string },
  env: object
): Promise<Capture> {
  restoreStage(paths.seed, paths.stage)
  const log = join(paths.out, `${subject.name}-aspd.log`)
  const child = startSubject(subject, paths.ns, paths.socket, log, env)
  const fingerprints: Fingerprints = new Map()
  const capture: Capture = { replies: {}, trees: {}, fingerprintViolations: {}, fingerprints }
  try {
    await awaitReady(paths.socket, child)
    for (const entry of cases) {
      capture.replies[entry.id] = await drive(
        paths.socket,
        caseFrames(entry),
        entry.kind === 'raw' ? 5_000 : 180_000
      )
      capture.fingerprintViolations[entry.id] = verifyFingerprints(paths.stage, fingerprints)
      capture.trees[entry.id] = treeManifest(paths.stage, fingerprints)
      process.stdout.write(`${subject.name} ${entry.id}\n`)
    }
  } finally {
    await stopSubject(child)
  }
  cpSync(paths.stage, join(paths.out, `${subject.name}-stage`), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => !source.endsWith('/.git'),
  })
  writeFileSync(
    join(paths.out, `${subject.name}-replies.json`),
    `${JSON.stringify(capture.replies, null, 2)}\n`
  )
  writeFileSync(
    join(paths.out, `${subject.name}-trees.json`),
    `${JSON.stringify(capture.trees, null, 2)}\n`
  )
  return capture
}

// -- comparison -----------------------------------------------------------------

let masking = true

type Difference = { path: string; a: unknown; b: unknown }

const pathMatches = (pattern: string, path: string) =>
  new RegExp(`^${pattern.replace(/[.[\]]/g, '\\$&').replaceAll('*', '[^.\\[\\]]+')}$`).test(path)

function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(prefix, [])
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, out))
  } else if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 0) out.set(prefix, {})
    for (const key of keys)
      flatten((value as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key, out)
  } else {
    out.set(prefix, value)
  }
}

const DERIVED_HASH_FIELDS = [
  'compatibilityHash',
  'startRequestHash',
  'profileId',
  'profileHash',
  'compileId',
  'planHash',
] as const

/**
 * Step 1: a subject's compile reply re-derives, from its plan as reported, to
 * the hashes it reported. Returns the mismatches and the verified values.
 */
function selfCheck(
  entry: CompareCase,
  replies: Reply[]
): { mismatches: string[]; verified: Map<string, string> } {
  const verified = new Map<string, string>()
  const plan = (replies[1] as { result?: { plan?: Record<string, unknown> } } | undefined)?.result
    ?.plan
  if (entry.kind !== 'call' || entry.compileRequest === undefined || plan === undefined) {
    return { mismatches: [], verified }
  }
  const derived = derivePlanHashes(entry.compileRequest as never, plan as never)
  const profile = (plan['execution'] as { profile: Record<string, unknown> }).profile
  const reported: Record<string, unknown> = {
    ...profile,
    compileId: plan['compileId'],
    planHash: plan['planHash'],
  }
  const mismatches: string[] = []
  for (const field of DERIVED_HASH_FIELDS) {
    if (reported[field] === derived[field]) verified.set(derived[field], field)
    else mismatches.push(`${field}: reported ${String(reported[field])}, derived ${derived[field]}`)
  }
  return { mismatches, verified: mismatches.length === 0 ? verified : new Map() }
}

/** Reply paths: `hello.…` and `reply.…` for a call case, `[i].…` for raw frames. */
function shape(entry: CompareCase, replies: Reply[]): unknown {
  return entry.kind === 'raw'
    ? replies
    : {
        hello: replies[0],
        reply: replies[1],
        ...(replies.length > 2 ? { extra: replies.slice(2) } : {}),
      }
}

/**
 * Step 2: verified derived-hash values become `«derived:<field>»` wherever they
 * occur, then measured volatile inputs are tokenized (unless --raw).
 */
function normalize(
  entry: CompareCase,
  replies: Reply[],
  verified: Map<string, string>
): Map<string, unknown> {
  let text = JSON.stringify(shape(entry, replies))
  for (const [value, field] of verified) text = text.replaceAll(value, `«derived:${field}»`)
  if (masking) {
    for (const token of TOKENS) {
      for (const value of token.find(replies)) text = text.replaceAll(value, `«${token.token}»`)
    }
  }
  const flat = new Map<string, unknown>()
  flatten(JSON.parse(text), '', flat)
  if (masking) {
    for (const path of flat.keys()) {
      const mask = RESPONSE_MASK.find((entry) => pathMatches(entry.path, path))
      if (mask !== undefined) flat.set(path, `«${mask.token}»`)
    }
  }
  return flat
}

function diffMaps(a: Map<string, unknown>, b: Map<string, unknown>): Difference[] {
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort()
  return keys
    .filter((key) => JSON.stringify(a.get(key)) !== JSON.stringify(b.get(key)))
    .map((key) => ({ path: key, a: a.get(key), b: b.get(key) }))
}

/** Declared extras (`<case>:<reply path>`) must be on that subject only; reported, then removed. */
function takeDeclaredExtras(
  caseId: string,
  own: Map<string, unknown>,
  other: Map<string, unknown>,
  subject: Subject
): { declared: Record<string, unknown>; violations: string[] } {
  const declared: Record<string, unknown> = {}
  const violations: string[] = []
  for (const path of subject.declaredExtras.get(caseId) ?? []) {
    const matches = (key: string) =>
      key === path || key.startsWith(`${path}.`) || key.startsWith(`${path}[`)
    const ownKeys = [...own.keys()].filter(matches)
    if (ownKeys.length === 0) violations.push(`declared extra ${path} absent on ${subject.name}`)
    if ([...other.keys()].some(matches))
      violations.push(`declared extra ${path} also on the other subject`)
    for (const key of ownKeys) {
      declared[key] = own.get(key)
      own.delete(key)
    }
  }
  return { declared, violations }
}

function compare(cases: CompareCase[], a: Capture, b: Capture, subjects: [Subject, Subject]) {
  return cases.map((entry) => {
    const checkA = selfCheck(entry, a.replies[entry.id] ?? [])
    const checkB = selfCheck(entry, b.replies[entry.id] ?? [])
    const selfChecks = {
      a: [...checkA.mismatches, ...(a.fingerprintViolations[entry.id] ?? [])],
      b: [...checkB.mismatches, ...(b.fingerprintViolations[entry.id] ?? [])],
    }
    const left = normalize(entry, a.replies[entry.id] ?? [], checkA.verified)
    const right = normalize(entry, b.replies[entry.id] ?? [], checkB.verified)
    const extraA = takeDeclaredExtras(entry.id, left, right, subjects[0])
    const extraB = takeDeclaredExtras(entry.id, right, left, subjects[1])
    const replyDiffs = diffMaps(left, right)
    const treeDiffs = diffMaps(
      new Map(Object.entries(a.trees[entry.id] ?? {})),
      new Map(Object.entries(b.trees[entry.id] ?? {}))
    )
    const violations = [...extraA.violations, ...extraB.violations]
    const ok =
      selfChecks.a.length === 0 &&
      selfChecks.b.length === 0 &&
      violations.length === 0 &&
      replyDiffs.length === 0 &&
      treeDiffs.length === 0
    return {
      case: entry.id,
      ok,
      ...(selfChecks.a.length + selfChecks.b.length > 0 ? { selfChecks } : {}),
      ...(Object.keys(extraA.declared).length + Object.keys(extraB.declared).length > 0
        ? { declaredExtras: { a: extraA.declared, b: extraB.declared } }
        : {}),
      ...(violations.length > 0 ? { violations } : {}),
      ...(replyDiffs.length > 0 ? { replyDiffs } : {}),
      ...(treeDiffs.length > 0 ? { treeDiffs } : {}),
    }
  })
}

// -- main -----------------------------------------------------------------------

function parseSubject(name: 'a' | 'b', aspd: string): Subject {
  const cmd = arg(`--${name}-cmd`)
  const declaredExtras = new Map<string, string[]>()
  for (const spec of args(`--${name}-declared-extra`)) {
    // `<case id>:<reply path>`; case ids contain ':', reply paths never do.
    const split = spec.lastIndexOf(':')
    const [caseId, path] = [spec.slice(0, split), spec.slice(split + 1)]
    declaredExtras.set(caseId, [...(declaredExtras.get(caseId) ?? []), path])
  }
  return { name, argv: cmd === undefined ? [aspd] : (JSON.parse(cmd) as string[]), declaredExtras }
}

async function main(): Promise<number> {
  masking = !process.argv.includes('--raw')
  const out = resolve(
    arg('--out') ?? join(repo, '..', 'var', 'wrkq-artifacts', 'T-11833', 'compare')
  )
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const commit = must(['git', 'rev-parse', arg('--commit') ?? 'HEAD']).trim()
  // Unix socket paths are limited to 104 bytes on macOS; keep the scratch root short.
  const scratch = mkdtempSync('/tmp/aspcmp-')
  const ns = join(scratch, 'var', 'aspd')
  const socketDir = join(ns, 'run')
  mkdirSync(socketDir, { recursive: true })
  const release = buildScratchRelease(commit, scratch, join(ns, 'releases'))
  const releaseDir = join(ns, 'releases', release.releaseId)
  const aspd = inspectRelease(releaseDir).executableResolution.aspd?.launcher
  if (aspd === undefined) throw new Error(`release ${release.releaseId} has no aspd`)

  const stage = join(scratch, 'stage')
  const seed = join(scratch, 'seed')
  const asp = await loadAsp()
  const seeded = seedStage(asp, stage)
  const cases = buildCases(asp, seeded)
  cpSync(stage, seed, { recursive: true, verbatimSymlinks: true })
  const env: Record<string, string> = {}
  for (const key of INHERITED_ENV)
    if (process.env[key] !== undefined) env[key] = process.env[key] as string
  Object.assign(env, {
    ASP_HOME: seeded.aspHome,
    ASP_AGENTS_ROOT: seeded.agentsRoot,
    ASPD_COMPARE_RELEASE: releaseDir,
  })

  const subjects: [Subject, Subject] = [parseSubject('a', aspd), parseSubject('b', aspd)]
  const paths = { seed, stage, ns, socket: join(socketDir, 'aspd.sock'), out }
  const captureA = await runSubject(subjects[0], cases, paths, env)
  const captureB = await runSubject(subjects[1], cases, paths, env)
  const results = compare(cases, captureA, captureB, subjects)
  const metricsDir = join(scratch, 'var', 'state', 'agent-spaces', 'metrics')
  if (existsSync(metricsDir)) {
    mkdirSync(join(out, 'metrics'), { recursive: true })
    for (const name of readdirSync(metricsDir))
      copyFileSync(join(metricsDir, name), join(out, 'metrics', name))
  }
  const failed = results.filter((result) => !result.ok)
  const report = {
    commit,
    releaseId: release.releaseId,
    scratch,
    stage,
    masking,
    subjects: subjects.map(({ name, argv, declaredExtras }) => ({
      name,
      argv,
      declaredExtras: Object.fromEntries(declaredExtras),
    })),
    // Each subject's derived fingerprints and the token each was compared as.
    derivedTokens: {
      a: Object.fromEntries(captureA.fingerprints),
      b: Object.fromEntries(captureB.fingerprints),
    },
    summary: {
      cases: results.length,
      ok: results.length - failed.length,
      failed: failed.map((result) => result.case),
    },
    results,
  }
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  for (const result of results)
    process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'} ${result.case}\n`)
  process.stdout.write(
    `${results.length - failed.length}/${results.length} cases match; report ${join(out, 'report.json')}\n`
  )
  if (!process.argv.includes('--keep-scratch')) {
    // Installed releases are read-only; make the scratch writable to remove it.
    spawnSync('chmod', ['-R', 'u+w', scratch])
    rmSync(scratch, { recursive: true, force: true })
  }
  return failed.length === 0 ? 0 : 1
}

if (import.meta.main) process.exit(await main())
