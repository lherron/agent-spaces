/**
 * INTERNAL LEGACY harness selection catalog — frozen, do not extend.
 *
 * This module retains the single pre-T-08701 config-owned routing catalog
 * (aliases, provider/transport/frontend mappings, harness defaults) for old
 * v1 consumers that T-08702 has not migrated yet. It is explicitly NOT part
 * of the public config surface: it is not re-exported through the
 * spaces-config root, and every import must be a deep internal import marked
 * for deletion with T-08702.
 *
 * Rules for this file (EN-15986):
 * - byte-identical to the pre-cutover identification block; no fixes,
 *   no renames, no new defaults, no new callers beyond the ones that
 *   already depended on it;
 * - new code (profiles, directives, merge, declaration, resolver) must use
 *   the closed vocabulary in `./harness.js` and the central compiler
 *   catalog instead;
 * - T-08702 deletes this module with the last v1 consumer.
 */

// ============================================================================
// Harness Identification
// ============================================================================

/** Supported harness identifiers */
export type HarnessId =
  | 'agent-harness'
  | 'claude'
  | 'claude-agent-sdk'
  | 'pi'
  | 'pi-sdk'
  | 'codex'
  | 'muse'

/** Provider family for a harness. */
export type HarnessProvider = 'anthropic' | 'openai' | 'meta'

/** Provider-facing frontend identifier used by placement/runtime APIs. */
export type HarnessFrontend =
  | 'agent-sdk'
  | 'agent-harness-tui'
  | 'pi-sdk'
  | 'claude-code'
  | 'codex-cli'
  | 'pi-cli'
  | 'muse-cli'

/** Runtime transport family for a harness. */
export type HarnessTransport = 'cli' | 'sdk'

/** Canonical metadata for a harness variant. */
export interface HarnessCatalogEntry {
  id: HarnessId
  aliases: readonly string[]
  provider: HarnessProvider
  transport: HarnessTransport
  frontend?: HarnessFrontend | undefined
}

/** All known harness IDs */
export const HARNESS_IDS: readonly HarnessId[] = [
  'agent-harness',
  'claude',
  'claude-agent-sdk',
  'pi',
  'pi-sdk',
  'codex',
  'muse',
] as const

/** Frontends that can be used via placement/runtime APIs. */
export const HARNESS_FRONTENDS: readonly HarnessFrontend[] = [
  'agent-sdk',
  'agent-harness-tui',
  'pi-sdk',
  'claude-code',
  'codex-cli',
  'pi-cli',
  'muse-cli',
] as const

/** Known provider families. */
export const HARNESS_PROVIDERS: readonly HarnessProvider[] = [
  'anthropic',
  'openai',
  'meta',
] as const

/** Canonical harness metadata shared across config, runtime, and CLIs. */
export const HARNESS_CATALOG: readonly HarnessCatalogEntry[] = [
  {
    id: 'agent-harness',
    aliases: [],
    provider: 'openai',
    transport: 'sdk',
    frontend: 'agent-harness-tui',
  },
  {
    id: 'claude',
    aliases: ['claude-code'],
    provider: 'anthropic',
    transport: 'cli',
    frontend: 'claude-code',
  },
  {
    id: 'claude-agent-sdk',
    aliases: ['agent-sdk'],
    provider: 'anthropic',
    transport: 'sdk',
    frontend: 'agent-sdk',
  },
  {
    id: 'pi',
    aliases: ['pi-cli'],
    provider: 'openai',
    transport: 'cli',
    frontend: 'pi-cli',
  },
  {
    id: 'pi-sdk',
    aliases: [],
    provider: 'openai',
    transport: 'sdk',
    frontend: 'pi-sdk',
  },
  {
    id: 'codex',
    aliases: ['codex-cli'],
    provider: 'openai',
    transport: 'cli',
    frontend: 'codex-cli',
  },
  {
    id: 'muse',
    aliases: ['muse-cli'],
    provider: 'meta',
    transport: 'cli',
    frontend: 'muse-cli',
  },
] as const

const HARNESS_CATALOG_BY_ID = new Map<HarnessId, HarnessCatalogEntry>(
  HARNESS_CATALOG.map((entry) => [entry.id, entry])
)
const HARNESS_CATALOG_BY_FRONTEND = new Map<HarnessFrontend, HarnessCatalogEntry>(
  HARNESS_CATALOG.flatMap((entry) => (entry.frontend ? [[entry.frontend, entry]] : []))
)
const HARNESS_CATALOG_BY_NAME = new Map<string, HarnessCatalogEntry>()

