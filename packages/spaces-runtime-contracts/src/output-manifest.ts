/**
 * Output manifest contracts (T-04133).
 *
 * The output manifest is the enumerable, canonical record of every file a
 * compile materialized — the compiler's "object file" listing. It is produced by
 * `aspc manifest` without starting a harness and is the byte-level comparand of
 * the `verify-release` gate.
 *
 * Canonicalization policy (so a fixed hermetic compile is byte-stable across
 * machines and throwaway homes):
 *  - Paths are normalized to be relative to the runtime-home root; no absolute
 *    host prefix, no `$HOME`, no project root leaks into a path.
 *  - File digests are computed over NORMALIZED bytes: absolute host roots,
 *    `$HOME`, per-run staging segments, and ISO-8601 timestamps are replaced by
 *    stable tokens before hashing, so generated timestamps and host paths do not
 *    move the digest.
 *  - mtimes are never recorded.
 *  - Ephemeral lock files and other intrinsically per-run artifacts are excluded
 *    with an explicit, machine-readable reason rather than silently dropped.
 */

export type OutputManifestEntryKind = 'file' | 'symlink'

/** Why an owned-root path was deliberately left out of the manifest entries. */
export type OutputManifestExclusionReason = 'ephemeral-lock' | 'ephemeral-tmp'

export interface OutputManifestEntry {
  /** Normalized, home-relative path. Stable across throwaway homes. */
  path: string
  kind: OutputManifestEntryKind
  /** Byte length of the file (0 for symlinks). */
  size: number
  /** sha256 (hex) over the NORMALIZED bytes / normalized symlink target. */
  sha256: string
  /** Octal permission bits as a string, e.g. "644" / "755". */
  mode: string
}

export interface OutputManifestExclusion {
  path: string
  reason: OutputManifestExclusionReason
}

export const OUTPUT_MANIFEST_SCHEMA_VERSION = 'agent-output-manifest/v1' as const

export interface OutputManifest {
  schemaVersion: typeof OUTPUT_MANIFEST_SCHEMA_VERSION
  /** sha256 (hex) over the canonical projection of {@link entries}. */
  outputManifestHash: string
  /** Always false: `aspc manifest` materializes but never starts a harness. */
  startedHarness: false
  /** sha256 (hex) of the pinned toolchain manifest, when one was supplied. */
  toolchainManifestHash?: string | undefined
  /** Sorted, canonical file/symlink entries. */
  entries: OutputManifestEntry[]
  /** Owned-root paths deliberately excluded, with reasons. */
  exclusions: OutputManifestExclusion[]
}
