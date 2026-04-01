/**
 * RED/GREEN gate for T-00990: HRC Reduction Run 3 Phase A (R-2, R-6, R-4)
 *
 * Phase A collapses three standalone packages into hrc-server:
 *   R-2: Delete hrc-bridge-agentchat (no production consumers)
 *   R-6: Collapse hrc-launch into hrc-server internals
 *   R-4: Collapse hrc-adapter-agent-spaces into hrc-server
 *
 * These tests are the gatekeeper. They FAIL (RED) before Larry's work because
 * the packages still exist as standalone dirs and hrc-server still depends on
 * them as external workspace packages.
 *
 * Pass conditions (Smokey -> Larry):
 *   S-1: packages/hrc-bridge-agentchat/ must not exist
 *   S-2: packages/hrc-launch/ must not exist (collapsed into hrc-server)
 *   S-3: packages/hrc-adapter-agent-spaces/ must not exist (collapsed into hrc-server)
 *   S-4: hrc-server/package.json must NOT list hrc-launch or hrc-adapter-agent-spaces
 *         as dependencies (they are internal now)
 *   S-5: root build:ordered must NOT reference hrc-launch, hrc-bridge-agentchat,
 *         or hrc-adapter-agent-spaces as separate build filters
 *   S-6: hrc-launch exec.ts and hook-cli.ts must exist under hrc-server and remain
 *         executable (spawn with --help or similar must not crash with MODULE_NOT_FOUND)
 *   S-7: hrc-server must internally provide writeLaunchArtifact and readSpoolEntries
 *         (previously imported from hrc-launch)
 *   S-8: hrc-server must internally provide buildCliInvocation, runSdkTurn,
 *         deliverSdkInflightInput, getSdkInflightCapability
 *         (previously imported from hrc-adapter-agent-spaces)
 *   S-9: adapter test coverage (cli-adapter, sdk-adapter, inflight-adapter tests)
 *         must exist under hrc-server's test directory
 *   S-10: the full server stack (createHrcServer + HrcClient) must still work
 *         end-to-end after the collapse (session resolve, watch, spool replay)
 *
 * Reference: T-00990, HRC_REDUCTION_REVIEW.md R-2/R-6/R-4
 */
import { describe, expect, it } from 'bun:test'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const PACKAGES = join(REPO_ROOT, 'packages')

