/**
 * The native half of the raspd sole-mode table test (T-13048, T-13018 r2
 * close conditions 1 and 3): every case of a row raspd now answers natively,
 * sent to one subject on a rig at one fixed path, so a Bun aspd recording and
 * a raspd run see byte-identical inputs (absolute paths are plan-hash
 * material). Each case starts from the same seeded stage.
 *
 * `captureNative` runs the cases of native.json against a subject and returns
 * per case its replies, the stage tree it changed (masked and tokenized the
 * way the compare runner does) and the subject's fingerprint self-check
 * violations. `compareNative` judges a raspd capture against the recorded Bun
 * capture (bun-replies/), the way scripts/aspd-compare/run.ts compares: a Bun
 * success by its whole reply and tree (declared volatile fields only, derived
 * hashes verified per side, never masked); a Bun refusal by envelope and code.
 */
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { HELLO_PARAMS } from '../aspd-compare/cases.ts'
import type { CompareCase } from '../aspd-compare/cases.ts'
import {
  type Difference,
  type Fingerprints,
  type Reply,
  copyDirectoryTimes,
  deriveCodexHome,
  diffMaps,
  normalize,
  restoreStage,
  selfCheck,
  treeManifest,
  verifyFingerprints,
} from '../aspd-compare/compare-core.ts'
import { takeRaspdDiscoveryDifferences } from '../aspd-compare/raspd-discovery.ts'
import { type ProbeCase, ctxFor } from './ctx.ts'
import { type ReleaseIdentity, drive, frame, startRig } from './rig.ts'

/** One path for every native run: the inputs, so the plans, are identical. */
export const NATIVE_SCRATCH = '/private/tmp/raspd-sole-native'
export const BUN_REPLIES = join(import.meta.dir, 'bun-replies')
/** The Bun release the replies were recorded from; the native rig's release carries its identity. */
export const ORACLE = join(BUN_REPLIES, '_oracle.json')

export type NativeSpec = {
  /** Every case of a native row (and of a split row's native part), in run order. */
  cases: { id: string; reason: string; expect?: 'success' }[]
  /** Cases where raspd deliberately answers differently from Bun. */
  departures: { case: string; reason: string; why: string }[]
}
export const spec: NativeSpec = JSON.parse(
  readFileSync(join(import.meta.dir, 'native.json'), 'utf8')
)

export type Capture = {
  method: string
  /** The raw frames a frame case sent (else absent: hello + the call). */
  frames?: string[]
  /** The case's frames' replies, in order (hello first for a call case). */
  replies: Reply[]
  /** Stage entries the case added, changed (or removed: "gone"). */
  tree: Record<string, string>
  /** The subject's own fingerprint self-check (compare-core verifyFingerprints). */
  violations: string[]
}

export async function loadCases(): Promise<Map<string, ProbeCase>> {
  const cases = new Map<string, ProbeCase>()
  const dir = join(import.meta.dir, 'cases')
  for (const m of readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()) {
    const mod = await import(join(dir, m))
    for (const pc of mod.default as ProbeCase[]) cases.set(pc.id ?? pc.reason, pc)
  }
  return cases
}

/** The fixed path is one rig at a time: wait for (or clear a dead) holder. */
async function lock(): Promise<() => void> {
  const path = `${NATIVE_SCRATCH}.lock`
  for (let i = 0; ; i++) {
    try {
      mkdirSync(path)
      writeFileSync(join(path, 'pid'), `${process.pid}\n`)
      return () => rmSync(path, { recursive: true, force: true })
    } catch {
      const pid = Number(readFileSync(join(path, 'pid'), { encoding: 'utf8', flag: 'a+' }).trim())
      const alive = pid > 0 && spawnSync('kill', ['-0', String(pid)]).status === 0
      if (!alive) rmSync(path, { recursive: true, force: true })
      else if (i > 1200) throw new Error(`${path} held by pid ${pid}`)
      else await Bun.sleep(500)
    }
  }
}

/**
 * The compare runner's view of a case (its id, kind and compile request). A
 * frame case that is a hello and one call on one connection is judged as
 * that call (its params as JSON.parse reads them).
 */
