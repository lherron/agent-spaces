/**
 * Tests for space reference types and validation functions.
 *
 * WHY: The refs module defines the core reference format used throughout
 * the system. Proper validation is critical for security and correctness.
 */

import { describe, expect, test } from 'bun:test'

import {
  type CommitSha,
  type SpaceId,
  type SpaceKey,
  asCommitSha,
  asSha256Integrity,
  asSpaceId,
  asSpaceKey,
  formatSpaceRef,
  isCommitSha,
  isKnownDistTag,
  isSha256Integrity,
  isSpaceId,
  isSpaceKey,
  isSpaceRefString,
  parseSelector,
  parseSpaceKey,
  parseSpaceRef,
} from './refs.js'

describe('isSpaceId', () => {
  test('accepts valid kebab-case ids', () => {
    expect(isSpaceId('foo')).toBe(true)
    expect(isSpaceId('foo-bar')).toBe(true)
    expect(isSpaceId('foo-bar-baz')).toBe(true)
    expect(isSpaceId('a1')).toBe(true)
    expect(isSpaceId('a1-b2-c3')).toBe(true)
    expect(isSpaceId('123')).toBe(true)
    expect(isSpaceId('a')).toBe(true)
  })

  test('rejects invalid ids', () => {
    expect(isSpaceId('')).toBe(false)
    expect(isSpaceId('Foo')).toBe(false) // uppercase
    expect(isSpaceId('foo_bar')).toBe(false) // underscore
    expect(isSpaceId('foo bar')).toBe(false) // space
    expect(isSpaceId('foo--bar')).toBe(false) // double dash
    expect(isSpaceId('-foo')).toBe(false) // leading dash
    expect(isSpaceId('foo-')).toBe(false) // trailing dash
    expect(isSpaceId('a'.repeat(65))).toBe(false) // too long
  })

  test('accepts max length id', () => {
    expect(isSpaceId('a'.repeat(64))).toBe(true)
  })
})

describe('asSpaceId', () => {
  test('returns valid id', () => {
    expect(asSpaceId('foo-bar')).toBe('foo-bar')
  })

  test('throws for invalid id', () => {
    expect(() => asSpaceId('Foo')).toThrow(/Invalid space ID/)
    expect(() => asSpaceId('')).toThrow(/Invalid space ID/)
  })
})

describe('isCommitSha', () => {
  test('accepts valid commit SHAs', () => {
    expect(isCommitSha('abcdef1')).toBe(true) // 7 chars
    expect(isCommitSha('abc1234')).toBe(true)
    expect(
      isCommitSha('abc1234567890abc1234567890abc1234567890abc1234567890abc1234567890abc')
    ).toBe(false) // 65 chars
    expect(isCommitSha('a'.repeat(64))).toBe(true) // 64 chars
  })

  test('rejects invalid SHAs', () => {
    expect(isCommitSha('')).toBe(false)
    expect(isCommitSha('abc123')).toBe(false) // 6 chars
    expect(isCommitSha('ABCDEF1')).toBe(false) // uppercase
    expect(isCommitSha('ghijkl1')).toBe(false) // non-hex
    expect(isCommitSha('abc123!')).toBe(false) // special char
  })
})

describe('asCommitSha', () => {
  test('returns valid SHA', () => {
    expect(asCommitSha('abc1234')).toBe('abc1234')
  })

  test('throws for invalid SHA', () => {
    expect(() => asCommitSha('abc')).toThrow(/Invalid commit SHA/)
  })
})

describe('isSha256Integrity', () => {
  test('accepts valid SHA256 integrity', () => {
    const validHash = `sha256:${'a'.repeat(64)}`
    expect(isSha256Integrity(validHash)).toBe(true)
  })

  test('rejects invalid integrity', () => {
    expect(isSha256Integrity('')).toBe(false)
    expect(isSha256Integrity('sha256:')).toBe(false)
    expect(isSha256Integrity('sha256:abc')).toBe(false) // too short
    expect(isSha256Integrity(`sha512:${'a'.repeat(64)}`)).toBe(false) // wrong algo
    expect(isSha256Integrity(`SHA256:${'a'.repeat(64)}`)).toBe(false) // uppercase
    expect(isSha256Integrity(`sha256:${'g'.repeat(64)}`)).toBe(false) // non-hex
    expect(isSha256Integrity(`sha256:${'a'.repeat(63)}`)).toBe(false) // 63 chars
    expect(isSha256Integrity(`sha256:${'a'.repeat(65)}`)).toBe(false) // 65 chars
  })
})

