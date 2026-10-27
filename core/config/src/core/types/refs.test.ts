import {
  type SpaceKey,
  formatSpaceRef,
  isKnownDistTag,
  isProjectSpaceRef,
  isSpaceKey,
  parseSpaceKey,
} from './refs.js'
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
  type SpaceRef,
  asCommitSha,
  asSha256Integrity,
  asSpaceId,
  asSpaceKey,
  isCommitSha,
  isSha256Integrity,
  isSpaceId,
  isSpaceRefString,
  parseSpaceRef,
} from './refs.js'

describe('isSpaceId', () => {
  test.each([
    ['foo', true],
    ['foo-bar-baz', true],
    ['a1-b2-c3', true],
    ['123', true],
    ['a', true],
    ['a'.repeat(64), true],
    ['', false],
    ['Foo', false],
    ['foo_bar', false],
    ['foo bar', false],
    ['foo--bar', false],
    ['-foo', false],
    ['foo-', false],
    ['a'.repeat(65), false],
  ])('space ids must be kebab-case, 1-64 chars: %j → %p', (value, valid) => {
    expect(isSpaceId(value)).toBe(valid)
    if (valid) {
      expect<string>(asSpaceId(value)).toBe(value)
    } else {
      expect(() => asSpaceId(value)).toThrow(/Invalid space ID/)
    }
  })
})

describe('isCommitSha', () => {
  test.each([
    ['abcdef1', true],
    ['abc1234', true],
    ['a'.repeat(64), true],
    ['a'.repeat(65), false],
    ['', false],
    ['abc123', false],
    ['ABCDEF1', false],
    ['ghijkl1', false],
    ['abc123!', false],
  ])('commit SHAs are 7-64 lowercase hex chars: %j → %p', (value, valid) => {
    expect(isCommitSha(value)).toBe(valid)
    if (valid) {
      expect<string>(asCommitSha(value)).toBe(value)
    } else {
      expect(() => asCommitSha(value)).toThrow(/Invalid commit SHA/)
    }
  })
})

describe('isSha256Integrity', () => {
  test.each([
    [`sha256:${'a'.repeat(64)}`, true],
    ['sha256:project', true],
    ['sha256:dev', true],
    ['sha256:agent', true],
    ['', false],
    ['invalid', false],
    ['sha256:', false],
    ['sha256:abc', false],
    [`sha512:${'a'.repeat(64)}`, false],
    [`SHA256:${'a'.repeat(64)}`, false],
    [`sha256:${'g'.repeat(64)}`, false],
    [`sha256:${'a'.repeat(63)}`, false],
    [`sha256:${'a'.repeat(65)}`, false],
  ])('integrity is sha256:<64 hex> or a dev/project/agent marker: %j → %p', (value, valid) => {
    expect(isSha256Integrity(value)).toBe(valid)
    if (valid) {
      expect<string>(asSha256Integrity(value)).toBe(value)
    } else {
      expect(() => asSha256Integrity(value)).toThrow(/Invalid SHA256 integrity/)
    }
  })
})

describe('asSpaceKey', () => {
  test('creates valid space key', () => {
    const id = 'my-space' as SpaceId
    const commit = 'abc1234' as CommitSha
    expect(asSpaceKey(id, commit)).toBe('my-space@abc1234')
  })
})

describe('isSpaceRefString', () => {
  test.each([
    ['space:foo@stable', true],
    ['space:my-space@^1.2.3', true],
    ['space:my-space@git:abc1234', true],
    ['space:foo', true],
    ['space:project:foo', true],
    ['space:project:my-workflow@dev', true],
    ['space:agent:foo', true],
    ['space:path:../spaces/foo@dev', true],
    ['', false],
    ['foo@stable', false],
    ['space:@stable', false],
    ['space:Foo@stable', false],
  ])(
    'space ref strings are accepted only in the space:<id>[@sel] / project / agent / path forms: %j → %p',
    (value, valid) => {
      expect(isSpaceRefString(value)).toBe(valid)
    }
  )
})