export function entryOf(
  id: string,
  pc: ProbeCase,
  params: unknown,
  frames?: string[]
): CompareCase {
  if (pc.rawFrames) {
    const parsed = (frames ?? []).map((f) => {
      try {
        return JSON.parse(f)
      } catch {
        return undefined
      }
    })
    const call = parsed[1]
    if (frames?.length === 2 && parsed[0]?.method === 'aspc.hello' && call?.id === 2) {
      return entryOf(id, { ...pc, rawFrames: undefined, method: call.method }, call.params)
    }
    return { kind: 'raw', id, frames: frames ?? [] }
  }
  const compileRequest = (params as { compileRequest?: unknown } | null)?.compileRequest
  return {
    kind: 'call',
    id,
    method: pc.method,
    params,
    ...(pc.method === 'aspc.compileHarnessInvocation' && compileRequest !== undefined
      ? { compileRequest }
      : {}),
  }
}

export async function captureNative(
  binary: string,
  subject: 'raspd' | 'bun',
  identity: ReleaseIdentity,
  only?: RegExp
): Promise<Record<string, Capture & { params: unknown }>> {
  const unlock = await lock()
  const out: Record<string, Capture & { params: unknown }> = {}
  try {
    spawnSync('chmod', ['-R', 'u+rwx', NATIVE_SCRATCH])
    rmSync(NATIVE_SCRATCH, { recursive: true, force: true })
    mkdirSync(NATIVE_SCRATCH, { recursive: true })
    // Seat umasks (077) would give the restored stage other modes than the seed.
    const umask = process.umask(0o022)
    const rig = await startRig(NATIVE_SCRATCH, binary, [], subject, identity)
    try {
      const seed = join(NATIVE_SCRATCH, 'seed')
      cpSync(rig.stage.base, seed, {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      })
      copyDirectoryTimes(rig.stage.base, seed)
      restoreStage(seed, rig.stage.base)
      const seedTree = treeManifest(rig.stage.base, new Map())
      const cases = await loadCases()
      for (const { id } of spec.cases) {
        if (only && !only.test(id)) continue
        const pc = cases.get(id)
        if (pc === undefined) throw new Error(`native case ${id} is missing from cases/`)
        spawnSync('chmod', ['-R', 'u+rwx', rig.stage.base])
        restoreStage(seed, rig.stage.base)
        const c = ctxFor(rig.stage, rig.bases, NATIVE_SCRATCH, id)
        pc.setup?.(c)
        const params = pc.rawFrames ? null : pc.params(c)
        const frames = pc.rawFrames
          ? pc.rawFrames(c)
          : [frame(1, 'aspc.hello', HELLO_PARAMS), frame(2, pc.method, params)]
        const replies = (await drive(rig.socket, frames, pc.rawFrames ? 5_000 : 180_000)) as Reply[]
        writeFileSync(c.done, '')
        pc.teardown?.(c)
        const fingerprints: Fingerprints = new Map()
        const derived = new Set<string>()
        // A case that chmods its inputs (mode 000) leaves them unreadable to the walk.
        spawnSync('find', [
          rig.stage.base,
          '!',
          '-perm',
          '-u+r',
          '-exec',
          'chmod',
          'u+rx',
          '{}',
          '+',
        ])
        const violations = [
          ...(await deriveCodexHome(replies, derived)),
          ...verifyFingerprints(rig.stage.base, fingerprints, derived),
        ]
        const after = treeManifest(rig.stage.base, fingerprints)
        const tree: Record<string, string> = {}
        for (const [k, v] of Object.entries(after)) if (seedTree[k] !== v) tree[k] = v
        for (const k of Object.keys(seedTree)) if (!(k in after)) tree[k] = 'gone'
        out[id] = {
          method: pc.method,
          ...(pc.rawFrames ? { frames } : {}),
          params,
          replies,
          tree,
          violations,
        }
        process.stdout.write(`${subject} ${id}\n`)
      }
    } finally {
      await rig.stop()
      process.umask(umask)
    }
  } finally {
    unlock()
  }
  return out
}

/** The table test's envelope-and-code view of a refusal, or undefined for a success. */
export type Judged = { refusal?: unknown; envelope: string[] }