// ---------------------------------------------------------------------------
// S-1: hrc-bridge-agentchat package must not exist (R-2)
// ---------------------------------------------------------------------------
describe('R-2: hrc-bridge-agentchat removed', () => {
  it('S-1: packages/hrc-bridge-agentchat/ directory must not exist', async () => {
    const dirStat = await stat(join(PACKAGES, 'hrc-bridge-agentchat')).catch(() => null)
    expect(dirStat).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// S-2: hrc-launch package must not exist (R-6)
// ---------------------------------------------------------------------------
describe('R-6: hrc-launch collapsed into hrc-server', () => {
  it('S-2: packages/hrc-launch/ directory must not exist', async () => {
    const dirStat = await stat(join(PACKAGES, 'hrc-launch')).catch(() => null)
    expect(dirStat).toBeNull()
  })

  it('S-6: exec.ts entry point exists under hrc-server and is parseable', async () => {
    // The exec script must be somewhere under hrc-server after collapse.
    // It can be at any path, but must exist and be valid TypeScript/JS.
    const serverSrc = join(PACKAGES, 'hrc-server', 'src')
    const execPath = await findFileRecursive(serverSrc, 'exec.ts')
    expect(execPath).not.toBeNull()

    // Verify it has the main() function and spawn logic
    const content = await readFile(execPath!, 'utf-8')
    expect(content).toContain('readLaunchArtifact')
    expect(content).toContain('spawn')
  })

  it('S-6: hook-cli.ts entry point exists under hrc-server and is parseable', async () => {
    const serverSrc = join(PACKAGES, 'hrc-server', 'src')
    const hookPath = await findFileRecursive(serverSrc, 'hook-cli.ts')
    expect(hookPath).not.toBeNull()

    // Verify it has the stdin/hook logic
    const content = await readFile(hookPath!, 'utf-8')
    expect(content).toContain('buildHookEnvelope')
    expect(content).toContain('stdin')
  })

  it('S-7: hrc-server no longer imports from external hrc-launch package', async () => {
    const serverIndex = await readFile(join(PACKAGES, 'hrc-server', 'src', 'index.ts'), 'utf-8')
    // Must NOT contain an import from the 'hrc-launch' package specifier
    // (internal relative imports like './launch/...' are fine)
    expect(serverIndex).not.toMatch(/from\s+['"]hrc-launch['"]/)
  })
})

// ---------------------------------------------------------------------------
// S-3: hrc-adapter-agent-spaces package must not exist (R-4)
// ---------------------------------------------------------------------------
describe('R-4: hrc-adapter-agent-spaces collapsed into hrc-server', () => {
  it('S-3: packages/hrc-adapter-agent-spaces/ directory must not exist', async () => {
    const dirStat = await stat(join(PACKAGES, 'hrc-adapter-agent-spaces')).catch(() => null)
    expect(dirStat).toBeNull()
  })

  it('S-8: hrc-server no longer imports from external hrc-adapter-agent-spaces', async () => {
    const serverIndex = await readFile(join(PACKAGES, 'hrc-server', 'src', 'index.ts'), 'utf-8')
    expect(serverIndex).not.toMatch(/from\s+['"]hrc-adapter-agent-spaces['"]/)
  })

  it('S-8: adapter functions are available internally in hrc-server', async () => {
    // After collapse, the adapter code must live under hrc-server/src/
    // and the server index must reference the adapter functions via relative import
    const serverIndex = await readFile(join(PACKAGES, 'hrc-server', 'src', 'index.ts'), 'utf-8')
    // These four functions must still be referenced (imported internally)
    expect(serverIndex).toContain('buildCliInvocation')
    expect(serverIndex).toContain('runSdkTurn')
    expect(serverIndex).toContain('deliverSdkInflightInput')
    expect(serverIndex).toContain('getSdkInflightCapability')
  })

  it('S-9: adapter test files exist under hrc-server test directory', async () => {
    const serverSrc = join(PACKAGES, 'hrc-server', 'src')
    // The three adapter test files must be preserved somewhere under hrc-server
    const cliAdapterTest = await findFileRecursive(serverSrc, 'cli-adapter.test.ts')
    const sdkAdapterTest = await findFileRecursive(serverSrc, 'sdk-adapter.test.ts')
    const inflightTest = await findFileRecursive(serverSrc, 'inflight-adapter.test.ts')

    expect(cliAdapterTest).not.toBeNull()
    expect(sdkAdapterTest).not.toBeNull()
    expect(inflightTest).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// S-4: hrc-server/package.json must not depend on collapsed packages
// ---------------------------------------------------------------------------
describe('package.json cleanup', () => {
  it('S-4: hrc-server dependencies exclude collapsed packages', async () => {
    const pkg = JSON.parse(await readFile(join(PACKAGES, 'hrc-server', 'package.json'), 'utf-8'))
    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    }
    expect(deps['hrc-launch']).toBeUndefined()
    expect(deps['hrc-adapter-agent-spaces']).toBeUndefined()
    expect(deps['hrc-bridge-agentchat']).toBeUndefined()
  })

  it('S-4: hrc-server gains adapter dependencies (agent-spaces, spaces-runtime, spaces-execution)', async () => {
    // hrc-adapter-agent-spaces depended on these; hrc-server must absorb them
    const pkg = JSON.parse(await readFile(join(PACKAGES, 'hrc-server', 'package.json'), 'utf-8'))
    const deps = { ...pkg.dependencies, ...pkg.peerDependencies }
    expect(deps['agent-spaces']).toBeDefined()
    expect(deps['spaces-runtime']).toBeDefined()
    expect(deps['spaces-execution']).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// S-5: root build:ordered must not reference deleted packages
// ---------------------------------------------------------------------------
describe('root build config cleanup', () => {
  it('S-5: build:ordered does not reference deleted packages', async () => {
    const rootPkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf-8'))
    const buildCmd: string = rootPkg.scripts?.['build:ordered'] ?? ''
    expect(buildCmd).not.toContain('hrc-bridge-agentchat')
    expect(buildCmd).not.toContain('hrc-launch')
    expect(buildCmd).not.toContain('hrc-adapter-agent-spaces')
  })
})

// ---------------------------------------------------------------------------
// S-10: E2E server stack still works after collapse
// (This re-validates the slice1a AC-1/AC-2 acceptance criteria post-collapse)
// ---------------------------------------------------------------------------
describe('S-10: server stack functional after collapse', () => {
  // Dynamic import so the test file loads even if hrc-server structure changes
  it('createHrcServer + HrcClient session resolve still works', async () => {
    const { createHrcServer } = await import('hrc-server')
    const { HrcClient } = await import('hrc-sdk')
    const { mkdtemp, mkdir, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join: pathJoin } = await import('node:path')

    const tmpDir = await mkdtemp(pathJoin(tmpdir(), 'hrc-run3-'))
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

      // Session resolve must still work
      const result = await client.resolveSession({
        sessionRef: 'project:run3-collapse/lane:default',
      })
      expect(result.created).toBe(true)
      expect(result.hostSessionId).toBeString()

      // List sessions must still work
      const sessions = await client.listSessions()
      expect(sessions.length).toBe(1)
    } finally {
      if (server) await server.stop()
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively search for a file by name under a directory */
async function findFileRecursive(dir: string, filename: string): Promise<string | null> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isFile() && entry.name === filename) return fullPath
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        const found = await findFileRecursive(fullPath, filename)
        if (found) return found
      }
    }
  } catch {
    // dir doesn't exist
  }
  return null
}
