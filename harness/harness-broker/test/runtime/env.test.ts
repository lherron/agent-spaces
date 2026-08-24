import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { delimiter } from 'node:path'
import { buildProcessEnv } from '../../src/runtime/env'

describe('buildProcessEnv — pathPrepend PATH mutation', () => {
  // Computed key dodges biome's noDelete (literal-member) rule while letting us
  // truly remove PATH (assigning `undefined` would coerce to the string "undefined").
  const PATH_KEY = 'PATH'
  let originalPath: string | undefined

  beforeEach(() => {
    originalPath = process.env[PATH_KEY]
  })

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env[PATH_KEY]
    } else {
      process.env[PATH_KEY] = originalPath
    }
  })

  test('prepends directories to the composed PATH in array order', () => {
    process.env[PATH_KEY] = `/usr/bin${delimiter}/bin`
    const env = buildProcessEnv({ pathPrepend: ['/a/bin', '/b/bin'] })
    expect(env['PATH']).toBe(`/a/bin${delimiter}/b/bin${delimiter}/usr/bin${delimiter}/bin`)
  })

  test('uses the joined prepend list when ambient PATH is absent', () => {
    delete process.env[PATH_KEY]
    const env = buildProcessEnv({ pathPrepend: ['/a/bin', '/b/bin'] })
    expect(env['PATH']).toBe(`/a/bin${delimiter}/b/bin`)
  })

  test('uses the joined prepend list when ambient PATH is empty', () => {
    process.env[PATH_KEY] = ''
    const env = buildProcessEnv({ pathPrepend: ['/a/bin', '/b/bin'] })
    expect(env['PATH']).toBe(`/a/bin${delimiter}/b/bin`)
  })

  test('a directory already present in ambient PATH is NOT a collision', () => {
    process.env['PATH'] = `/usr/bin${delimiter}/bin`
    // /usr/bin is already in ambient PATH; pathPrepend intentionally mutates PATH.
    const env = buildProcessEnv({ pathPrepend: ['/usr/bin'] })
    expect(env['PATH']).toBe(`/usr/bin${delimiter}/usr/bin${delimiter}/bin`)
  })

  test('absence/empty pathPrepend leaves the composed PATH untouched', () => {
    process.env['PATH'] = `/usr/bin${delimiter}/bin`
    expect(buildProcessEnv({})['PATH']).toBe(`/usr/bin${delimiter}/bin`)
    expect(buildProcessEnv({ pathPrepend: [] })['PATH']).toBe(`/usr/bin${delimiter}/bin`)
  })

  test('rejects empty-string entries', () => {
    expect(() => buildProcessEnv({ pathPrepend: [''] })).toThrow('non-empty string')
  })

  test('rejects non-absolute entries', () => {
    expect(() => buildProcessEnv({ pathPrepend: ['relative/bin'] })).toThrow('absolute path')
  })

  test('rejects NUL bytes', () => {
    expect(() => buildProcessEnv({ pathPrepend: [`/a/bin${String.fromCharCode(0)}`] })).toThrow(
      'NUL byte'
    )
  })

  test('rejects entries containing the path delimiter', () => {
    expect(() => buildProcessEnv({ pathPrepend: [`/a/bin${delimiter}/b/bin`] })).toThrow(
      'path delimiter'
    )
  })

  test('rejects duplicate entries', () => {
    expect(() => buildProcessEnv({ pathPrepend: ['/a/bin', '/a/bin'] })).toThrow('duplicate entry')
  })

  test('PATH mutation applies after the four-channel disjoint-union compose', () => {
    process.env['PATH'] = '/usr/bin'
    const env = buildProcessEnv({
      lockedEnv: { CODEX_HOME: '/workspace/.codex-home' },
      dispatchEnv: { ASP_RUN_ID: 'run_123' },
      pathPrepend: ['/agent/tools/bin'],
    })
    expect(env['CODEX_HOME']).toBe('/workspace/.codex-home')
    expect(env['ASP_RUN_ID']).toBe('run_123')
    expect(env['PATH']).toBe(`/agent/tools/bin${delimiter}/usr/bin`)
  })
})
