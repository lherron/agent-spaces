/**
 * detectMuse tests: candidate ordering and the absent-binary path.
 * No binary or credentials required.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MUSE_PATH_ENV, detectMuse, museCommandCandidates } from './detect.js'

const originalPath = process.env.PATH
const originalSkipCommonPaths = process.env.ASP_MUSE_SKIP_COMMON_PATHS

afterEach(() => {
  process.env.PATH = originalPath
  if (originalSkipCommonPaths === undefined) {
    process.env.ASP_MUSE_SKIP_COMMON_PATHS = undefined
  } else {
    process.env.ASP_MUSE_SKIP_COMMON_PATHS = originalSkipCommonPaths
  }
})

describe('museCommandCandidates', () => {
  test('explicit ASP_MUSE_PATH leads the candidate list', () => {
    const candidates = museCommandCandidates({
      home: '/nonexistent-home',
      pathValue: '',
      env: { [MUSE_PATH_ENV]: '/custom/muse' } as NodeJS.ProcessEnv,
    })
    expect(candidates[0]).toBe('/custom/muse')
  })

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
  test('absent binary reports available:false without throwing', async () => {
    const detection = await detectMuse({
      home: '/nonexistent-home',
      pathValue: '',
      env: {
        [MUSE_PATH_ENV]: '/nonexistent/muse',
        ASP_MUSE_SKIP_COMMON_PATHS: '1',
      } as NodeJS.ProcessEnv,
      exists: () => false,
    })
    expect(detection.available).toBe(false)
  })

  test('present-but-failing binary attributes the cause', async () => {
    const detection = await detectMuse({
      home: '/nonexistent-home',
      pathValue: '',
      env: {
        [MUSE_PATH_ENV]: '/bin/muse',
        ASP_MUSE_SKIP_COMMON_PATHS: '1',
      } as NodeJS.ProcessEnv,
      exists: (path) => path === '/bin/muse',
      run: async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }),
    })
    expect(detection.available).toBe(false)
    if (!detection.available) {
      expect(detection.error).toContain('/bin/muse: boom')
    }
  })

  test('working binary reports version + serve capability', async () => {
    const detection = await detectMuse({
      home: '/nonexistent-home',
      pathValue: '',
      env: {
        [MUSE_PATH_ENV]: '/bin/muse',
        ASP_MUSE_SKIP_COMMON_PATHS: '1',
      } as NodeJS.ProcessEnv,
      exists: (path) => path === '/bin/muse',
      run: async (args) => {
        if (args[1] === '--version') {
          return { exitCode: 0, stdout: 'muse 1.3.0\n', stderr: '' }
        }
        return { exitCode: 0, stdout: 'serve help\n', stderr: '' }
      },
    })
    expect(detection).toEqual({
      available: true,
      version: '1.3.0',
      path: '/bin/muse',
      capabilities: ['serve'],
    })
  })

  async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = join(tmpdir(), `muse-detect-${Date.now()}-${Math.random()}`)
    try {
      await run(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async function writeCountingShim(
    dir: string,
    version: string,
    exitCode = 0
  ): Promise<string> {
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

  function useOnlyShim(dir: string): void {
    process.env.PATH = dir
    process.env.ASP_MUSE_SKIP_COMMON_PATHS = '1'
  }

  test('reuses a successful detection while the binary is unchanged', () =>
    withTempDir(async (dir) => {
      await writeCountingShim(dir, '1.3.0')
      useOnlyShim(dir)

      const first = await detectMuse()
      const second = await detectMuse()

      expect(first).toMatchObject({ available: true, version: '1.3.0' })
      expect(second).toEqual(first)
      expect(await probeCount(dir)).toBe(2)
    }))

  test('re-probes after the binary is replaced', () =>
    withTempDir(async (dir) => {
      const shim = await writeCountingShim(dir, '1.3.0')
      useOnlyShim(dir)

      await detectMuse()
      await writeCountingShim(dir, '1.3.1')
      await utimes(shim, new Date(), new Date(Date.now() + 5_000))

      expect(await detectMuse()).toMatchObject({ available: true, version: '1.3.1' })
      expect(await probeCount(dir)).toBe(4)
    }))

  test('does not cache a failed probe', () =>
    withTempDir(async (dir) => {
      await writeCountingShim(dir, '1.3.0', 1)
      useOnlyShim(dir)

      expect((await detectMuse()).available).toBe(false)
      expect((await detectMuse()).available).toBe(false)
      expect(await probeCount(dir)).toBe(2)
    }))
})
