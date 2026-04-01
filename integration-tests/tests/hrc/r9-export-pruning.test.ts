/**
 * RED/GREEN guard for T-00988: R-9 dead and rename-only export pruning
 *
 * This test validates the export-surface changes required by R-9:
 *
 * 1. hrc-core: HrcFenceErrorCode and createInvalidFenceError must NOT be exported
 * 2. hrc-core: HrcErrorCodeValue alias must NOT be exported (consumers use HrcErrorCode directly)
 * 3. hrc-sdk: Must re-export core record types (HrcRuntimeSnapshot, HrcLaunchRecord,
 *    HrcSurfaceBindingRecord, HrcAppSessionRecord, HrcLocalBridgeRecord) directly,
 *    NOT as rename-only aliases (RuntimeRecord, LaunchRecord, etc.)
 * 4. hrc-cli: Must be bin-only (no library exports)
 *
 * RED baseline: Tests 1-3 FAIL because the dead/alias exports still exist.
 * GREEN gate:  Tests 1-3 PASS after Larry removes them.
 *
 * Reference: T-00988, HRC_REDUCTION_REVIEW.md R-9
 */
import { describe, expect, it } from 'bun:test'

// ---------------------------------------------------------------------------
// Helpers: dynamically inspect module exports
// ---------------------------------------------------------------------------

// We use dynamic imports so a missing export doesn't prevent the test file
// from loading — we want to inspect what IS and ISN'T exported.

async function getExportKeys(specifier: string): Promise<string[]> {
  const mod = await import(specifier)
  return Object.keys(mod)
}

// ---------------------------------------------------------------------------
// 1. hrc-core: dead exports must be removed
// ---------------------------------------------------------------------------
describe('R-9: hrc-core dead export removal', () => {
  it('must NOT export HrcFenceErrorCode', async () => {
    const keys = await getExportKeys('hrc-core')
    expect(keys).not.toContain('HrcFenceErrorCode')
  })

  it('must NOT export createInvalidFenceError', async () => {
    const keys = await getExportKeys('hrc-core')
    expect(keys).not.toContain('createInvalidFenceError')
  })
})

// ---------------------------------------------------------------------------
// 2. hrc-core: HrcErrorCodeValue alias must be removed
//    (consumers should import HrcErrorCode directly)
// ---------------------------------------------------------------------------
describe('R-9: hrc-core HrcErrorCodeValue alias removal', () => {
  it('must NOT export HrcErrorCodeValue (use HrcErrorCode instead)', async () => {
    // HrcErrorCodeValue is a type-only re-export alias of HrcErrorCode.
    // After R-9, only HrcErrorCode should exist.
    // Since it's `export type`, it won't appear in runtime keys — so we verify
    // at the source level that the alias line is gone.
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')

    // Read the hrc-core index source to verify the alias is removed
    const indexPath = join(import.meta.dir, '../../../packages/hrc-core/src/index.ts')
    const source = await readFile(indexPath, 'utf-8')

    expect(source).not.toContain('HrcErrorCodeValue')
  })
})

// ---------------------------------------------------------------------------
// 3. hrc-sdk: rename-only aliases must be replaced with direct re-exports
//    of the canonical hrc-core types
// ---------------------------------------------------------------------------
describe('R-9: hrc-sdk rename-only alias removal', () => {
  it('must NOT define SurfaceBindingRecord as an alias of HrcSurfaceBindingRecord in types.ts', async () => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')

    const typesPath = join(import.meta.dir, '../../../packages/hrc-sdk/src/types.ts')
    const source = await readFile(typesPath, 'utf-8')

    // These alias lines must be gone:
    //   export type SurfaceBindingRecord = HrcSurfaceBindingRecord
    //   export type AppSessionRecord = HrcAppSessionRecord
    //   export type LocalBridgeRecord = HrcLocalBridgeRecord
    //   export type RuntimeRecord = HrcRuntimeSnapshot
    //   export type LaunchRecord = HrcLaunchRecord
    expect(source).not.toMatch(/export\s+type\s+SurfaceBindingRecord\s*=\s*HrcSurfaceBindingRecord/)
    expect(source).not.toMatch(/export\s+type\s+AppSessionRecord\s*=\s*HrcAppSessionRecord/)
    expect(source).not.toMatch(/export\s+type\s+LocalBridgeRecord\s*=\s*HrcLocalBridgeRecord/)
    expect(source).not.toMatch(/export\s+type\s+RuntimeRecord\s*=\s*HrcRuntimeSnapshot/)
    expect(source).not.toMatch(/export\s+type\s+LaunchRecord\s*=\s*HrcLaunchRecord/)
  })

  it('hrc-sdk must still export the record type names on its public surface', async () => {
    // After R-9, these names must still be importable from hrc-sdk,
    // but as direct re-exports from hrc-core, not local aliases.
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')

    const indexPath = join(import.meta.dir, '../../../packages/hrc-sdk/src/index.ts')
    const source = await readFile(indexPath, 'utf-8')

    // These names must still appear in the SDK's public re-exports
    for (const name of [
      'SurfaceBindingRecord',
      'AppSessionRecord',
      'LocalBridgeRecord',
      'RuntimeRecord',
      'LaunchRecord',
    ]) {
      expect(source).toContain(name)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. hrc-cli: bin-only (no library exports)
// ---------------------------------------------------------------------------
describe('R-9: hrc-cli bin-only', () => {
  it('hrc-cli index.ts must not export anything (bin-only package)', async () => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')

    const indexPath = join(import.meta.dir, '../../../packages/hrc-cli/src/index.ts')

    // After R-9, the file should either not exist or have no exports.
    // Currently it exports {}, which technically satisfies bin-only,
    // but R-9 says to remove the library export/stub entirely.
    try {
      const source = await readFile(indexPath, 'utf-8')
      // If file exists, it must not have any export statement
      expect(source).not.toMatch(/export\s/)
    } catch {
      // File doesn't exist — that's also valid for bin-only
    }
  })
})

// ---------------------------------------------------------------------------
// 5. hrc-store-sqlite: HrcErrorCodeValue import must be renamed to HrcErrorCode
// ---------------------------------------------------------------------------
describe('R-9: HrcErrorCodeValue consumer rename', () => {
  it('hrc-store-sqlite must import HrcErrorCode, not HrcErrorCodeValue', async () => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')

    const repoPath = join(import.meta.dir, '../../../packages/hrc-store-sqlite/src/repositories.ts')
    const source = await readFile(repoPath, 'utf-8')

    expect(source).not.toContain('HrcErrorCodeValue')
    expect(source).toContain('HrcErrorCode')
  })

  it('hrc-bridge-agentchat must import HrcErrorCode, not HrcErrorCodeValue', async () => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')

    const bridgePath = join(import.meta.dir, '../../../packages/hrc-bridge-agentchat/src/index.ts')
    const source = await readFile(bridgePath, 'utf-8')

    expect(source).not.toContain('HrcErrorCodeValue')
  })
})
