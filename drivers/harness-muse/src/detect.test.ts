/**
 * Muse binary detection through MuseAdapter.detect(): explicit-path
 * precedence, absent and failing binaries, and the probe cache, all against
 * shims on a scratch PATH with common install paths skipped. The candidate
 * list is tested directly only for the skip flag, whose effect needs a muse
 * at a host-fixed common path. No real binary or credentials required.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { museAdapter } from './adapters/muse-adapter.js'
import { MUSE_PATH_ENV, MUSE_SKIP_COMMON_PATHS_ENV, museCommandCandidates } from './detect.js'

const originalPath = process.env['PATH']
const originalSkipCommonPaths = process.env[MUSE_SKIP_COMMON_PATHS_ENV]
const originalMusePath = process.env[MUSE_PATH_ENV]

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    process.env[key] = undefined
  } else {
    process.env[key] = value
  }
}

afterEach(() => {
  restoreEnv('PATH', originalPath)
  restoreEnv(MUSE_SKIP_COMMON_PATHS_ENV, originalSkipCommonPaths)
  restoreEnv(MUSE_PATH_ENV, originalMusePath)
})

describe('museCommandCandidates', () => {
  test('skip flag removes common paths', () => {
    const candidates = museCommandCandidates({
      home: '/fake-home',
      pathValue: '',
      env: { ASP_MUSE_SKIP_COMMON_PATHS: '1' } as NodeJS.ProcessEnv,
    })
    expect(candidates).toEqual([])
  })
})

describe('detectMuse', () => {
  async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = join(tmpdir(), `muse-detect-${Date.now()}-${Math.random()}`)
    try {
      await run(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** A muse shim that records each invocation in `<dir>/probes`. */
  async function writeCountingShim(dir: string, version: string, exitCode = 0): Promise<string> {
    await mkdir(dir, { recursive: true })
    const shim = join(dir, 'muse')
    await writeFile(
      shim,
      `#!/bin/sh\necho x >> "${join(dir, 'probes')}"\necho "muse ${version}"\nexit ${exitCode}\n`
    )
    await chmod(shim, 0o755)
    return shim
  }

  async function probeCount(dir: string): Promise<number> {
    try {
      return (await readFile(join(dir, 'probes'), 'utf8')).split('\n').filter(Boolean).length
    } catch {
      return 0
    }
  }

  /** Resolve muse only from `pathValue`: no explicit path, no common install paths. */
  function useOnlyPath(pathValue: string): void {
    process.env['PATH'] = pathValue
    process.env[MUSE_SKIP_COMMON_PATHS_ENV] = '1'
    restoreEnv(MUSE_PATH_ENV, undefined)
  }

  test('explicit ASP_MUSE_PATH leads the candidate list', () =>
    withTempDir(async (dir) => {
      await writeCountingShim(join(dir, 'on-path'), '1.3.0')
      const explicit = await writeCountingShim(join(dir, 'explicit'), '1.3.0')
      useOnlyPath(join(dir, 'on-path'))
      process.env[MUSE_PATH_ENV] = explicit

      const detection = await museAdapter.detect()

      expect(detection.available).toBe(true)
      expect(detection.path).toBe(explicit)
    }))

  test('absent binary reports available:false without throwing', async () => {
    useOnlyPath('')
    process.env[MUSE_PATH_ENV] = '/nonexistent/muse'

    const detection = await museAdapter.detect()

    expect(detection.available).toBe(false)
    expect(detection.error).toBe(
      `muse not found on PATH, ${MUSE_PATH_ENV}, or common user install paths`
    )
  })

  test('present-but-failing binary attributes the cause', () =>
    withTempDir(async (dir) => {
      await mkdir(dir, { recursive: true })
      const shim = join(dir, 'muse')
      await writeFile(shim, '#!/bin/sh\necho boom >&2\nexit 1\n')
      await chmod(shim, 0o755)
      useOnlyPath(dir)

      const detection = await museAdapter.detect()

      expect(detection.available).toBe(false)
      expect(detection.error).toContain(`${shim}: boom`)
    }))

  test('reuses a successful detection while the binary is unchanged', () =>
    withTempDir(async (dir) => {
      const shim = await writeCountingShim(dir, '1.3.0')
      useOnlyPath(dir)

      const first = await museAdapter.detect()
      const second = await museAdapter.detect()

      expect(first).toMatchObject({ available: true, version: '1.3.0', path: shim })
      expect(second).toEqual(first)
      expect(await probeCount(dir)).toBe(2)
    }))

  test('re-probes after the binary is replaced', () =>
    withTempDir(async (dir) => {
      const shim = await writeCountingShim(dir, '1.3.0')
      useOnlyPath(dir)

      await museAdapter.detect()
      await writeCountingShim(dir, '1.3.1')
      await utimes(shim, new Date(), new Date(Date.now() + 5_000))

      expect(await museAdapter.detect()).toMatchObject({ available: true, version: '1.3.1' })
      expect(await probeCount(dir)).toBe(4)
    }))

  test('does not cache a failed probe', () =>
    withTempDir(async (dir) => {
      await writeCountingShim(dir, '1.3.0', 1)
      useOnlyPath(dir)

      expect((await museAdapter.detect()).available).toBe(false)
      expect((await museAdapter.detect()).available).toBe(false)
      expect(await probeCount(dir)).toBe(2)
    }))
})
