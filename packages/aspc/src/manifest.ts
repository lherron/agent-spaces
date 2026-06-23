/**
 * `aspc manifest` output-manifest builder (T-04133).
 *
 * Materializes a compile request under a throwaway/hermetic ASP_HOME WITHOUT
 * starting a harness or invoking an LLM, then enumerates the compiler-owned
 * runtime-home root into a canonical {@link OutputManifest}.
 *
 * Determinism: file digests are computed over NORMALIZED bytes (host roots,
 * `$HOME`, per-run staging segments and ISO-8601 timestamps replaced by stable
 * tokens), paths are home-relative, mtimes are never recorded, and ephemeral
 * lock files are excluded with an explicit reason. A fixed hermetic compile is
 * therefore byte-stable across machines and throwaway homes.
 */
import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { createAgentSpacesClient } from 'agent-spaces'
import type {
  CompileContext,
  OutputManifest,
  OutputManifestEntry,
  OutputManifestExclusion,
  RuntimeCompileRequest,
} from 'spaces-runtime-contracts'
import { OUTPUT_MANIFEST_SCHEMA_VERSION } from 'spaces-runtime-contracts'

export interface BuildOutputManifestInput {
  compileRequest: RuntimeCompileRequest
  aspHome: string
  compileContext?: CompileContext | undefined
}

export type BuildOutputManifestResult =
  | { ok: true; manifest: OutputManifest }
  | { ok: false; diagnostics: unknown }

/** Roots whose absolute form must be tokenized out of hashed bytes. */
interface NormalizationRoots {
  aspHome: string
  projectRoot: string | undefined
  agentRoot: string | undefined
  home: string | undefined
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Replace per-host / per-run material with stable tokens so the digest of a
 * materialized file does not move between machines or throwaway homes. Covers
 * absolute host roots (raw + macOS `/private` form), `$HOME`, the per-run
 * `.staging/bundle-…` segment (carries pid + uuid), ISO-8601 timestamps, and any
 * residual `/var/folders/…/T/…` temp base.
 */
function normalizeBytes(raw: string, roots: NormalizationRoots): string {
  let out = raw
  const rootTokens: Array<[string | undefined, string]> = [
    [roots.aspHome, '«ASP_HOME»'],
    [roots.projectRoot, '«PROJECT_ROOT»'],
    [roots.agentRoot, '«AGENT_ROOT»'],
    [roots.home, '«HOME»'],
  ]
  for (const [root, token] of rootTokens) {
    if (root === undefined || root.length === 0) continue
    for (const form of new Set([root, `/private${root}`])) {
      out = out.replace(new RegExp(escapeRegExp(form), 'g'), token)
    }
  }
  out = out.replace(/\.staging\/bundle-[^/"'\s]+/g, '.staging/«BUNDLE»')
  out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '«TS»')
  out = out.replace(/(?:\/private)?\/var\/folders\/[A-Za-z0-9._/-]*?\/T\/[A-Za-z0-9._-]+/g, '«TMP»')
  // Derived content digests (runtime-home fingerprint, hook trusted_hash, bundle
  // identity, env hashes) are themselves functions of host/home paths, so their
  // VALUE moves between throwaway homes even after the paths above are tokenized.
  // They are mechanics material, not content: normalize them to a stable token.
  out = out.replace(/[0-9a-f]{32,64}/g, '«HASH»')
  return out
}

function octalMode(mode: number): string {
  return (mode & 0o777).toString(8)
}

function isExcludedLock(relPath: string): boolean {
  return relPath.endsWith('.lock')
}

/** Recursively collect file/symlink paths under `root` (sorted, deterministic). */
function walkOwnedRoot(root: string): string[] {
  const out: string[] = []
  const recurse = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of [...entries].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    )) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        out.push(full)
      } else if (entry.isDirectory()) {
        recurse(full)
      } else if (entry.isFile()) {
        out.push(full)
      }
    }
  }
  recurse(root)
  return out
}

function toEntry(
  fullPath: string,
  aspHome: string,
  roots: NormalizationRoots
): OutputManifestEntry {
  const relPath = relative(aspHome, fullPath).split(sep).join('/')
  const stat = lstatSync(fullPath)
  if (stat.isSymbolicLink()) {
    const target = normalizeBytes(readlinkSync(fullPath), roots)
    return {
      path: relPath,
      kind: 'symlink',
      size: 0,
      sha256: sha256Hex(`symlink:${target}`),
      mode: octalMode(stat.mode),
    }
  }
  const normalized = normalizeBytes(readFileSync(fullPath, 'utf8'), roots)
  return {
    path: relPath,
    kind: 'file',
    size: Buffer.byteLength(normalized, 'utf8'),
    sha256: sha256Hex(normalized),
    mode: octalMode(stat.mode),
  }
}

/**
 * Compile + materialize the request under `aspHome` and project the
 * compiler-owned runtime-home root into a canonical output manifest. No harness
 * is started and no LLM is invoked — `compileRuntimePlan` materializes only.
 */
export async function buildOutputManifest(
  input: BuildOutputManifestInput
): Promise<BuildOutputManifestResult> {
  const client = createAgentSpacesClient({ aspHome: input.aspHome })
  const response = await client.compileRuntimePlan(
    input.compileRequest,
    input.compileContext !== undefined ? { compileContext: input.compileContext } : undefined
  )
  if (!response.ok) {
    return { ok: false, diagnostics: response.diagnostics }
  }

  const placement = input.compileRequest.placement as {
    projectRoot?: string | undefined
    agentRoot?: string | undefined
  }
  const roots: NormalizationRoots = {
    aspHome: input.aspHome,
    projectRoot: placement.projectRoot,
    agentRoot: placement.agentRoot,
    home: process.env['HOME'],
  }

  const ownedRoot = join(input.aspHome, 'codex-homes')
  const entries: OutputManifestEntry[] = []
  const exclusions: OutputManifestExclusion[] = []
  for (const fullPath of walkOwnedRoot(ownedRoot)) {
    const relPath = relative(input.aspHome, fullPath).split(sep).join('/')
    if (isExcludedLock(relPath)) {
      exclusions.push({ path: relPath, reason: 'ephemeral-lock' })
      continue
    }
    entries.push(toEntry(fullPath, input.aspHome, roots))
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  exclusions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const toolchainManifestHash =
    input.compileContext?.toolchainManifest !== undefined
      ? sha256Hex(canonicalJson(input.compileContext.toolchainManifest))
      : undefined

  const outputManifestHash = sha256Hex(canonicalJson({ entries, toolchainManifestHash }))

  const manifest: OutputManifest = {
    schemaVersion: OUTPUT_MANIFEST_SCHEMA_VERSION,
    outputManifestHash,
    startedHarness: false,
    ...(toolchainManifestHash !== undefined ? { toolchainManifestHash } : {}),
    entries,
    exclusions,
  }
  return { ok: true, manifest }
}

/** Stable JSON with sorted object keys, for content-addressing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}
