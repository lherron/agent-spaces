#!/usr/bin/env bun
/**
 * raspd sole mode, table-driven (T-13039, T-13018 r2 section 1 and 2.1).
 *
 * A raspd started without --upstream has no Bun behind it: every forward is
 * answered from crates/raspd/dispositions.json. On a fresh scratch stage (the
 * compare runner's fixture) and a synthetic release, this sends every
 * runnable case of every refuse and impossible row (the T-13008 cases, under
 * cases/) and checks, per case:
 *
 *  1. the reply is the row's envelope and code for that op (message text is
 *     not compared);
 *  2. raspd's log shows that very row refusing (`native.refused`, or
 *     `raspd.defect` for an impossible row) for that op, with the context
 *     the case expects;
 *  3. for a row decided from the inputs, ASP_HOME, the agents and project
 *     roots, the Claude config dir and the case's own dir are byte-identical
 *     before and after.
 *
 * Lock waits have no test seam (one 60 s wait each): global_lock_lock--held
 * is run, concurrently with the rest; bundle_scope_lock and codex_home_lock
 * are not. Also checked: version/health name no upstream in sole mode.
 *
 * Usage: bun scripts/raspd-sole/table-e2e.ts --raspd <binary>
 *          [--scratch <dir>] [--only <case-id regex>] [--out <results.json>] [--keep]
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { HELLO_PARAMS } from '../aspd-compare/cases.ts'
import { type ProbeCase, ctxFor } from './ctx.ts'
import { drive, frame, logLines, startRig } from './rig.ts'

const repo = resolve(import.meta.dir, '..', '..')
const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}
const raspd = arg('--raspd')
if (raspd === undefined) {
  console.error(
    'usage: table-e2e.ts --raspd <binary> [--scratch <dir>] [--only <re>] [--out <file>] [--keep]'
  )
  process.exit(2)
}
const only = arg('--only') ? new RegExp(arg('--only') as string) : undefined
const scratch = resolve(arg('--scratch') ?? mkdtempSync(join(tmpdir(), 'raspd-sole-')))
mkdirSync(scratch, { recursive: true })

// -- the table ---------------------------------------------------------------------
type Reply =
  | { rpc: [number, string] }
  | { diagnostic: string }
  | { failure: [string, string] }
  | { resolution: [string, string] }
type Row = {
  reason: string
  disposition: 'refuse' | 'impossible' | 'native'
  decided?: 'input' | 'write'
  ops: string[]
  replies: Record<string, Reply>
  contexts?: Record<string, Record<string, Reply>>
  runnable: string[]
}
const table: { rows: Row[] } = JSON.parse(
  readFileSync(join(repo, 'crates', 'raspd', 'dispositions.json'), 'utf8')
)
const _rows = new Map(table.rows.map((r) => [r.reason, r]))

/** The row's reply for `op` raised in `context` (disposition.rs `Row::reply`). */
function expected(row: Row, op: string, context: string | undefined): Reply | undefined {
  const c = context === undefined ? undefined : row.contexts?.[context]
  return c?.[op] ?? c?.['*'] ?? row.replies[op] ?? row.replies['*']
}

/** Where a case's forward is raised, when its row's code depends on it. */
const CONTEXTS: Record<string, string> = {
  'fs_errno_unported--priming-socket': 'priming',
  'fs_errno_unported--read-source-socket': 'read_source',
  'fs_errno_unported--search-targets-socket': 'search_targets',
  'toml_bigint--profile': 'profile',
  'toml_bom--profile': 'profile',
  'toml_datetime--profile-unknown-key': 'profile',
  'toml_nonfinite_float--profile': 'profile',
  'toml_proto_key--profile': 'profile',
  'toml_quote_run--profile-priming': 'profile',
  'toml_quote_run--profile-comment': 'profile',
  'project_targets_invalid--placement': 'placement_targets',
  'source_read_unavailable--placement-targets': 'placement_targets',
  'global_lock_lock--held': 'held',
}
/** Lock rows: one 60 s wait each and no seam to shorten it; this one runs. */
const LOCK_CASES = new Set(['global_lock_lock--held'])
const UNRUN_LOCK_CASES = new Set(['bundle_scope_lock', 'codex_home_lock'])

