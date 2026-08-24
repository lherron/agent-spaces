import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isMissingFileError, readFileOrEmpty, readFileOrUndefined } from './file-reader.js'

describe('file-reader', () => {
  let dir: string
  let existingPath: string
  let missingPath: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runtime-file-reader-'))
    existingPath = join(dir, 'present.txt')
    missingPath = join(dir, 'absent.txt')
    await writeFile(existingPath, 'hello', 'utf8')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('readFileOrUndefined returns content when the file exists', async () => {
    expect(await readFileOrUndefined(existingPath)).toBe('hello')
  })

  test('readFileOrUndefined returns undefined when the file is missing', async () => {
    expect(await readFileOrUndefined(missingPath)).toBeUndefined()
  })

  test('readFileOrEmpty returns content when the file exists', async () => {
    expect(await readFileOrEmpty(existingPath)).toBe('hello')
  })

  test('readFileOrEmpty returns empty string when the file is missing', async () => {
    expect(await readFileOrEmpty(missingPath)).toBe('')
  })

  test('isMissingFileError detects ENOENT', () => {
    expect(isMissingFileError({ code: 'ENOENT' })).toBe(true)
    expect(isMissingFileError({ code: 'EACCES' })).toBe(false)
    expect(isMissingFileError(new Error('boom'))).toBe(false)
    expect(isMissingFileError(null)).toBe(false)
  })
})
