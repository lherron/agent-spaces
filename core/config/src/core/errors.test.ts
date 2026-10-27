import {
  ClaudeError,
  IntegrityError,
  RefParseError,
  ResolutionError,
  StoreError,
  isClaudeError,
  isGitError,
  isResolutionError,
  isStoreError,
} from './errors.js'
/**
 * Tests for error classes and type guards.
 *
 * WHY: Error messages are what a user sees when config, resolution, store,
 * lock, git or Claude operations fail. These tests pin the message templates
 * and the type guards the CLI uses to classify errors.
 */

import { describe, expect, test } from 'bun:test'

import {
  AspError,
  ClaudeInvocationError,
  ClaudeNotFoundError,
  ConfigError,
  ConfigParseError,
  ConfigValidationError,
  CyclicDependencyError,
  GitError,
  LockError,
  LockTimeoutError,
  MaterializationError,
  MissingDependencyError,
  SelectorResolutionError,
  SnapshotError,
  isAspError,
  isConfigError,
} from './errors.js'

describe('error messages', () => {
  const validationErrors = [
    { path: '/schema', message: 'required', keyword: 'required', params: {} },
    { path: '/id', message: 'invalid format', keyword: 'pattern', params: {} },
  ]

  test.each<{
    name: string
    build: () => AspError
    code: string
    messageParts: string[]
    instanceOf?: abstract new (...args: never[]) => unknown
  }>([
    {
      name: 'ConfigValidationError joins every validation error path and message',
      build: () => new ConfigValidationError('validation failed', 'space.toml', validationErrors),
      code: 'CONFIG_VALIDATION_ERROR',
      messageParts: ['validation failed', '/schema: required', '/id: invalid format'],
    },
    {
      name: 'SelectorResolutionError names space:<id>@<selector>',
      build: () => new SelectorResolutionError('not found', 'my-space', 'stable'),
      code: 'SELECTOR_RESOLUTION_ERROR',
      messageParts: ['space:my-space@stable'],
    },
    {
      name: 'CyclicDependencyError draws the cycle with arrows',
      build: () => new CyclicDependencyError(['a', 'b', 'c', 'a']),
      code: 'CYCLIC_DEPENDENCY_ERROR',
      messageParts: ['a -> b -> c -> a'],
    },
    {
      name: 'MissingDependencyError names both space ids',
      build: () => new MissingDependencyError('my-space', 'missing-dep'),
      code: 'MISSING_DEPENDENCY_ERROR',
      messageParts: ['my-space', 'missing-dep'],
    },
    {
      name: 'SnapshotError names <space>@<commit>',
      build: () => new SnapshotError('extraction failed', 'my-space', 'abc1234'),
      code: 'SNAPSHOT_ERROR',
      messageParts: ['my-space@abc1234'],
    },
    {
      name: 'MaterializationError names the space id and the cause',
      build: () => new MaterializationError('plugin build failed', 'my-space'),
      code: 'MATERIALIZATION_ERROR',
      messageParts: ['my-space', 'plugin build failed'],
    },
    {
      name: 'LockError names the lock path',
      build: () => new LockError('lock failed', '/path/to/lock'),
      code: 'LOCK_ERROR',
      messageParts: ['/path/to/lock'],
    },
    {
      name: 'LockTimeoutError names the timeout in ms and is a LockError',
      build: () => new LockTimeoutError('/path/to/lock', 5000),
      code: 'LOCK_ERROR',
      messageParts: ['5000ms'],
      instanceOf: LockError,
    },
    {
      name: 'GitError names the exit code, command and stderr',
      build: () => new GitError('git status', 128, 'not a git repository'),
      code: 'GIT_ERROR',
      messageParts: ['git status', 'exit 128', 'not a git repository'],
    },
    {
      name: 'ClaudeNotFoundError lists every searched path',
      build: () => new ClaudeNotFoundError(['/usr/bin/claude', '/opt/homebrew/bin/claude']),
      code: 'CLAUDE_NOT_FOUND_ERROR',
      messageParts: ['/usr/bin/claude', '/opt/homebrew/bin/claude'],
    },
    {
      name: 'ClaudeInvocationError names the exit code and stderr',
      build: () => new ClaudeInvocationError(1, 'command failed'),
      code: 'CLAUDE_INVOCATION_ERROR',
      messageParts: ['exited with code 1', 'command failed'],
    },
  ])(
    'AspError subclasses render their identifying fields into the message a user sees: $name',
    ({ build, code, messageParts, instanceOf }) => {
      const error = build()
      for (const part of messageParts) {
        expect(error.message).toContain(part)
      }
      expect(error.code).toBe(code)
      if (instanceOf) {
        expect(error).toBeInstanceOf(instanceOf)
      }
    }
  )
})