/** A reply as the table's shape, with the envelope checks it implies. */
function shapeOf(method: string, reply: any): { shape?: Reply; envelope: string[] } {
  const envelope: string[] = []
  if (reply?.error) {
    if (typeof reply.error.message !== 'string') envelope.push('error.message is not a string')
    return { shape: { rpc: [reply.error.code, reply.error.data?.reason] }, envelope }
  }
  const r = reply?.result
  if (!r || r.ok !== false) return { envelope: ['not a refusal'] }
  const version: Record<string, string> = {
    'aspc.compileHarnessInvocation': 'aspc-compile-harness-invocation-response/v2',
    'aspc.inspectRuntimePlacement': 'aspc-inspect-runtime-placement-response/v1',
    'aspc.resolveRuntimeDeclaration': 'aspc-resolve-runtime-declaration-response/v1',
  }
  if (r.schemaVersion !== version[method]) envelope.push(`schemaVersion ${r.schemaVersion}`)
  if (method === 'aspc.compileHarnessInvocation') {
    const d = r.diagnostics?.[0]
    if (d?.level !== 'error' || d?.plane !== 'asp-compiler') envelope.push('diagnostics[0] shape')
    return { shape: { diagnostic: d?.code }, envelope }
  }
  let body = r
  if (method === 'aspc.inspectRuntimePlacement') {
    body = r.declaration
    if (body?.ok !== false || body?.schemaVersion !== version['aspc.resolveRuntimeDeclaration'])
      envelope.push('declaration envelope')
  }
  if (body?.failure) return { shape: { failure: [body.failure.kind, body.failure.code] }, envelope }
  if (body?.resolution)
    return { shape: { resolution: [body.resolution.state, body.resolution.code] }, envelope }
  return { envelope: [...envelope, 'no failure or resolution'] }
}

// -- the tree a refused request must leave alone -----------------------------------------
function snapshot(roots: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (path: string) => {
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(path)
    } catch {
      return
    }
    const mode = (st.mode & 0o7777).toString(8)
    if (st.isSymbolicLink()) {
      out.set(path, `link ${mode} ${readlinkSync(path)}`)
    } else if (st.isDirectory()) {
      let names: string[]
      try {
        names = readdirSync(path).sort()
      } catch {
        out.set(path, `dir ${mode} unreadable`)
        return
      }
      out.set(path, `dir ${mode} ${names.join('/')}`)
      for (const n of names) walk(join(path, n))
    } else if (st.isFile()) {
      let digest = 'unreadable'
      try {
        digest = createHash('sha256').update(readFileSync(path)).digest('hex')
      } catch {}
      out.set(path, `file ${mode} ${digest}`)
    } else {
      out.set(path, `other ${mode}`)
    }
  }
  for (const r of roots) walk(r)
  return out
}

function treeDiff(a: Map<string, string>, b: Map<string, string>): string[] {
  const diff: string[] = []
  for (const [k, v] of a) if (b.get(k) !== v) diff.push(`${k}: ${v} -> ${b.get(k) ?? 'gone'}`)
  for (const [k, v] of b) if (!a.has(k)) diff.push(`${k}: new ${v}`)
  return diff
}