/** A reply's refusal shape (compile diagnostic code, failure or rpc error), or none. */
export function refusalOf(method: string, reply: any): unknown {
  if (reply?.error)
    return {
      rpc: [
        reply.error.code,
        reply.error.data?.reason,
        ...(reply.error.data?.code ? [reply.error.data.code] : []),
      ],
    }
  const r = reply?.result
  if (!r || r.ok !== false) return undefined
  if (method === 'aspc.compileHarnessInvocation') return { diagnostic: r.diagnostics?.[0]?.code }
  if (method === 'aspc.inspectAgent')
    return {
      diagnostics: r.diagnostics?.map((d: { severity: string; code: string }) => [
        d.severity,
        d.code,
      ]),
    }
  const body = method === 'aspc.inspectRuntimePlacement' ? r.declaration : r
  if (body?.failure) return { failure: [body.failure.kind, body.failure.code] }
  if (body?.resolution) return { resolution: [body.resolution.state, body.resolution.code] }
  return { refused: true }
}

export type Verdict = {
  id: string
  bun: 'success' | 'refusal'
  problems: string[]
  replyDiffs?: Difference[]
  treeDiffs?: Difference[]
}

/** Judge raspd's capture of one case against Bun's recorded one. */
export function compareNative(
  id: string,
  pc: ProbeCase,
  bunCapture: Capture & { params: unknown },
  raspdCapture: Capture & { params: unknown }
): Verdict {
  const problems: string[] = []
  let [bun, raspd] = [bunCapture, raspdCapture]
  const pick = (c: Capture) => c.replies.find((r: any) => r?.id === 2) ?? c.replies.at(-1)
  const bunRefusal = pc.rawFrames ? undefined : refusalOf(bun.method, pick(bun))
  if (bunRefusal !== undefined) {
    const got = refusalOf(raspd.method, pick(raspd))
    if (JSON.stringify(got) !== JSON.stringify(bunRefusal))
      problems.push(`Bun refused ${JSON.stringify(bunRefusal)}, raspd ${JSON.stringify(got)}`)
    return { id, bun: 'refusal', problems }
  }
  if (JSON.stringify(bun.params) !== JSON.stringify(raspd.params))
    problems.push('request differs from the recorded one (rerun record-bun.ts)')
  const entry = entryOf(id, pc, raspd.params, raspd.frames)
  if (JSON.stringify(bun.frames) !== JSON.stringify(raspd.frames))
    problems.push('frames differ from the recorded ones (rerun record-bun.ts)')
  // Raw frames on one connection are answered as each completes (Bun answers
  // a parse error before the hello ahead of it): compare them by id.
  const ordered = (c: Capture) =>
    entry.kind === 'raw'
      ? [...c.replies].sort((a: any, b: any) =>
          JSON.stringify(a?.id ?? null).localeCompare(JSON.stringify(b?.id ?? null))
        )
      : c.replies
  bun = { ...bun, replies: ordered(bun) }
  raspd = { ...raspd, replies: ordered(raspd) }
  const checkB = selfCheck(entry, bun.replies)
  const checkR = selfCheck(entry, raspd.replies)
  problems.push(...checkB.mismatches.map((m) => `bun self-check: ${m}`))
  problems.push(...checkR.mismatches.map((m) => `raspd self-check: ${m}`))
  problems.push(...bun.violations.map((m) => `bun fingerprint: ${m}`))
  problems.push(...raspd.violations.map((m) => `raspd fingerprint: ${m}`))
  const left = normalize(entry, bun.replies, checkB.verified)
  const right = normalize(entry, raspd.replies, checkR.verified)
  const discovery = takeRaspdDiscoveryDifferences(left, right)
  problems.push(...discovery.violations)
  const replyDiffs = diffMaps(left, right)
  const treeDiffs = diffMaps(new Map(Object.entries(bun.tree)), new Map(Object.entries(raspd.tree)))
  if (replyDiffs.length > 0) problems.push(`${replyDiffs.length} reply differences`)
  if (treeDiffs.length > 0) problems.push(`${treeDiffs.length} tree differences`)
  return {
    id,
    bun: 'success',
    problems,
    ...(replyDiffs.length > 0 ? { replyDiffs } : {}),
    ...(treeDiffs.length > 0 ? { treeDiffs } : {}),
  }
}

export function readBunCapture(id: string): (Capture & { params: unknown }) | undefined {
  const path = join(BUN_REPLIES, `${id}.json`)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}