describe('Type guards', () => {
  test('isAspError', () => {
    expect(isAspError(new AspError('test', 'CODE'))).toBe(true)
    expect(isAspError(new ConfigError('test', 'CODE', 'src'))).toBe(true)
    expect(isAspError(new Error('test'))).toBe(false)
    expect(isAspError('not an error')).toBe(false)
    expect(isAspError(null)).toBe(false)
    expect(isAspError(undefined)).toBe(false)
  })

  test('isConfigError', () => {
    expect(isConfigError(new ConfigError('test', 'CODE', 'src'))).toBe(true)
    expect(isConfigError(new ConfigParseError('test', 'src'))).toBe(true)
    expect(isConfigError(new AspError('test', 'CODE'))).toBe(false)
  })
})

describe('published caller behavior (§9)', () => {
  /**
   * Tests for error classes and type guards.
   *
   * WHY: Error types are critical for proper error handling throughout
   * the system. These tests verify error construction and type guards.
   */

  describe('Resolution errors', () => {
    test('RefParseError includes refString', () => {
      const error = new RefParseError('invalid ref', 'bad:ref')
      expect(error.message).toContain('bad:ref')
      expect(error.refString).toBe('bad:ref')
      expect(error.code).toBe('REF_PARSE_ERROR')
      expect(error instanceof ResolutionError).toBe(true)
    })
  })

  describe('Store errors', () => {
    test('IntegrityError includes path and hashes', () => {
      const error = new IntegrityError('/path/to/file', 'sha256:expected', 'sha256:actual')
      expect(error.message).toContain('/path/to/file')
      expect(error.message).toContain('sha256:expected')
      expect(error.message).toContain('sha256:actual')
      expect(error.path).toBe('/path/to/file')
      expect(error.expected).toBe('sha256:expected')
      expect(error.actual).toBe('sha256:actual')
      expect(error.code).toBe('INTEGRITY_ERROR')
      expect(error instanceof StoreError).toBe(true)
    })
  })

  describe('Type guards', () => {
    test('isResolutionError', () => {
      expect(isResolutionError(new ResolutionError('test', 'CODE'))).toBe(true)
      expect(isResolutionError(new RefParseError('test', 'ref'))).toBe(true)
      expect(isResolutionError(new CyclicDependencyError(['a', 'b']))).toBe(true)
      expect(isResolutionError(new AspError('test', 'CODE'))).toBe(false)
    })

    test('isStoreError', () => {
      expect(isStoreError(new StoreError('test', 'CODE'))).toBe(true)
      expect(isStoreError(new IntegrityError('path', 'exp', 'act'))).toBe(true)
      expect(isStoreError(new AspError('test', 'CODE'))).toBe(false)
    })

    test('isGitError', () => {
      expect(isGitError(new GitError('cmd', 1, 'stderr'))).toBe(true)
      expect(isGitError(new AspError('test', 'CODE'))).toBe(false)
    })

    test('isClaudeError', () => {
      expect(isClaudeError(new ClaudeError('test'))).toBe(true)
      expect(isClaudeError(new ClaudeNotFoundError([]))).toBe(true)
      expect(isClaudeError(new ClaudeInvocationError(1, ''))).toBe(true)
      expect(isClaudeError(new AspError('test', 'CODE'))).toBe(false)
    })
  })
})
