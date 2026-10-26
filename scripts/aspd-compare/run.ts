#!/usr/bin/env bun
/**
 * aspd compare runner (T-11833, plan docs/proposals/aspd-rust-front-door.md).
 *
 *   bun scripts/aspd-compare/run.ts --out <dir> [--commit <sha>]
 *     [--a-cmd '<json argv>'] [--b-cmd '<json argv>']
 *     [--a-declared-extra <case>:<path>]... [--b-declared-extra <case>:<path>]...
 *     [--release-artifact <built release dir>] [--cases live] [--raw] [--keep-scratch]
 *     [--live-agents a,b,..] [--live-projects p,q,..] [--live-task <id>] [--live-resume]
 *   bun scripts/aspd-compare/run.ts --out <dir> --external-a <socket> --external-b <socket>
 *     [--external-asp-home <dir>] [--external-a-log <log>] [--external-b-log <log>] [--live-* ...]
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
 * The --live-* flags narrow the live corpus (live-cases.ts LiveSelection).
 * Each case also records the `rpc.request` lines its subject logged while
 * serving it (raspd's carry servedBy, relay and fallback) and, for the
 * front-door subject, the requests its Bun upstream logged.
 *
 * --external-a/-b compare two already-running daemons (the production A/B,
 * T-11882 Phase B): no release, no stage, no tree manifests. The live cases
 * are built against the real agents root and project checkouts with the
 * daemons' ASP_HOME, and each case is sent serially A, A, B: A vs A is the
 * volatility measurement (raw differences recorded; the masked pair must
 * match), A vs B is the comparison. Requests are timestamped, B's rpc.request
 * line is matched by op and time window, and each case's runtimeId is counted
 * in A's log (`request.admitted`): 2 when B served it natively, 3 when B
 * relayed it to A.
 *
 * Writes <out>/report.json (every case, every difference) and per-subject
 * replies, trees and final stages, then removes the scratch root (unless
 * --keep-scratch); exits 0 only when every case matches and no row in the
 * node's production metrics day files is owned by the run (its pid, or its
 * release from a process that started during the run).
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
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { join, relative, resolve } from 'node:path'

import { derivePlanHashes } from '../../compiler/agent-spaces/src/compile-plan-finalize.ts'
import { inspectRelease } from '../asp-release.ts'
import { buildScratchRelease, installReleaseArtifact, must, repo } from '../lib/scratch-release.ts'
import {
  appendedUsageMetricsRows,
  isolateUsageMetrics,
  snapshotUsageMetrics,
} from '../lib/usage-metrics-isolation.ts'
import { type Asp, loadAsp } from '../path-markers-e2e.ts'
import { type CompareCase, HELLO_PARAMS, buildCases, seedStage } from './cases.ts'
import { type LiveStage, buildLiveCases, seedLiveStage } from './live-cases.ts'
import { RESPONSE_MASK, TOKENS, TREE_MASK } from './volatile-mask.ts'

// Usage metrics from this script and its children stay out of the real day files (T-11824);
// the run audits the production files for its own rows at the end.
const childPids = isolateUsageMetrics()
const productionBefore = snapshotUsageMetrics()
// Processes alive before the run cannot be its subjects. When the release under
// test is the node's active one, production aspd's rows name it too (T-11882).
const preexistingPids = new Set(
  spawnSync('ps', ['-axo', 'pid='], { encoding: 'utf8' })
    .stdout.split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => pid > 0 && pid !== process.pid)
)

function args(name: string): string[] {
  return process.argv.flatMap((value, index) => (process.argv[index - 1] === name ? [value] : []))
}
const arg = (name: string) => args(name)[0]

type Reply = Record<string, unknown> | { unparsed: string }
type TreeEntry = string
/** One `rpc.request` log line's data: op, outcome, servedBy, relay, fallback, durationMs. */
type Served = Record<string, unknown>
type Capture = {
  replies: Record<string, Reply[]>
  served: Record<string, { subject: Served[]; upstream: Served[] }>
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
  // Timestamps are seed state too (bundle-version pruning reads mtimes).
  cpSync(seed, stage, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
  copyDirectoryTimes(seed, stage)
}

/** cpSync preserves file times only; give each directory its source's times, children first. */
function copyDirectoryTimes(from: string, to: string): void {
  for (const name of readdirSync(from)) {
    const source = join(from, name)
    if (lstatSync(source).isDirectory()) copyDirectoryTimes(source, join(to, name))
  }
  const { atime, mtime } = lstatSync(from)
  utimesSync(to, atime, mtime)
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

/** A log file read from a byte offset on, for per-case slices. */
function logCursor(path: string) {
  let offset = 0
  const read = (): string => {
    if (!existsSync(path)) return ''
    const text = readFileSync(path).subarray(offset)
    const end = text.lastIndexOf(10) + 1
    offset += end
    return text.subarray(0, end).toString('utf8')
  }
  return { skip: () => void read(), read }
}

const rpcRequests = (text: string): Served[] =>
  text
    .split('\n')
    .filter((line) => line.includes('"event":"rpc.request"'))
    .map((line) => (JSON.parse(line) as { data: Served }).data)

/** The case's rpc.request lines; waits briefly for its own method's line to be flushed. */
async function servedSlice(cursor: ReturnType<typeof logCursor>, method: string | undefined) {
  const lines: Served[] = []
  const deadline = Date.now() + 2_000
  for (;;) {
    lines.push(...rpcRequests(cursor.read()))
    if (method === undefined || lines.some((line) => line['op'] === method)) return lines
    if (Date.now() > deadline) return lines
    await Bun.sleep(20)
  }
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
    // One decoder for the stream: a multibyte character split across reads
    // must not decode as replacement characters.
    const decoder = new TextDecoder()
    connection.on('data', (chunk) => {
      buffer += decoder.decode(chunk, { stream: true })
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
  const capture: Capture = {
    replies: {},
    served: {},
    trees: {},
    fingerprintViolations: {},
    fingerprints,
  }
  const subjectLog = logCursor(log)
  // front-door-subject.sh logs its Bun upstream beside raspd's log.
  const upstreamLog = logCursor(`${log}.bun`)
  try {
    await awaitReady(paths.socket, child)
    for (const entry of cases) {
      subjectLog.skip()
      upstreamLog.skip()
      capture.replies[entry.id] = await drive(
        paths.socket,
        caseFrames(entry),
        entry.kind === 'raw' ? 5_000 : 180_000
      )
      const method = entry.kind === 'call' ? entry.method : undefined
      const subjectLines = await servedSlice(subjectLog, method)
      const relayed = subjectLines.some(
        (line) => line['op'] === method && line['relay'] === 'relayed'
      )
      capture.served[entry.id] = {
        subject: subjectLines,
        // A relayed request's upstream line can land after the reply; wait for it.
        upstream: await servedSlice(upstreamLog, relayed ? method : undefined),
      }
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
    join(paths.out, `${subject.name}-served.json`),
    `${JSON.stringify(capture.served, null, 2)}\n`
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
    const method = entry.kind === 'call' ? entry.method : undefined
    const servedB = b.served[entry.id]
    const own = servedB?.subject.find((line) => line['op'] === method)
    return {
      case: entry.id,
      ok,
      // B's own log line for the case's method, and what its upstream (if any) saw.
      servedBy: {
        b: own?.['servedBy'] ?? null,
        ...(own?.['relay'] !== undefined ? { relay: own['relay'] } : {}),
        ...(own?.['fallback'] !== undefined ? { fallback: own['fallback'] } : {}),
        bUpstreamOps: (servedB?.upstream ?? []).map((line) => line['op']),
        durationMs: {
          a: a.served[entry.id]?.subject.find((line) => line['op'] === method)?.['durationMs'],
          b: own?.['durationMs'],
        },
      },
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
  // --release-artifact reuses a release built earlier (asp-release.ts build
  // output) instead of building <commit> from a clean clone.
  const artifact = arg('--release-artifact')
  const release =
    artifact === undefined
      ? buildScratchRelease(commit, scratch, join(ns, 'releases'))
      : installReleaseArtifact(resolve(artifact), join(ns, 'releases'))
  const releaseDir = join(ns, 'releases', release.releaseId)
  const aspd = inspectRelease(releaseDir).executableResolution.aspd?.launcher
  if (aspd === undefined) throw new Error(`release ${release.releaseId} has no aspd`)

  const stage = join(scratch, 'stage')
  const seed = join(scratch, 'seed')
  // --cases live: the node's real agents and projects (live-cases.ts).
  const live = arg('--cases') === 'live'
  const list = (name: string) => arg(name)?.split(',').filter(Boolean)
  const selection = {
    agents: list('--live-agents'),
    projects: list('--live-projects'),
    task: arg('--live-task'),
    resume: process.argv.includes('--live-resume'),
  }
  const asp = live ? undefined : await loadAsp()
  const seeded = live ? seedLiveStage(stage) : seedStage(asp as Asp, stage)
  const cases = live
    ? buildLiveCases(seeded as LiveStage, selection)
    : buildCases(asp as Asp, seeded as ReturnType<typeof seedStage>)
  cpSync(stage, seed, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
  copyDirectoryTimes(stage, seed)
  const env: Record<string, string> = {}
  for (const key of INHERITED_ENV)
    if (process.env[key] !== undefined) env[key] = process.env[key] as string
  Object.assign(env, {
    ASP_HOME: seeded.aspHome,
    ASP_AGENTS_ROOT: seeded.agentsRoot,
    ASPD_COMPARE_RELEASE: releaseDir,
    // Subjects' metrics (Bun aspd, raspd, anything they start) go to the run's
    // scratch var root, never the node's: the override wins over the release root.
    ASP_USAGE_METRICS_VAR_ROOT: join(scratch, 'var'),
    // Workspace trust goes to the stage, never the operator's ~/.claude.json.
    ...(live ? { CLAUDE_CONFIG_DIR: (seeded as LiveStage).claudeConfigDir } : {}),
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
  // Production rows owned by this run: by pid (this process, its children, any
  // process that wrote to the scratch day files) or by a product naming the
  // run's release (Bun aspd and raspd subjects and whatever they start).
  const runPids = new Set([process.pid, ...childPids])
  for (const name of existsSync(metricsDir) ? readdirSync(metricsDir) : []) {
    for (const line of readFileSync(join(metricsDir, name), 'utf8').split('\n')) {
      const pid = line.match(/"pid":(\d+)/)?.[1]
      if (pid !== undefined) runPids.add(Number(pid))
    }
  }
  const appended = appendedUsageMetricsRows(productionBefore)
  const byRunPid = (row: Record<string, unknown>) =>
    typeof row['pid'] === 'number' && runPids.has(row['pid'])
  const namesRelease = (row: Record<string, unknown>) =>
    String(row['product'] ?? '').includes(release.releaseId)
  const preexisting = (row: Record<string, unknown>) =>
    typeof row['pid'] === 'number' && preexistingPids.has(row['pid'])
  const leaked = appended.filter((row) => byRunPid(row) || (namesRelease(row) && !preexisting(row)))
  const preexistingReleaseRows = appended.filter(
    (row) => !byRunPid(row) && namesRelease(row) && preexisting(row)
  )
  const productionAudit = {
    runPids: runPids.size,
    leakedRows: leaked.length,
    leaked,
    // Rows naming the release from processes that predate the run (the node's own aspd).
    preexistingReleaseRows: {
      count: preexistingReleaseRows.length,
      pids: [...new Set(preexistingReleaseRows.map((row) => row['pid']))],
    },
  }
  const failed = results.filter((result) => !result.ok)
  const report = {
    commit,
    releaseId: release.releaseId,
    scratch,
    stage,
    masking,
    ...(live ? { liveSelection: selection } : {}),
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
    productionAudit,
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
  process.stdout.write(
    `production metrics: ${leaked.length} rows owned by this run (${runPids.size} pids audited)\n`
  )
  return failed.length === 0 && leaked.length === 0 ? 0 : 1
}

// -- external subjects (production A/B) ---------------------------------------

type Sent = { sentAt: string; answeredAt: string; ms: number; replies: Reply[] }

async function send(socket: string, entry: CompareCase): Promise<Sent> {
  const start = Date.now()
  const replies = await drive(socket, caseFrames(entry))
  const end = Date.now()
  return {
    sentAt: new Date(start).toISOString(),
    answeredAt: new Date(end).toISOString(),
    ms: end - start,
    replies,
  }
}

const logLines = (path: string): Record<string, unknown>[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>]
          } catch {
            return []
          }
        })
    : []

async function mainExternal(): Promise<number> {
  const out = resolve(arg('--out') ?? 'aspd-compare-external')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const sockets = {
    a: resolve(arg('--external-a') as string),
    b: resolve(arg('--external-b') as string),
  }
  const logsDir = join(repo, '..', 'var', 'logs', 'agent-spaces')
  const logs = {
    a: resolve(arg('--external-a-log') ?? join(logsDir, 'aspd.log')),
    b: resolve(arg('--external-b-log') ?? join(logsDir, 'raspd.log')),
  }
  const praesidium = resolve(repo, '..')
  const stage: LiveStage = {
    base: praesidium,
    agentsRoot: join(praesidium, 'var', 'agents'),
    aspHome: resolve(arg('--external-asp-home') ?? join(praesidium, 'var', 'spaces-repo')),
    claudeConfigDir: '',
    projectsRoot: praesidium,
  }
  const list = (name: string) => arg(name)?.split(',').filter(Boolean)
  const selection = {
    agents: list('--live-agents'),
    projects: list('--live-projects'),
    task: arg('--live-task'),
    resume: process.argv.includes('--live-resume'),
  }
  const cases = buildLiveCases(stage, selection)
  const sends: Record<string, { a1: Sent; a2: Sent; b: Sent }> = {}
  for (const entry of cases) {
    const a1 = await send(sockets.a, entry)
    const a2 = await send(sockets.a, entry)
    const b = await send(sockets.b, entry)
    sends[entry.id] = { a1, a2, b }
    process.stdout.write(
      `${b.answeredAt} ${entry.id} a1 ${a1.sentAt} ${a1.ms}ms a2 ${a2.sentAt} ${a2.ms}ms b ${b.sentAt} ${b.ms}ms\n`
    )
  }
  writeFileSync(join(out, 'sends.json'), `${JSON.stringify(sends, null, 2)}\n`)
  // Let both daemons flush their request lines.
  await Bun.sleep(1_000)
  const aLog = logLines(logs.a)
  const bLog = logLines(logs.b)
  const data = (line: Record<string, unknown>) => (line['data'] ?? {}) as Record<string, unknown>
  const pairResult = (
    entry: CompareCase,
    left: Reply[],
    right: Reply[]
  ): { selfChecks: string[]; raw: Difference[]; masked: Difference[] } => {
    const checkL = selfCheck(entry, left)
    const checkR = selfCheck(entry, right)
    const flat = (replies: Reply[], verified: Map<string, string>, mask: boolean) => {
      masking = mask
      return normalize(entry, replies, verified)
    }
    const raw = diffMaps(flat(left, new Map(), false), flat(right, new Map(), false))
    const masked = diffMaps(flat(left, checkL.verified, true), flat(right, checkR.verified, true))
    return { selfChecks: [...checkL.mismatches, ...checkR.mismatches], raw, masked }
  }
  const results = cases.map((entry) => {
    const sent = sends[entry.id] as { a1: Sent; a2: Sent; b: Sent }
    const volatility = pairResult(entry, sent.a1.replies, sent.a2.replies)
    const ab = pairResult(entry, sent.a1.replies, sent.b.replies)
    const method = entry.kind === 'call' ? entry.method : undefined
    const runtimeId =
      entry.kind === 'call'
        ? (entry.compileRequest as { identity?: { runtimeId?: string } } | undefined)?.identity
            ?.runtimeId
        : undefined
    // B's own line: an rpc.request for the op, logged within its request
    // window; when other clients' requests overlap (births on a live node),
    // the one whose durationMs fits this round trip.
    const windowEnd = new Date(Date.parse(sent.b.answeredAt) + 250).toISOString()
    const inWindow = bLog.filter(
      (line) =>
        line['event'] === 'rpc.request' &&
        data(line)['op'] === method &&
        String(line['ts']) >= sent.b.sentAt &&
        String(line['ts']) <= windowEnd
    )
    const fits = (line: Record<string, unknown>) =>
      Math.abs(Number(data(line)['durationMs']) - sent.b.ms) <= 25
    const bLines = inWindow.length > 1 ? inWindow.filter(fits) : inWindow
    const admitted =
      runtimeId === undefined
        ? undefined
        : aLog.filter(
            (line) =>
              line['event'] === 'request.admitted' &&
              data(line)['runtimeId'] === runtimeId &&
              String(line['ts']) >= sent.a1.sentAt &&
              String(line['ts']) <= windowEnd
          ).length
    const own = bLines.length === 1 ? data(bLines[0] as Record<string, unknown>) : undefined
    const ok =
      volatility.selfChecks.length === 0 &&
      ab.selfChecks.length === 0 &&
      volatility.masked.length === 0 &&
      ab.masked.length === 0
    return {
      case: entry.id,
      ok,
      sentAt: { a1: sent.a1.sentAt, a2: sent.a2.sentAt, b: sent.b.sentAt },
      roundTripMs: { a1: sent.a1.ms, a2: sent.a2.ms, b: sent.b.ms },
      servedBy: {
        b: own?.['servedBy'] ?? (bLines.length > 1 ? 'ambiguous' : null),
        ...(own?.['relay'] !== undefined ? { relay: own['relay'] } : {}),
        ...(own?.['fallback'] !== undefined ? { fallback: own['fallback'] } : {}),
        outcome: own?.['outcome'] ?? null,
        durationMs: own?.['durationMs'] ?? null,
        bLinesInWindow: inWindow.length,
        bLinesMatched: bLines.length,
        // 2 = only the two A sends reached A; 3 = B relayed this case to A.
        aAdmissionsForRuntimeId: admitted,
      },
      ...(volatility.selfChecks.length + ab.selfChecks.length > 0
        ? { selfChecks: { volatility: volatility.selfChecks, ab: ab.selfChecks } }
        : {}),
      volatility: { rawPaths: volatility.raw.map((d) => d.path), maskedDiffs: volatility.masked },
      ab: { rawPaths: ab.raw.map((d) => d.path), maskedDiffs: ab.masked },
    }
  })
  const failed = results.filter((result) => !result.ok)
  const measured = [...new Set(results.flatMap((result) => result.volatility.rawPaths))].sort()
  const report = {
    mode: 'external',
    sockets,
    logs,
    aspHome: stage.aspHome,
    liveSelection: selection,
    // Every reply path that differed between A's two answers to one request.
    measuredVolatilePaths: measured,
    summary: {
      cases: results.length,
      ok: results.length - failed.length,
      failed: failed.map((result) => result.case),
    },
    results,
  }
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  for (const result of results)
    process.stdout.write(
      `${result.ok ? 'PASS' : 'FAIL'} ${result.case} servedBy=${String(result.servedBy.b)}${result.servedBy.fallback !== undefined ? ` fallback=${String(result.servedBy.fallback)}` : ''}\n`
    )
  process.stdout.write(
    `${results.length - failed.length}/${results.length} cases match; report ${join(out, 'report.json')}\n`
  )
  return failed.length === 0 ? 0 : 1
}

if (import.meta.main)
  process.exit(await (arg('--external-a') !== undefined ? mainExternal() : main()))