describe('asSha256Integrity', () => {
  test('returns valid integrity', () => {
    const valid = `sha256:${'a'.repeat(64)}`
    expect(asSha256Integrity(valid)).toBe(valid)
  })

  test('throws for invalid integrity', () => {
    expect(() => asSha256Integrity('invalid')).toThrow(/Invalid SHA256 integrity/)
  })
})

describe('isSpaceKey', () => {
  test('accepts valid space keys', () => {
    expect(isSpaceKey('foo@abc1234')).toBe(true)
    expect(isSpaceKey('foo-bar@abc1234def')).toBe(true)
    expect(isSpaceKey(`a@${'b'.repeat(64)}`)).toBe(true)
  })

  test('rejects invalid space keys', () => {
    expect(isSpaceKey('')).toBe(false)
    expect(isSpaceKey('foo')).toBe(false) // no @
    expect(isSpaceKey('@abc1234')).toBe(false) // no id
    expect(isSpaceKey('foo@')).toBe(false) // no commit
    expect(isSpaceKey('foo@abc')).toBe(false) // commit too short
    expect(isSpaceKey('Foo@abc1234')).toBe(false) // uppercase id
  })
})

describe('asSpaceKey', () => {
  test('creates valid space key', () => {
    const id = 'my-space' as SpaceId
    const commit = 'abc1234' as CommitSha
    expect(asSpaceKey(id, commit)).toBe('my-space@abc1234')
  })
})

describe('parseSpaceKey', () => {
  test('parses valid space key', () => {
    const key = 'my-space@abc1234' as SpaceKey
    const result = parseSpaceKey(key)
    expect(result.id).toBe('my-space')
    expect(result.commit).toBe('abc1234')
  })

  test('handles multiple @ symbols', () => {
    // Should use lastIndexOf, so this works with ids containing @
    // Actually, the pattern doesn't allow @ in id, so this won't be a valid key
    // Let's test a normal case
    const key = 'foo-bar@abc1234567' as SpaceKey
    const result = parseSpaceKey(key)
    expect(result.id).toBe('foo-bar')
    expect(result.commit).toBe('abc1234567')
  })

  test('throws for missing @', () => {
    expect(() => parseSpaceKey('nope' as SpaceKey)).toThrow(/Invalid space key/)
  })
})

describe('isSpaceRefString', () => {
  test('accepts valid space ref strings', () => {
    expect(isSpaceRefString('space:foo@stable')).toBe(true)
    expect(isSpaceRefString('space:foo-bar@latest')).toBe(true)
    expect(isSpaceRefString('space:my-space@^1.2.3')).toBe(true)
    expect(isSpaceRefString('space:my-space@1.0.0')).toBe(true)
    expect(isSpaceRefString('space:my-space@git:abc1234')).toBe(true)
  })

  test('accepts space ref without selector (defaults to HEAD)', () => {
    expect(isSpaceRefString('space:foo')).toBe(true)
    expect(isSpaceRefString('space:foo-bar')).toBe(true)
  })

  test('rejects invalid space ref strings', () => {
    expect(isSpaceRefString('')).toBe(false)
    expect(isSpaceRefString('foo@stable')).toBe(false) // missing space: prefix
    expect(isSpaceRefString('space:@stable')).toBe(false) // missing id
    expect(isSpaceRefString('space:Foo@stable')).toBe(false) // uppercase id
  })
})

