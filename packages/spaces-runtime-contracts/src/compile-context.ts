/**
 * Serializable compile context (T-04133).
 *
 * A compile context lets a release gate or a reproducibility test pin the
 * non-deterministic inputs the compiler would otherwise read from the ambient
 * host — the wall clock and any id salt — and declare the toolchain the outputs
 * are pinned against. Production callers OMIT it: when absent, the compiler
 * falls back to real time and unsalted derivation exactly as before.
 *
 * The shape is intentionally tiny and JSON-serializable so it can ride on the
 * `aspc.compileRuntimePlan` / `aspc.compileHarnessInvocation` wire requests, the
 * `aspc manifest` CLI, and the `verify-release` gate without a bespoke codec.
 */
export interface CompileToolchainManifest {
  /** Contract version of this toolchain manifest payload. */
  schemaVersion: string
  /** Pinned tool name/version pairs (compiler, harness binaries, etc.). */
  tools?: ReadonlyArray<{ name: string; version: string }> | undefined
  /** Pinned model catalog snapshot, keyed by provider. */
  modelCatalog?: Record<string, unknown> | undefined
}

export interface CompileContext {
  /**
   * Pinned wall-clock instant (ISO-8601) the compiler stamps into `createdAt`.
   * Omit in production to stamp real time.
   */
  nowIso?: string | undefined
  /**
   * Optional salt folded into derived optional ids (e.g. the omitted
   * `initialInputId`). Lets two otherwise-identical corpora derive distinct ids
   * without an RNG. Omit in production.
   */
  idSalt?: string | undefined
  /** Toolchain the compile outputs are pinned against, for provenance/diffing. */
  toolchainManifest?: CompileToolchainManifest | undefined
}
