/**
 * CodexAdapter.detect: codex CLI discovery — version gate, ASP_CODEX_PATH override,
 * probe caching, and candidate ordering.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAdapter } from './codex-adapter.js'
import { codexCommandCandidates } from './codex-discovery.js'

describe('CodexAdapter', () => {
  let adapter: CodexAdapter

  beforeEach(() => {
    adapter = new CodexAdapter()
  })

  describe('detect', () => {
    const originalPath = process.env['PATH']
    const originalAspCodexPath = process.env['ASP_CODEX_PATH']
    const originalSkipCommonPaths = process.env['ASP_CODEX_SKIP_COMMON_PATHS']
    let tmpDir: string

    async function writeCodexShim(dir: string, version: string): Promise<string> {
      await mkdir(dir, { recursive: true })
      const shim = join(dir, 'codex')
      await writeFile(
        shim,
        `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-cli ${version}"
  exit 0
fi
if [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then
  echo "app-server help"
  exit 0
fi
exit 1
`
      )
      await chmod(shim, 0o755)
      return shim
    }

    beforeEach(async () => {
      tmpDir = join(tmpdir(), `codex-adapter-detect-${Date.now()}`)
      process.env['ASP_CODEX_PATH'] = undefined
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
    })

    afterEach(async () => {
      process.env['PATH'] = originalPath
      if (originalAspCodexPath === undefined) {
        process.env['ASP_CODEX_PATH'] = undefined
      } else {
        process.env['ASP_CODEX_PATH'] = originalAspCodexPath
      }
      if (originalSkipCommonPaths === undefined) {
        process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = undefined
      } else {
        process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalSkipCommonPaths
      }
      await rm(tmpDir, { recursive: true, force: true })
    })

    test('skips stale codex binaries and uses a new enough candidate', async () => {
      const oldBin = join(tmpDir, 'old-bin')
      const newBin = join(tmpDir, 'new-bin')
      await writeCodexShim(oldBin, '0.92.0')
      const newShim = await writeCodexShim(newBin, '0.124.0')
      process.env['PATH'] = `${oldBin}:${newBin}`

      const detection = await adapter.detect()

      expect(detection.available).toBe(true)
      expect(detection.version).toBe('0.124.0')
      expect(detection.path).toBe(newShim)
    })

    test('reports the stale codex version when no candidate is new enough', async () => {
      const oldBin = join(tmpDir, 'old-bin')
      await writeCodexShim(oldBin, '0.92.0')
      process.env['PATH'] = oldBin

      const detection = await adapter.detect()

      expect(detection.available).toBe(false)
      expect(detection.error).toContain('codex 0.92.0 is below minimum 0.124.0')
    })

    test('honors ASP_CODEX_PATH before PATH', async () => {
      const oldBin = join(tmpDir, 'old-bin')
      const overrideBin = join(tmpDir, 'override-bin')
      await writeCodexShim(oldBin, '0.92.0')
      const overrideShim = await writeCodexShim(overrideBin, '0.124.0')
      process.env['PATH'] = oldBin
      process.env['ASP_CODEX_PATH'] = overrideShim

      const detection = await adapter.detect()

      expect(detection.available).toBe(true)
      expect(detection.path).toBe(overrideShim)
    })

    async function writeCountingShim(dir: string, version: string, exitCode = 0): Promise<string> {
      await mkdir(dir, { recursive: true })
      const shim = join(dir, 'codex')
      await writeFile(
        shim,
        `#!/bin/sh
echo x >> "${join(dir, 'probes')}"
if [ "$1" = "--version" ]; then
  echo "codex-cli ${version}"
  exit ${exitCode}
fi
if [ "$1" = "app-server" ] && [ "$2" = "--help" ]; then
  exit ${exitCode}
fi
exit 1
`
      )
      await chmod(shim, 0o755)
      return shim
    }

    async function probeCount(dir: string): Promise<number> {
      try {
        return (await readFile(join(dir, 'probes'), 'utf-8')).split('\n').filter(Boolean).length
      } catch {
        return 0
      }
    }

    test('reuses a successful detection while the binary is unchanged', async () => {
      const bin = join(tmpDir, 'cached-bin')
      await writeCountingShim(bin, '0.124.0')
      process.env['PATH'] = bin

      const first = await adapter.detect()
      const probesAfterFirst = await probeCount(bin)
      const second = await adapter.detect()

      expect(first.available).toBe(true)
      expect(probesAfterFirst).toBe(2)
      expect(second).toEqual(first)
      expect(await probeCount(bin)).toBe(2)
    })

    test('re-probes after the binary is replaced', async () => {
      const bin = join(tmpDir, 'replaced-bin')
      const shim = await writeCountingShim(bin, '0.124.0')
      process.env['PATH'] = bin

      await adapter.detect()
      await writeCountingShim(bin, '0.125.0')
      await utimes(shim, new Date(), new Date(Date.now() + 5_000))
      const detection = await adapter.detect()

      expect(detection.version).toBe('0.125.0')
      expect(await probeCount(bin)).toBe(4)
    })

    test('does not cache a failed probe', async () => {
      const bin = join(tmpDir, 'failing-bin')
      await writeCountingShim(bin, '0.124.0', 1)
      process.env['PATH'] = bin

      expect((await adapter.detect()).available).toBe(false)
      expect((await adapter.detect()).available).toBe(false)
      expect(await probeCount(bin)).toBe(2)
    })

    test('keeps common install paths ahead of PATH candidates', () => {
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = undefined
      process.env['PATH'] = join(tmpDir, 'path-bin')

      const candidates = codexCommandCandidates()
      const fixedCandidate = '/opt/homebrew/bin/codex'
      const pathCandidate = join(tmpDir, 'path-bin', 'codex')

      expect(candidates).toContain(fixedCandidate)
      expect(candidates.indexOf(fixedCandidate)).toBeLessThan(candidates.indexOf(pathCandidate))
      expect(candidates.at(-1)).toBe(pathCandidate)
    })

    test('prefers the user-local codex over version-manager copies', async () => {
      const home = join(tmpDir, 'home')
      await mkdir(join(home, '.nvm', 'versions', 'node', 'v22.20.0'), { recursive: true })
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = undefined
      process.env['PATH'] = ''

      const candidates = codexCommandCandidates(home)
      const localCandidate = join(home, '.local', 'bin', 'codex')
      const nvmCandidate = join(home, '.nvm', 'versions', 'node', 'v22.20.0', 'bin', 'codex')

      expect(candidates.indexOf(localCandidate)).toBeLessThan(candidates.indexOf(nvmCandidate))
    })
  })
})
