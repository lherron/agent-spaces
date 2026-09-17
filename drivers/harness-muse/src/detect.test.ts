/**
 * detectMuse tests: candidate ordering and the absent-binary path.
 * No binary or credentials required.
 */
import { describe, expect, test } from 'bun:test'
import { MUSE_PATH_ENV, detectMuse, museCommandCandidates } from './detect.js'

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
})