// -- run -----------------------------------------------------------------------------------
const rig = await startRig(scratch, raspd)
const { stage, bases, socket, log } = rig
const failures: string[] = []
const results: Record<string, unknown>[] = []
try {
  const [, version, health] = await drive(socket, [
    frame(1, 'aspc.hello', HELLO_PARAMS),
    frame(2, 'version', {}),
    frame(3, 'health', {}),
  ])
  const door = version?.result?.frontDoor
  if (door?.role !== 'sole' || 'upstream' in (door ?? {}) || 'upstreamState' in (door ?? {}))
    failures.push(`version.frontDoor in sole mode: ${JSON.stringify(door)}`)
  if (JSON.stringify(health?.result) !== '{"ok":true,"degraded":[]}')
    failures.push(`health in sole mode: ${JSON.stringify(health?.result)}`)

  const modules = readdirSync(join(import.meta.dir, 'cases')).filter((f) => f.endsWith('.ts'))
  const cases = new Map<string, ProbeCase>()
  for (const m of modules.sort()) {
    const mod = await import(join(import.meta.dir, 'cases', m))
    for (const pc of mod.default as ProbeCase[]) cases.set(pc.id ?? pc.reason, pc)
  }
  const selected: { id: string; pc: ProbeCase; row: Row }[] = []
  const unrunRows: string[] = []
  for (const row of table.rows) {
    if (row.disposition !== 'refuse' && row.disposition !== 'impossible') continue
    const ids = row.runnable.filter((id) => !UNRUN_LOCK_CASES.has(id))
    if (ids.length === 0) unrunRows.push(row.reason)
    for (const id of ids) {
      const pc = cases.get(id)
      if (pc === undefined) {
        failures.push(`${id}: runnable case of ${row.reason} is missing from cases/`)
        continue
      }
      if (only && !only.test(id)) continue
      selected.push({ id, pc, row })
    }
  }

  let logAt = 0
  /** A case's native prep (`<id>--prep`: it publishes what the case then damages). */
  const prep = async (id: string) => {
    const pc = cases.get(`${id}--prep`)
    if (pc === undefined) return
    const c = ctxFor(stage, bases, scratch, `${id}--prep`)
    pc.setup?.(c)
    const [, reply] = await drive(socket, [
      frame(1, 'aspc.hello', HELLO_PARAMS),
      frame(2, pc.method, pc.params(c)),
    ])
    if (reply?.result?.ok !== true)
      throw new Error(`${id}--prep: ${JSON.stringify(reply).slice(0, 300)}`)
  }
  const runOne = async (id: string, pc: ProbeCase, row: Row, concurrent: boolean) => {
    await prep(id)
    const c = ctxFor(stage, bases, scratch, id)
    rmSync(c.done, { force: true })
    pc.setup?.(c)
    const params = pc.params(c)
    const frames = pc.rawFrames
      ? pc.rawFrames(c)
      : [frame(1, 'aspc.hello', HELLO_PARAMS), frame(2, pc.method, params)]
    const roots = [stage.aspHome, stage.agentsRoot, stage.projectRoot, stage.claudeHome, c.dir]
    const checkTree = row.decided === 'input' && !concurrent
    const before = checkTree ? snapshot(roots) : undefined
    const replies = await drive(socket, frames)
    writeFileSync(c.done, '')
    const reply = replies.find((r) => r.id === 2) ?? replies[replies.length - 1]
    const problems: string[] = []
    if (before) {
      const diff = treeDiff(before, snapshot(roots))
      if (diff.length > 0) problems.push(`tree changed: ${diff.slice(0, 5).join('; ')}`)
    }
    const context = CONTEXTS[id]
    const want = expected(row, pc.method, context)
    const got = shapeOf(pc.method, reply)
    problems.push(...got.envelope)
    if (JSON.stringify(got.shape) !== JSON.stringify(want))
      problems.push(`reply ${JSON.stringify(got.shape)}, table ${JSON.stringify(want)}`)
    return { c, reply, problems, want, got, context }
  }

  // The lock case waits 60 s; it runs beside the others, on its own ASP_HOME.
  const locks = selected
    .filter((s) => LOCK_CASES.has(s.id))
    .map((s) => ({ ...s, pending: runOne(s.id, s.pc, s.row, true) }))
  for (const { id, pc, row } of selected.filter((s) => !LOCK_CASES.has(s.id))) {
    const started = Date.now()
    let ran: Awaited<ReturnType<typeof runOne>>
    try {
      ran = await runOne(id, pc, row, false)
    } catch (e) {
      failures.push(`${id}: setup failed: ${(e as Error).message}`)
      console.log(`FAIL ${id} setup failed: ${(e as Error).message}`)
      continue
    }
    const { reply, problems, want, got, context } = ran
    // Which forward refused it, from raspd's log (its access line follows).
    const lines: any[] = []
    for (const deadline = Date.now() + 5_000; Date.now() < deadline; ) {
      const read = logLines(log, logAt)
      logAt = read.to
      lines.push(...read.lines)
      // The case's own access line (a prep compile logs one before it).
      const served = lines.filter((l) => l.event === 'rpc.request' && l.data?.op === pc.method)
      if (served.length > (cases.has(`${id}--prep`) ? 1 : 0)) break
      await Bun.sleep(20)
    }
    const refused = lines.filter(
      (l) =>
        (l.event === 'native.refused' || l.event === 'raspd.defect') &&
        l.data?.op === pc.method &&
        l.data?.conn !== undefined
    )
    const hit = refused.find((l) => l.data.reason === row.reason)
    if (hit === undefined)
      problems.push(
        `log: not refused by ${row.reason} (saw ${refused.map((l) => l.data.reason).join(',') || 'none'})`
      )
    else if (hit.data.context !== context)
      problems.push(`log: context ${hit.data.context}, case expects ${context}`)
    const event = row.disposition === 'impossible' ? 'raspd.defect' : 'native.refused'
    if (hit !== undefined && hit.event !== event) problems.push(`log: ${hit.event}, want ${event}`)
    results.push({
      id,
      reason: row.reason,
      method: pc.method,
      decided: row.decided,
      ms: Date.now() - started,
      want,
      got: got.shape,
      problems,
    })
    console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'} ${id} ${problems.join(' | ')}`)
    if (problems.length > 0) {
      failures.push(`${id}: ${problems.join(' | ')}`)
      if (process.env['RASPD_SOLE_DEBUG']) console.log(JSON.stringify(reply).slice(0, 600))
    }
  }
  for (const { id, row, pc, pending } of locks) {
    const { problems, want, got } = await pending
    results.push({
      id,
      reason: row.reason,
      method: pc.method,
      decided: row.decided,
      want,
      got: got.shape,
      problems,
    })
    console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'} ${id} ${problems.join(' | ')}`)
    if (problems.length > 0) failures.push(`${id}: ${problems.join(' | ')}`)
  }
  const summary = {
    rowsRun: [...new Set(results.map((r) => r.reason))].length,
    casesRun: results.length,
    rowsWithoutRunnableCase: unrunRows,
    lockRowsNotRun: [...UNRUN_LOCK_CASES],
    failures,
  }
  console.log(JSON.stringify({ ...summary, failures: failures.length }))
  if (arg('--out'))
    writeFileSync(arg('--out') as string, `${JSON.stringify({ summary, results }, null, 2)}\n`)
} finally {
  await rig.stop()
  if (!process.argv.includes('--keep') && arg('--scratch') === undefined) {
    spawnSync('chmod', ['-R', 'u+rwx', scratch])
    rmSync(scratch, { recursive: true, force: true })
  }
}
process.exit(failures.length === 0 ? 0 : 1)
