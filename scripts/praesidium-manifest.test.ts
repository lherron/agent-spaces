import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..')
const MANIFEST_PATH = join(REPO_ROOT, 'praesidium.toml')

describe('praesidium.toml batch worktree manifest', () => {
  test('declares worktree-local prep/install/test commands and documents publish edges', () => {
    // T-05831: batch-drain worktree enablement depends on this root manifest.
    // Keep this test focused on the public manifest contract so implementation can
    // change validation internals without weakening the drain preflight bar.
    expect(existsSync(MANIFEST_PATH)).toBeTrue()
    if (!existsSync(MANIFEST_PATH)) return

    const content = readFileSync(MANIFEST_PATH, 'utf8')
    const manifest = Bun.TOML.parse(content) as {
      commands?: {
        prep?: unknown
        install?: unknown
        test?: unknown
      }
    }

    expect(manifest.commands?.prep).toBe('bun install && bun run prepare')
    expect(manifest.commands?.install).toBe('bun run clean && bun install && bun run build')
    expect(manifest.commands?.test).toBe('just verify')

    expect(content).toContain('just install')
    expect(content).toContain('hrc-runtime')
    expect(content).toContain('agent-control-plane')
    expect(content).toContain('worktree-local')
    expect(content).toContain('workspace:*')

    const batchInstall = String(manifest.commands?.install ?? '')
    expect(batchInstall).not.toContain('just install')
    expect(batchInstall).not.toContain('publish-dev')
    expect(batchInstall).not.toContain('sync-downstream')
  })
})
