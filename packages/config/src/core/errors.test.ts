/**
 * Tests for error classes and type guards.
 *
 * WHY: Error types are critical for proper error handling throughout
 * the system. These tests verify error construction and type guards.
 */

import { describe, expect, test } from 'bun:test'

import {
  AspError,
  ClaudeError,
  ClaudeInvocationError,
  ClaudeNotFoundError,
  ConfigError,
  ConfigParseError,
  ConfigValidationError,
  CyclicDependencyError,
  GitError,
  IntegrityError,
  LockError,
  LockTimeoutError,
  MaterializationError,
  MissingDependencyError,
  RefParseError,
  ResolutionError,
  SelectorResolutionError,
  SnapshotError,
  StoreError,
  isAspError,
  isClaudeError,
  isConfigError,
  isGitError,
  isResolutionError,
  isStoreError,
} from './errors.js'

describe('AspError', () => {
  test('creates error with message and code', () => {
    const error = new AspError('test message', 'TEST_CODE')
    expect(error.message).toBe('test message')
    expect(error.code).toBe('TEST_CODE')
    expect(error.name).toBe('AspError')
    expect(error instanceof Error).toBe(true)
  })
})

describe('Configuration errors', () => {
  test('ConfigError has source', () => {
    const error = new ConfigError('test', 'CODE', 'source.toml')
    expect(error.source).toBe('source.toml')
    expect(error instanceof AspError).toBe(true)
  })

  test('ConfigParseError', () => {
    const error = new ConfigParseError('parse failed', 'config.toml')
    expect(error.message).toBe('parse failed')
    expect(error.code).toBe('CONFIG_PARSE_ERROR')
    expect(error.source).toBe('config.toml')
    expect(error instanceof ConfigError).toBe(true)
  })

  test('ConfigValidationError with validation errors', () => {
    const validationErrors = [
      { path: '/schema', message: 'required', keyword: 'required', params: {} },
      { path: '/id', message: 'invalid format', keyword: 'pattern', params: {} },
    ]
    const error = new ConfigValidationError('validation failed', 'space.toml', validationErrors)
    expect(error.message).toContain('validation failed')
    expect(error.message).toContain('/schema: required')
    expect(error.message).toContain('/id: invalid format')
    expect(error.validationErrors).toEqual(validationErrors)
    expect(error.code).toBe('CONFIG_VALIDATION_ERROR')
  })
})

describe('Resolution errors', () => {
  test('RefParseError includes refString', () => {
    const error = new RefParseError('invalid ref', 'bad:ref')
    expect(error.message).toContain('bad:ref')
    expect(error.refString).toBe('bad:ref')
    expect(error.code).toBe('REF_PARSE_ERROR')
    expect(error instanceof ResolutionError).toBe(true)
  })

  test('SelectorResolutionError includes spaceId and selector', () => {
    const error = new SelectorResolutionError('not found', 'my-space', 'stable')
    expect(error.message).toContain('space:my-space@stable')
    expect(error.spaceId).toBe('my-space')
    expect(error.selector).toBe('stable')
    expect(error.code).toBe('SELECTOR_RESOLUTION_ERROR')
  })

  test('CyclicDependencyError includes cycle', () => {
    const cycle = ['a', 'b', 'c', 'a']
    const error = new CyclicDependencyError(cycle)
    expect(error.message).toContain('a -> b -> c -> a')
    expect(error.cycle).toEqual(cycle)
    expect(error.code).toBe('CYCLIC_DEPENDENCY_ERROR')
  })

  test('MissingDependencyError includes spaceId and dependsOn', () => {
    const error = new MissingDependencyError('my-space', 'missing-dep')
    expect(error.message).toContain('my-space')
    expect(error.message).toContain('missing-dep')
    expect(error.spaceId).toBe('my-space')
    expect(error.dependsOn).toBe('missing-dep')
    expect(error.code).toBe('MISSING_DEPENDENCY_ERROR')
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

  test('SnapshotError includes spaceId and commit', () => {
    const error = new SnapshotError('extraction failed', 'my-space', 'abc1234')
    expect(error.message).toContain('my-space@abc1234')
    expect(error.spaceId).toBe('my-space')
    expect(error.commit).toBe('abc1234')
    expect(error.code).toBe('SNAPSHOT_ERROR')
  })
})

describe('MaterializationError', () => {
  test('includes spaceId', () => {
    const error = new MaterializationError('plugin build failed', 'my-space')
    expect(error.message).toContain('my-space')
    expect(error.message).toContain('plugin build failed')
    expect(error.spaceId).toBe('my-space')
    expect(error.code).toBe('MATERIALIZATION_ERROR')
  })
})

describe('Lock errors', () => {
  test('LockError includes lockPath', () => {
    const error = new LockError('lock failed', '/path/to/lock')
    expect(error.message).toContain('/path/to/lock')
    expect(error.lockPath).toBe('/path/to/lock')
    expect(error.code).toBe('LOCK_ERROR')
  })

  test('LockTimeoutError includes timeout', () => {
    const error = new LockTimeoutError('/path/to/lock', 5000)
    expect(error.message).toContain('5000ms')
    expect(error.lockPath).toBe('/path/to/lock')
    expect(error.timeout).toBe(5000)
    expect(error instanceof LockError).toBe(true)
  })
})

describe('GitError', () => {
  test('includes command, exitCode, and stderr', () => {
    const error = new GitError('git status', 128, 'not a git repository')
    expect(error.message).toContain('git status')
    expect(error.message).toContain('exit 128')
    expect(error.message).toContain('not a git repository')
    expect(error.command).toBe('git status')
    expect(error.exitCode).toBe(128)
    expect(error.stderr).toBe('not a git repository')
    expect(error.code).toBe('GIT_ERROR')
  })
})

describe('Claude errors', () => {
  test('ClaudeNotFoundError includes searched paths', () => {
    const paths = ['/usr/bin/claude', '/opt/homebrew/bin/claude']
    const error = new ClaudeNotFoundError(paths)
    expect(error.message).toContain('/usr/bin/claude')
    expect(error.message).toContain('/opt/homebrew/bin/claude')
    expect(error.code).toBe('CLAUDE_NOT_FOUND_ERROR')
    expect(error instanceof ClaudeError).toBe(true)
  })

  test('ClaudeInvocationError includes exitCode and stderr', () => {
    const error = new ClaudeInvocationError(1, 'command failed')
    expect(error.message).toContain('exited with code 1')
    expect(error.message).toContain('command failed')
    expect(error.exitCode).toBe(1)
    expect(error.stderr).toBe('command failed')
    expect(error.code).toBe('CLAUDE_INVOCATION_ERROR')
  })
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

describe('Error inheritance chain', () => {
  test('all errors extend Error', () => {
    expect(new AspError('', '') instanceof Error).toBe(true)
    expect(new ConfigError('', '', '') instanceof Error).toBe(true)
    expect(new ResolutionError('', '') instanceof Error).toBe(true)
    expect(new StoreError('', '') instanceof Error).toBe(true)
    expect(new GitError('', 0, '') instanceof Error).toBe(true)
    expect(new ClaudeError('') instanceof Error).toBe(true)
    expect(new LockError('', '') instanceof Error).toBe(true)
    expect(new MaterializationError('', '') instanceof Error).toBe(true)
  })
})