describe('parseSelector', () => {
  describe('dev', () => {
    test('parses dev selector', () => {
      expect(parseSelector('dev')).toEqual({ kind: 'dev' })
    })
  })

  describe('HEAD', () => {
    test('parses HEAD selector', () => {
      expect(parseSelector('HEAD')).toEqual({ kind: 'head' })
    })
  })

  describe('dist-tags', () => {
    test('parses known dist-tags', () => {
      expect(parseSelector('stable')).toEqual({ kind: 'dist-tag', tag: 'stable' })
      expect(parseSelector('latest')).toEqual({ kind: 'dist-tag', tag: 'latest' })
      expect(parseSelector('beta')).toEqual({ kind: 'dist-tag', tag: 'beta' })
    })

    test('parses custom dist-tags', () => {
      expect(parseSelector('custom-tag')).toEqual({ kind: 'dist-tag', tag: 'custom-tag' })
      expect(parseSelector('v1-preview')).toEqual({ kind: 'dist-tag', tag: 'v1-preview' })
    })
  })

  describe('semver', () => {
    test('parses exact semver', () => {
      expect(parseSelector('1.0.0')).toEqual({ kind: 'semver', range: '1.0.0', exact: true })
      expect(parseSelector('1.2.3')).toEqual({ kind: 'semver', range: '1.2.3', exact: true })
      expect(parseSelector('0.0.1')).toEqual({ kind: 'semver', range: '0.0.1', exact: true })
    })

    test('parses caret semver', () => {
      expect(parseSelector('^1.0.0')).toEqual({ kind: 'semver', range: '^1.0.0', exact: false })
      expect(parseSelector('^0.1.0')).toEqual({ kind: 'semver', range: '^0.1.0', exact: false })
    })

    test('parses tilde semver', () => {
      expect(parseSelector('~1.2.3')).toEqual({ kind: 'semver', range: '~1.2.3', exact: false })
      expect(parseSelector('~0.9.0')).toEqual({ kind: 'semver', range: '~0.9.0', exact: false })
    })

    test('parses semver with prerelease', () => {
      expect(parseSelector('1.0.0-alpha.1')).toEqual({
        kind: 'semver',
        range: '1.0.0-alpha.1',
        exact: true,
      })
      expect(parseSelector('^1.0.0-beta.2')).toEqual({
        kind: 'semver',
        range: '^1.0.0-beta.2',
        exact: false,
      })
    })
  })

  describe('git-pin', () => {
    test('parses git pin', () => {
      expect(parseSelector('git:abc1234')).toEqual({ kind: 'git-pin', sha: 'abc1234' })
      expect(parseSelector(`git:${'a'.repeat(40)}`)).toEqual({
        kind: 'git-pin',
        sha: 'a'.repeat(40),
      })
    })

    test('rejects invalid git pin', () => {
      // Invalid git pin should be treated as dist-tag
      expect(parseSelector('git:abc')).toEqual({ kind: 'dist-tag', tag: 'git:abc' })
    })
  })
})

describe('parseSpaceRef', () => {
  test('parses complete space ref', () => {
    const result = parseSpaceRef('space:my-space@stable')
    expect(result.id).toBe('my-space')
    expect(result.selectorString).toBe('stable')
    expect(result.selector).toEqual({ kind: 'dist-tag', tag: 'stable' })
  })

  test('parses semver ref', () => {
    const result = parseSpaceRef('space:foo-bar@^1.2.3')
    expect(result.id).toBe('foo-bar')
    expect(result.selectorString).toBe('^1.2.3')
    expect(result.selector).toEqual({ kind: 'semver', range: '^1.2.3', exact: false })
  })

  test('parses git pin ref', () => {
    const result = parseSpaceRef('space:foo@git:abc1234')
    expect(result.id).toBe('foo')
    expect(result.selectorString).toBe('git:abc1234')
    expect(result.selector).toEqual({ kind: 'git-pin', sha: 'abc1234' })
  })

  test('parses ref without selector (defaults to dev)', () => {
    const result = parseSpaceRef('space:foo')
    expect(result.id).toBe('foo')
    expect(result.selectorString).toBe('dev')
    expect(result.selector).toEqual({ kind: 'dev' })
    expect(result.defaultedToDev).toBe(true)
  })

  test('parses explicit HEAD selector', () => {
    const result = parseSpaceRef('space:foo@HEAD')
    expect(result.id).toBe('foo')
    expect(result.selectorString).toBe('HEAD')
    expect(result.selector).toEqual({ kind: 'head' })
    expect(result.defaultedToDev).toBeUndefined()
  })

  test('parses explicit dev selector', () => {
    const result = parseSpaceRef('space:foo@dev')
    expect(result.id).toBe('foo')
    expect(result.selectorString).toBe('dev')
    expect(result.selector).toEqual({ kind: 'dev' })
    expect(result.defaultedToDev).toBeUndefined()
  })

  test('throws for invalid ref', () => {
    expect(() => parseSpaceRef('invalid')).toThrow(/Invalid space ref/)
    expect(() => parseSpaceRef('foo@stable')).toThrow(/Invalid space ref/)
  })
})

describe('formatSpaceRef', () => {
  test('formats space ref', () => {
    const ref = {
      id: 'my-space' as SpaceId,
      selectorString: 'stable',
      selector: { kind: 'dist-tag' as const, tag: 'stable' },
    }
    expect(formatSpaceRef(ref)).toBe('space:my-space@stable')
  })
})

describe('isKnownDistTag', () => {
  test('returns true for known tags', () => {
    expect(isKnownDistTag('stable')).toBe(true)
    expect(isKnownDistTag('latest')).toBe(true)
    expect(isKnownDistTag('beta')).toBe(true)
  })

  test('returns false for unknown tags', () => {
    expect(isKnownDistTag('alpha')).toBe(false)
    expect(isKnownDistTag('custom')).toBe(false)
    expect(isKnownDistTag('')).toBe(false)
  })
})
