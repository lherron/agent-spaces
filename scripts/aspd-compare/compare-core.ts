/**
 * The compare runner's comparison (T-11833), shared by run.ts and the raspd
 * sole-mode table test (T-13048): per-subject self-checks of derived hashes
 * and codex runtime fingerprints, the measured volatile mask, stage tree
 * manifests and the reply diff. Nothing here masks a value it did not
 * measure or verify (volatile-mask.ts).
 */
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  utimesSync,
} from 'node:fs'
import { join, relative } from 'node:path'

import { CODEX_TUI_HOOK_EVENTS } from '../../compiler/agent-spaces/src/compile-broker-plan.ts'
import { derivePlanHashes } from '../../compiler/agent-spaces/src/compile-plan-finalize.ts'
import { deriveCodexRuntimeFingerprint } from '../../drivers/execution/src/run-codex.ts'
import type { CompareCase } from './cases.ts'
import { RESPONSE_MASK, TOKENS, TREE_MASK } from './volatile-mask.ts'

export type Reply = Record<string, unknown> | { unparsed: string }
export type TreeEntry = string

/** Whether measured volatile inputs are tokenized (run.ts --raw turns it off). */
export let masking = true
export function setMasking(on: boolean): void {
  masking = on
}

/**
 * A subject's derived fingerprints, in first-seen order. Their inputs include
 * the measured bundle staging dir, so the values move between runs of one
 * build; each is verified on its own side, then tokenized as
 * `«derived:<kind>#<n>»`. A codex runtime home's fingerprint is re-derived
 * from the compile that wrote it (T-11932, plan close condition 5); the muse
 * serve fingerprint is still checked for shape only (muse stays Bun's).
 */
export type Fingerprints = Map<string, string>

const MANAGED_KINDS = ['prompts', 'skills'] as const

type CodexPlan = {
  execution?: {
    recipeId?: string
    dispatchRequest?: {
      startRequest?: {
        spec?: { process?: { lockedEnv?: Record<string, string> }; interaction?: { mode?: string } }
      }
    }
  }
  artifacts?: { materializedBundleRoot?: string }
  placement?: { bundle?: { agentName?: string } }
  resolvedBundle?: { cwd?: string }
}

/**
 * Re-derive the runtime home fingerprint a codex-app-server compile reply
 * implies, with Bun's recipe; record it as derived or report the mismatch.
 */
export async function deriveCodexHome(replies: Reply[], derived: Set<string>): Promise<string[]> {
  const plan = (replies[1] as { result?: { plan?: CodexPlan } } | undefined)?.result?.plan
  if (plan?.execution?.recipeId !== 'codex-app-server') return []
  const spec = plan.execution.dispatchRequest?.startRequest?.spec
  const runtimeHome = spec?.process?.lockedEnv?.['CODEX_HOME']
  const bundleRoot = plan.artifacts?.materializedBundleRoot
  const targetName = plan.placement?.bundle?.agentName
  const cwd = plan.resolvedBundle?.cwd
  if ([runtimeHome, bundleRoot, targetName, cwd].some((value) => value === undefined)) {
    return ['codex compile reply lacks CODEX_HOME, bundle root, target or cwd']
  }
  const metadata = join(runtimeHome as string, '.asp-runtime.json')
  if (!existsSync(metadata)) return [`${runtimeHome}: no .asp-runtime.json`]
  const recorded = (JSON.parse(readFileSync(metadata, 'utf8')) as { fingerprint: string })
    .fingerprint
  const interactive = spec?.interaction?.mode === 'interactive'
  const fingerprint = await deriveCodexRuntimeFingerprint({
    runtimeHome: runtimeHome as string,
    bundleRoot: bundleRoot as string,
    targetName: targetName as string,
    cwd: cwd as string,
    interactive,
    codexHookEvents: interactive ? CODEX_TUI_HOOK_EVENTS : undefined,
  })
  if (fingerprint !== recorded) {
    return [`${runtimeHome}: .asp-runtime.json fingerprint ${recorded}, derived ${fingerprint}`]
  }
  derived.add(fingerprint)
  return []
}

/**
 * Register this capture's fingerprints; return violations: a codex home whose
 * fingerprint no compile re-derived, or whose managed links disagree with it.
 */
export function verifyFingerprints(
  root: string,
  registry: Fingerprints,
  derived: Set<string>
): string[] {
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
    if (!derived.has(fingerprint))
      violations.push(`${home}: fingerprint not re-derived by a compile`)
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
export function treeManifest(root: string, fingerprints: Fingerprints): Record<string, TreeEntry> {
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

export function restoreStage(seed: string, stage: string): void {
  rmSync(stage, { recursive: true, force: true })
  // Timestamps are seed state too (bundle-version pruning reads mtimes).
  cpSync(seed, stage, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
  copyDirectoryTimes(seed, stage)
}

/** cpSync preserves file times only; give each directory its source's times, children first. */
export function copyDirectoryTimes(from: string, to: string): void {
  for (const name of readdirSync(from)) {
    const source = join(from, name)
    if (lstatSync(source).isDirectory()) copyDirectoryTimes(source, join(to, name))
  }
  const { atime, mtime } = lstatSync(from)
  utimesSync(to, atime, mtime)
}

export type Difference = { path: string; a: unknown; b: unknown }

export const pathMatches = (pattern: string, path: string) =>
  new RegExp(`^${pattern.replace(/[.[\]]/g, '\\$&').replaceAll('*', '[^.\\[\\]]+')}$`).test(path)

export function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
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

export const DERIVED_HASH_FIELDS = [
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
export function selfCheck(
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
export function shape(entry: CompareCase, replies: Reply[]): unknown {
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
export function normalize(
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

export function diffMaps(a: Map<string, unknown>, b: Map<string, unknown>): Difference[] {
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort()
  return keys
    .filter((key) => JSON.stringify(a.get(key)) !== JSON.stringify(b.get(key)))
    .map((key) => ({ path: key, a: a.get(key), b: b.get(key) }))
}