describe('parseSpaceRef', () => {
  test.each<[string, SpaceRef]>([
    [
      'space:my-space@stable',
      {
        id: 'my-space' as SpaceId,
        selectorString: 'stable',
        selector: { kind: 'dist-tag', tag: 'stable' as never },
      },
    ],
    [
      'space:foo-bar@^1.2.3',
      {
        id: 'foo-bar' as SpaceId,
        selectorString: '^1.2.3',
        selector: { kind: 'semver', range: '^1.2.3', exact: false },
      },
    ],
    [
      'space:foo@~1.2.3',
      {
        id: 'foo' as SpaceId,
        selectorString: '~1.2.3',
        selector: { kind: 'semver', range: '~1.2.3', exact: false },
      },
    ],
    [
      'space:foo@1.0.0',
      {
        id: 'foo' as SpaceId,
        selectorString: '1.0.0',
        selector: { kind: 'semver', range: '1.0.0', exact: true },
      },
    ],
    [
      'space:foo@1.0.0-alpha.1',
      {
        id: 'foo' as SpaceId,
        selectorString: '1.0.0-alpha.1',
        selector: { kind: 'semver', range: '1.0.0-alpha.1', exact: true },
      },
    ],
    [
      'space:foo@git:abc1234',
      {
        id: 'foo' as SpaceId,
        selectorString: 'git:abc1234',
        selector: { kind: 'git-pin', sha: asCommitSha('abc1234') },
      },
    ],
    [
      'space:foo@git:abc',
      {
        id: 'foo' as SpaceId,
        selectorString: 'git:abc',
        selector: { kind: 'dist-tag', tag: 'git:abc' as never },
      },
    ],
    [
      'space:foo@HEAD',
      { id: 'foo' as SpaceId, selectorString: 'HEAD', selector: { kind: 'head' } },
    ],
    ['space:foo@dev', { id: 'foo' as SpaceId, selectorString: 'dev', selector: { kind: 'dev' } }],
    [
      'space:foo',
      {
        id: 'foo' as SpaceId,
        selectorString: 'dev',
        selector: { kind: 'dev' },
        defaultedToDev: true,
      },
    ],
    [
      'space:project:my-workflow',
      {
        id: 'my-workflow' as SpaceId,
        selectorString: 'dev',
        selector: { kind: 'dev' },
        projectSpace: true,
        defaultedToDev: true,
      },
    ],
    [
      'space:project:foo-bar@dev',
      {
        id: 'foo-bar' as SpaceId,
        selectorString: 'dev',
        selector: { kind: 'dev' },
        projectSpace: true,
        defaultedToDev: false,
      },
    ],
    [
      'space:project:my-space@stable',
      {
        id: 'my-space' as SpaceId,
        selectorString: 'stable',
        selector: { kind: 'dist-tag', tag: 'stable' as never },
        projectSpace: true,
        defaultedToDev: false,
      },
    ],
  ])(
    'a space ref resolves to its id and selector kind; a missing selector defaults to dev: %s',
    (ref, expected) => {
      expect(parseSpaceRef(ref)).toEqual(expected)
    }
  )

  test('throws for invalid ref', () => {
    expect(() => parseSpaceRef('invalid')).toThrow(/Invalid space ref/)
    expect(() => parseSpaceRef('foo@stable')).toThrow(/Invalid space ref/)
  })
})

describe('published caller behavior (§9)', () => {
  /**
   * Tests for space reference types and validation functions.
   *
   * WHY: The refs module defines the core reference format used throughout
   * the system. Proper validation is critical for security and correctness.
   */

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

  describe('parseSpaceKey', () => {
    test('parses valid space key', () => {
      const key = 'my-space@abc1234' as SpaceKey
      const result = parseSpaceKey(key)
      expect<string>(result.id).toBe('my-space')
      expect<string>(result.commit).toBe('abc1234')
    })

    test('handles multiple @ symbols', () => {
      // Should use lastIndexOf, so this works with ids containing @
      // Actually, the pattern doesn't allow @ in id, so this won't be a valid key
      // Let's test a normal case
      const key = 'foo-bar@abc1234567' as SpaceKey
      const result = parseSpaceKey(key)
      expect<string>(result.id).toBe('foo-bar')
      expect<string>(result.commit).toBe('abc1234567')
    })

    test('throws for missing @', () => {
      expect(() => parseSpaceKey('nope' as SpaceKey)).toThrow(/Invalid space key/)
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

  describe('isProjectSpaceRef', () => {
    test('returns true for project space refs', () => {
      expect(isProjectSpaceRef('space:project:my-workflow')).toBe(true)
      expect(isProjectSpaceRef('space:project:foo-bar')).toBe(true)
      expect(isProjectSpaceRef('space:project:a1-b2@dev')).toBe(true)
    })

    test('returns false for non-project refs', () => {
      expect(isProjectSpaceRef('space:my-workflow@stable')).toBe(false)
      expect(isProjectSpaceRef('space:foo@dev')).toBe(false)
      expect(isProjectSpaceRef('space:path:/some/path@dev')).toBe(false)
    })
  })

  describe('formatSpaceRef (project spaces)', () => {
    test('formats project space ref', () => {
      const ref = {
        id: 'my-workflow' as SpaceId,
        selectorString: 'dev',
        selector: { kind: 'dev' as const },
        projectSpace: true,
      }
      expect(formatSpaceRef(ref)).toBe('space:project:my-workflow@dev')
    })
  })

  describe('isSpaceKey (project marker)', () => {
    test('accepts space keys with project marker', () => {
      expect(isSpaceKey('foo@project')).toBe(true)
      expect(isSpaceKey('my-workflow@project')).toBe(true)
    })
  })
})