for (const entry of HARNESS_CATALOG) {
  HARNESS_CATALOG_BY_NAME.set(entry.id, entry)
  for (const alias of entry.aliases) {
    HARNESS_CATALOG_BY_NAME.set(alias, entry)
  }
  if (entry.frontend) {
    HARNESS_CATALOG_BY_NAME.set(entry.frontend, entry)
  }
}

/** All accepted harness names, including internal ids, aliases, and frontends. */
export const HARNESS_NAMES: readonly string[] = [...HARNESS_CATALOG_BY_NAME.keys()]

/** Type guard for HarnessId */
export function isHarnessId(value: string): value is HarnessId {
  return HARNESS_IDS.includes(value as HarnessId)
}

/** Return the catalog entry for an internal harness id. */
export function getHarnessCatalogEntry(id: HarnessId): HarnessCatalogEntry {
  const entry = HARNESS_CATALOG_BY_ID.get(id)
  if (!entry) {
    throw new Error(`Unknown harness id "${id}"`)
  }
  return entry
}

/** Return the catalog entry for a placement/runtime frontend. */
export function getHarnessCatalogEntryByFrontend(
  frontend: HarnessFrontend
): HarnessCatalogEntry | undefined {
  return HARNESS_CATALOG_BY_FRONTEND.get(frontend)
}

/** Resolve a harness name, alias, or frontend to its canonical catalog entry. */
export function resolveHarnessCatalogEntry(
  value: string | undefined
): HarnessCatalogEntry | undefined {
  if (!value) return undefined
  return HARNESS_CATALOG_BY_NAME.get(value)
}

/** Normalize any accepted harness name to its internal harness id. */
export function normalizeHarnessId(value: string | undefined): HarnessId | undefined {
  return resolveHarnessCatalogEntry(value)?.id
}

/** Normalize any accepted harness name to its placement/runtime frontend. */
export function normalizeHarnessFrontend(value: string | undefined): HarnessFrontend | undefined {
  return resolveHarnessCatalogEntry(value)?.frontend
}

/** Resolve the provider family for any accepted harness name. */
export function resolveHarnessProvider(value: string | undefined): HarnessProvider | undefined {
  return resolveHarnessCatalogEntry(value)?.provider
}

/** Resolve the preferred placement/runtime frontend for a provider/transport pair. */
export function resolveHarnessFrontendForProvider(
  provider: HarnessProvider,
  transport: HarnessTransport
): HarnessFrontend | undefined {
  if (provider === 'openai' && transport === 'sdk') {
    return getHarnessCatalogEntry('pi-sdk').frontend
  }
  return HARNESS_CATALOG.find(
    (entry) => entry.provider === provider && entry.transport === transport && entry.frontend
  )?.frontend
}

/** List all placement/runtime frontends available for a provider family. */
export function getHarnessFrontendsForProvider(provider: HarnessProvider): HarnessFrontend[] {
  return HARNESS_CATALOG.filter((entry) => entry.provider === provider && entry.frontend).map(
    (entry) => entry.frontend as HarnessFrontend
  )
}

/** Check if a space supports a harness (including alias compatibility) */
export function isHarnessSupported(
  supports: HarnessId[] | undefined,
  harnessId: HarnessId
): boolean {
  if (!supports) return true
  if (supports.includes(harnessId)) return true
  if (harnessId === 'claude-agent-sdk') return supports.includes('claude')
  if (harnessId === 'agent-harness') return supports.includes('pi') || supports.includes('pi-sdk')
  if (harnessId === 'pi-sdk') return supports.includes('pi')
  return false
}

/** Default harness when none specified */
export const DEFAULT_HARNESS: HarnessId = 'claude'

/**
 * Harnesses for which lock generation emits a per-harness env-hash entry.
 *
 * Single source of truth for the lock-file harness enumeration (consumed by
 * `resolver/lock-generator.ts`). Currently only the default harness is
 * recorded; widening this list (e.g. to add per-harness env hashes for
 * `codex`/`pi`) is the one place to edit rather than a constant inlined in the
 * generator.
 */
export const LOCK_HARNESSES: readonly HarnessId[] = [DEFAULT_HARNESS] as const
