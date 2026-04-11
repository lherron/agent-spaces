/**
 * RED/GREEN gate for T-00990: HRC Reduction Run 3 Phase B (R-3, R-7)
 *
 * Phase B deduplicates wire types and narrows store exports:
 *   R-3: Move shared HTTP request/response DTOs into hrc-core so both
 *        hrc-server and hrc-sdk import from one canonical source.
 *   R-7: Narrow hrc-store-sqlite root exports to only openHrcDatabase
 *        and HrcDatabase (the cross-package production surface).
 *
 * These tests FAIL (RED) before Curly's work because:
 *   - hrc-core does not yet export the shared wire DTOs
 *   - hrc-server still defines DTOs locally instead of importing from hrc-core
 *   - hrc-store-sqlite still exports repository classes and migration helpers
 *
 * Pass conditions (Smokey -> Curly):
 *   D-1: hrc-core must export the shared HTTP wire DTO type names
 *   D-2: hrc-server/src/index.ts must NOT locally define the shared DTOs
 *         (must import them from hrc-core or a relative module that re-exports hrc-core)
 *   D-3: hrc-sdk/src/types.ts must NOT locally define the shared DTOs
 *         (must import them from hrc-core)
 *   D-4: Full E2E server stack still works after deduplication
 *   N-1: hrc-store-sqlite root must NOT export repository classes
 *   N-2: hrc-store-sqlite root must NOT export migration helpers
 *         (createHrcDatabase, phase1Migrations, listAppliedMigrations, runMigrations)
 *   N-3: hrc-store-sqlite root must only export openHrcDatabase and HrcDatabase
 *   N-4: hrc-store-sqlite package tests must still pass via internal imports
 *
 * Reference: T-00990, HRC_REDUCTION_REVIEW.md R-3/R-7
 */
import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const PACKAGES = join(REPO_ROOT, 'packages')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getExportKeys(specifier: string): Promise<string[]> {
  const mod = await import(specifier)
  return Object.keys(mod)
}

async function readSource(packagePath: string): Promise<string> {
  return readFile(join(PACKAGES, packagePath), 'utf-8')
}

// The shared HTTP wire DTOs that R-3 must deduplicate. These exist today
// in both hrc-server/src/index.ts (as local types) and hrc-sdk/src/types.ts
// (as exported types). After R-3 they must live in hrc-core.
const SHARED_WIRE_DTOS = [
  'ResolveSessionRequest',
  'ResolveSessionResponse',
  'EnsureRuntimeRequest',
  'EnsureRuntimeResponse',
  'DispatchTurnRequest',
  'DispatchTurnResponse',
  'ClearContextRequest',
  'ClearContextResponse',
  'CaptureResponse',
  'RuntimeActionResponse',
  'BindSurfaceRequest',
  'UnbindSurfaceRequest',
  'RegisterBridgeTargetRequest',
  'RegisterBridgeTargetResponse',
  'DeliverBridgeRequest',
  'DeliverBridgeResponse',
  'CloseBridgeRequest',
]

// Repository classes that R-7 must remove from the public root export
const REPOSITORY_CLASSES = [
  'AppSessionRepository',
  'ContinuityRepository',
  'EventRepository',
  'LaunchRepository',
  'LocalBridgeRepository',
  'RunRepository',
  'RuntimeBufferRepository',
  'RuntimeRepository',
  'SessionRepository',
  'SurfaceBindingRepository',
]

// Migration helpers that R-7 must remove from the public root export
const MIGRATION_EXPORTS = [
  'createHrcDatabase',
  'phase1Migrations',
  'listAppliedMigrations',
  'runMigrations',
]

// ===========================================================================
// R-3: Deduplicate server/SDK wire DTOs into hrc-core
// ===========================================================================

describe('R-3: shared wire DTOs live in hrc-core', () => {
  it('D-1: hrc-core/src/index.ts exports or re-exports the shared DTO names', async () => {
    const coreIndex = await readSource('hrc-core/src/index.ts')
    // Each shared DTO name must appear in the hrc-core index
    // (either as a direct export or re-export from a submodule)
    for (const dto of SHARED_WIRE_DTOS) {
      expect(coreIndex).toContain(dto)
    }
  })
})

describe('R-3: hrc-server does not locally define shared DTOs', () => {
  it('D-2: hrc-server/src/index.ts must not have local type definitions for shared DTOs', async () => {
    const serverIndex = await readSource('hrc-server/src/index.ts')
    // Each shared DTO must NOT be defined as a local `type X = {` in the server.
    // It's fine if the server imports them (from hrc-core or relative path).
    for (const dto of SHARED_WIRE_DTOS) {
      const localDefPattern = new RegExp(`^type\\s+${dto}\\s*=`, 'm')
      expect(serverIndex).not.toMatch(localDefPattern)
    }
  })
})

