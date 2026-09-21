/**
 * `aspc manifest` output-manifest builder (T-04133).
 *
 * Materializes a compile request under a throwaway/hermetic ASP_HOME WITHOUT
 * starting a harness or invoking an LLM, then enumerates compiler-owned output
 * into a canonical {@link OutputManifest}.
 *
 * Mode A computes digests over normalized bytes for cross-host self-stability.
 * Mode B computes digests and sizes over literal emitted bytes for same-host,
 * cross-implementation cutover evidence. Paths remain ASP_HOME-relative in both.
 */
import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import type {
  CompileContext,
  OutputManifest,
  OutputManifestEntry,
  OutputManifestExclusion,
  OutputManifestExclusionReason,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import { OUTPUT_MANIFEST_SCHEMA_VERSION, createCanonicalHasher } from 'spaces-runtime-contracts'

export interface BuildOutputManifestInput {
  compileRequest: RuntimeCompileRequest
  aspHome: string
  mode: 'A' | 'B'
  compileContext?: CompileContext | undefined
}

/** The compile capability supplied by the CLI/application composition root. */
export interface OutputManifestCompiler {
  compileRuntimePlan(
    request: RuntimeCompileRequest,
    options?: { compileContext?: CompileContext | undefined }
  ): Promise<RuntimeCompileResponse>
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

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
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

interface DeclaredOutputExclusion {
  matcher:
    | { kind: 'exact-path'; path: string }
    | { kind: 'exact-filename'; filename: string }
    | { kind: 'bundle-scope-lock' }
  reason: OutputManifestExclusionReason
}

/**
 * Audited, exact exclusions. Adding an emitted path here is an explicit bless
 * operation; broad suffix/glob matchers are intentionally forbidden.
 */
const DECLARED_OUTPUT_EXCLUSIONS: readonly DeclaredOutputExclusion[] = [
  {
    matcher: { kind: 'exact-filename', filename: '.asp-runtime.lock' },
    reason: 'ephemeral-lock',
  },
  {
    matcher: { kind: 'exact-path', path: 'codex-homes/locks/runtime.lock' },
    reason: 'ephemeral-lock',
  },
  {
    matcher: { kind: 'bundle-scope-lock' },
    reason: 'ephemeral-lock',
  },
]

function declaredExclusion(relPath: string): DeclaredOutputExclusion | undefined {
  const filename = relPath.split('/').at(-1)
  return DECLARED_OUTPUT_EXCLUSIONS.find((declaration) => {
    if (declaration.matcher.kind === 'exact-path') {
      return declaration.matcher.path === relPath
    }
    if (declaration.matcher.kind === 'exact-filename') {
      return declaration.matcher.filename === filename
    }
    return (
      relPath.startsWith('tmp/locks/') && /^bundle-scope-[0-9a-f]{32}\.lock$/.test(filename ?? '')
    )
  })
}

/** Recursively collect file/symlink paths under ASP_HOME (sorted, deterministic). */
function walkAspHome(root: string): string[] {
  const out: string[] = []
  const recurse = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`manifest walk failed at ${dir}: ${detail}`, { cause: error })
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
  roots: NormalizationRoots,
  mode: 'A' | 'B'
): OutputManifestEntry {
  const relPath = relative(aspHome, fullPath).split(sep).join('/')
  const stat = lstatSync(fullPath)
  if (stat.isSymbolicLink()) {
    const rawTarget = readlinkSync(fullPath, { encoding: 'buffer' })
    const hashMaterial =
      mode === 'A'
        ? Buffer.from(`symlink:${normalizeBytes(rawTarget.toString('utf8'), roots)}`, 'utf8')
        : Buffer.concat([Buffer.from('symlink:', 'utf8'), rawTarget])
    return {
      path: relPath,
      kind: 'symlink',
      size: 0,
      sha256: sha256Hex(hashMaterial),
      mode: octalMode(stat.mode),
    }
  }
  const raw = readFileSync(fullPath)
  const hashMaterial =
    mode === 'A' ? Buffer.from(normalizeBytes(raw.toString('utf8'), roots), 'utf8') : raw
  return {
    path: relPath,
    kind: 'file',
    size: hashMaterial.byteLength,
    sha256: sha256Hex(hashMaterial),
    mode: octalMode(stat.mode),
  }
}

/**
 * Compile + materialize the request under `aspHome` and project the selected
 * evidence root into a canonical output manifest. No harness is started and no
 * LLM is invoked — `compileRuntimePlan` materializes only.
 */
export async function buildOutputManifest(
  input: BuildOutputManifestInput,
  compiler: OutputManifestCompiler
): Promise<BuildOutputManifestResult> {
  const response = await compiler.compileRuntimePlan(
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

  const entries: OutputManifestEntry[] = []
  const exclusions: OutputManifestExclusion[] = []
  const walkRoot = input.mode === 'A' ? join(input.aspHome, 'codex-homes') : input.aspHome
  for (const fullPath of walkAspHome(walkRoot)) {
    const relPath = relative(input.aspHome, fullPath).split(sep).join('/')
    const exclusion = declaredExclusion(relPath)
    if (exclusion !== undefined) {
      exclusions.push({ path: relPath, reason: exclusion.reason })
      continue
    }
    if (relPath.endsWith('.lock')) {
      throw new Error(
        `manifest: ${relPath} is an ephemeral lock without a committed declared exclusion`
      )
    }
    entries.push(toEntry(fullPath, input.aspHome, roots, input.mode))
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  exclusions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const toolchainManifestHash =
    input.compileContext?.toolchainManifest !== undefined
      ? sha256Hex(canonicalJson(input.compileContext.toolchainManifest))
      : undefined

  const outputManifestHash = sha256Hex(
    canonicalJson({ mode: input.mode, entries, toolchainManifestHash })
  )

  const manifest: OutputManifest = {
    schemaVersion: OUTPUT_MANIFEST_SCHEMA_VERSION,
    mode: input.mode,
    outputManifestHash,
    startedHarness: false,
    ...(toolchainManifestHash !== undefined ? { toolchainManifestHash } : {}),
    entries,
    exclusions,
  }
  return { ok: true, manifest }
}

const canonicalHasher = createCanonicalHasher()

/**
 * Stable JSON with sorted object keys, for content-addressing.
 *
 * Thin delegate over the single shared canonical-JSON implementation in
 * spaces-runtime-contracts; kept exported because verify-release and the
 * reproducible-compiler gate hash against the same bytes.
 */
export function canonicalJson(value: unknown): string {
  return canonicalHasher.canonicalize(value)
}
