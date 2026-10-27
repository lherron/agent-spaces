import { describe, expect, test } from 'bun:test'
import { isMissingFileError } from './file-reader.js'

describe('file-reader', () => {
  test('isMissingFileError detects ENOENT', () => {
    expect(isMissingFileError({ code: 'ENOENT' })).toBe(true)
    expect(isMissingFileError({ code: 'EACCES' })).toBe(false)
    expect(isMissingFileError(new Error('boom'))).toBe(false)
    expect(isMissingFileError(null)).toBe(false)
  })
})