describe('R-3: hrc-sdk does not locally define shared DTOs', () => {
  it('D-3: hrc-sdk/src/types.ts must not have local type definitions for shared DTOs', async () => {
    const sdkTypes = await readSource('hrc-sdk/src/types.ts')
    for (const dto of SHARED_WIRE_DTOS) {
      const localDefPattern = new RegExp(`^export\\s+type\\s+${dto}\\s*=`, 'm')
      expect(sdkTypes).not.toMatch(localDefPattern)
    }
  })
})

describe('R-3: E2E server stack still works after DTO deduplication', () => {
  it('D-4: createHrcServer + HrcClient session resolve still works', async () => {
    const { createHrcServer } = await import('hrc-server')
    const { HrcClient } = await import('hrc-sdk')
    const { mkdtemp, mkdir, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join: pathJoin } = await import('node:path')

    const tmpDir = await mkdtemp(pathJoin(tmpdir(), 'hrc-run3b-'))
    const runtimeRoot = pathJoin(tmpDir, 'runtime')
    const stateRoot = pathJoin(tmpDir, 'state')
    const socketPath = pathJoin(runtimeRoot, 'hrc.sock')
    const lockPath = pathJoin(runtimeRoot, 'server.lock')
    const spoolDir = pathJoin(runtimeRoot, 'spool')
    const dbPath = pathJoin(stateRoot, 'state.sqlite')

    await mkdir(runtimeRoot, { recursive: true })
    await mkdir(stateRoot, { recursive: true })
    await mkdir(spoolDir, { recursive: true })

    let server: Awaited<ReturnType<typeof createHrcServer>> | null = null
    try {
      server = await createHrcServer({
        runtimeRoot,
        stateRoot,
        socketPath,
        lockPath,
        spoolDir,
        dbPath,
      })
      const client = new HrcClient(socketPath)

      const result = await client.resolveSession({
        sessionRef: 'project:run3b-dto-dedup/lane:default',
      })
      expect(result.created).toBe(true)
      expect(result.hostSessionId).toBeString()

      const sessions = await client.listSessions()
      expect(sessions.length).toBe(1)
    } finally {
      if (server) await server.stop()
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})

// ===========================================================================
// R-7: Narrow hrc-store-sqlite public root exports
// ===========================================================================

describe('R-7: hrc-store-sqlite root does not export repository classes', () => {
  it('N-1: runtime export keys must not include repository classes', async () => {
    const keys = await getExportKeys('hrc-store-sqlite')
    for (const repoClass of REPOSITORY_CLASSES) {
      expect(keys).not.toContain(repoClass)
    }
  })
})

describe('R-7: hrc-store-sqlite root does not export migration helpers', () => {
  it('N-2: runtime export keys must not include migration exports', async () => {
    const keys = await getExportKeys('hrc-store-sqlite')
    for (const migExport of MIGRATION_EXPORTS) {
      expect(keys).not.toContain(migExport)
    }
  })
})

describe('R-7: hrc-store-sqlite root exports only openHrcDatabase + HrcDatabase', () => {
  it('N-3: root index.ts must only export openHrcDatabase (and HrcDatabase as type)', async () => {
    const keys = await getExportKeys('hrc-store-sqlite')
    // openHrcDatabase must still be exported (the one production-used function)
    expect(keys).toContain('openHrcDatabase')
    // The only runtime-visible exports should be openHrcDatabase (and default if present)
    const nonDefault = keys.filter((k) => k !== 'default')
    expect(nonDefault).toEqual(['openHrcDatabase'])
  })

  it('N-3: root index.ts source confirms narrow export surface', async () => {
    const storeIndex = await readSource('hrc-store-sqlite/src/index.ts')
    // Must export openHrcDatabase and HrcDatabase
    expect(storeIndex).toContain('openHrcDatabase')
    expect(storeIndex).toContain('HrcDatabase')
    // Must NOT export repository classes from root
    for (const repoClass of REPOSITORY_CLASSES) {
      expect(storeIndex).not.toContain(repoClass)
    }
    // Must NOT export migration helpers from root
    expect(storeIndex).not.toContain('phase1Migrations')
    expect(storeIndex).not.toContain('createHrcDatabase')
    expect(storeIndex).not.toContain('listAppliedMigrations')
    expect(storeIndex).not.toContain('runMigrations')
  })
})
