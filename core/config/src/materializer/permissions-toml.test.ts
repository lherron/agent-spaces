import { afterEach, beforeEach } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_ENFORCEMENT,
  PI_ENFORCEMENT,
  buildPiToolsList,
  explainPermissions,
  permissionsTomlExists,
  readPermissions,
  readPermissionsToml,
} from './permissions-toml.js'
/**
 * Tests for permissions.toml parsing and translation
 */

import { describe, expect, it } from 'bun:test'
import {
  type CanonicalPermissions,
  hasPermissions,
  normalizeExecToClaudeRules,
  normalizePaths,
  parsePermissionsToml,
  toClaudePermissions,
  toClaudeSettingsPermissions,
  toPiPermissions,
} from './permissions-toml.js'

const settingsFor = (permissions: CanonicalPermissions) =>
  toClaudeSettingsPermissions(toClaudePermissions(permissions))

const permissionsTomlCases: Array<[string, string, CanonicalPermissions, object]> = [
  [
    'every section',
    `
[read]
paths = [".", "~/.config/myapp", "/etc/hosts"]

[write]
paths = ["./src", "./tests", "./dist"]

[exec]
commands = ["npm", "bun", "git"]
patterns = ["npm run *", "bun test *"]

[network]
hosts = ["api.example.com:443", "*.npmjs.org:443"]

[deny]
read = [".env", ".env.local", "**/*.pem"]
write = ["package-lock.json"]
exec = ["rm -rf /", "sudo *"]
network = ["malicious.com"]
`,
    {
      read: { paths: ['.', '~/.config/myapp', '/etc/hosts'] },
      write: { paths: ['./src', './tests', './dist'] },
      exec: { commands: ['npm', 'bun', 'git'], patterns: ['npm run *', 'bun test *'] },
      network: { hosts: ['api.example.com:443', '*.npmjs.org:443'] },
      deny: {
        read: ['.env', '.env.local', '**/*.pem'],
        write: ['package-lock.json'],
        exec: ['rm -rf /', 'sudo *'],
        network: ['malicious.com'],
      },
    },
    {
      allow: [
        'Read',
        'Write',
        'Bash(npm *)',
        'Bash(bun *)',
        'Bash(git *)',
        'Bash(npm run *)',
        'Bash(bun test *)',
      ],
      deny: [
        'Read(.env)',
        'Read(.env.local)',
        'Read(**/*.pem)',
        'Write(package-lock.json)',
        'Bash(rm -rf /)',
        'Bash(sudo *)',
      ],
    },
  ],
  [
    'a deny-only file writes deny rules and no allow key',
    `
[deny]
read = [".env"]
exec = ["sudo *"]
`,
    { deny: { read: ['.env'], exec: ['sudo *'] } },
    { deny: ['Read(.env)', 'Bash(sudo *)'] },
  ],
  ['a comment-only file writes no permissions', '# Empty permissions file', {}, {}],
]

describe('parsePermissionsToml', () => {
  it.each(permissionsTomlCases)(
    'permissions.toml sections map into Claude settings.json allow and deny rules: %s',
    (_case, content, parsed, settings) => {
      const result = parsePermissionsToml(content)

      expect(result).toEqual(parsed)
      expect(settingsFor(result)).toStrictEqual(settings)
    }
  )
})

describe('normalizePaths', () => {
  it('padded and empty permissions.toml entries are trimmed or dropped before reaching settings.json', () => {
    expect(normalizePaths(['  ./src  ', '  ./tests  '])).toEqual(['./src', './tests'])
    expect(normalizePaths(['./src', '', '  ', './tests'])).toEqual(['./src', './tests'])
    expect(normalizeExecToClaudeRules(['  npm  '], ['  bun test *  '])).toEqual([
      'Bash(npm *)',
      'Bash(bun test *)',
    ])
  })
})

describe('normalizeExecToClaudeRules', () => {
  it('[exec] commands become Bash(cmd *) and patterns Bash(pattern) allow rules in settings.json', () => {
    expect(normalizeExecToClaudeRules(['npm'], ['npm run *'])).toEqual([
      'Bash(npm *)',
      'Bash(npm run *)',
    ])
    expect(
      settingsFor({ exec: { commands: ['npm', 'bun'], patterns: ['npm run *'] } })
    ).toStrictEqual({ allow: ['Bash(npm *)', 'Bash(bun *)', 'Bash(npm run *)'] })
  })
})

describe('toClaudeSettingsPermissions', () => {
  it('permissions.toml [deny] becomes Read(path), Write(path) and Bash(cmd) deny rules in settings.json, and deny.network is not written', () => {
    const result = settingsFor({
      deny: {
        read: ['.env'],
        write: ['secrets.json'],
        exec: ['sudo *'],
        network: ['malicious.com'],
      },
    })

    expect(result).toStrictEqual({
      deny: ['Read(.env)', 'Write(secrets.json)', 'Bash(sudo *)'],
    })
  })
})

describe('toPiPermissions', () => {
  it('Pi W304 names every lint-only permission facet and omits best-effort exec', () => {
    const result = toPiPermissions({
      read: { paths: ['.', './src'] },
      write: { paths: ['./dist'] },
      exec: { commands: ['npm', 'bun'], patterns: ['npm run *'] },
      network: { hosts: ['api.example.com:443'] },
      deny: {
        read: ['.env'],
        write: ['secrets.json'],
        exec: ['sudo *'],
        network: ['malicious.com'],
      },
    })

    expect(result).toMatchObject({
      read: {
        value: ['.', './src'],
        enforcement: 'lint_only',
        note: expect.stringContaining('no read restrictions'),
      },
      write: {
        value: ['./dist'],
        enforcement: 'lint_only',
        note: expect.stringContaining('no write restrictions'),
      },
      exec: {
        value: ['npm', 'bun', 'npm run *'],
        enforcement: 'best_effort',
        note: expect.stringContaining('Best-effort'),
      },
      network: {
        value: ['api.example.com:443'],
        enforcement: 'lint_only',
        note: expect.stringContaining('no network restrictions'),
      },
      deny: {
        read: { enforcement: 'lint_only' },
        write: { enforcement: 'lint_only' },
        exec: { enforcement: 'lint_only' },
        network: { enforcement: 'lint_only' },
      },
    })
  })
})

describe('hasPermissions', () => {
  it.each<[string, CanonicalPermissions, boolean]>([
    ['an empty file', {}, false],
    ['an empty read list', { read: { paths: [] } }, false],
    ['an empty deny.read list', { deny: { read: [] } }, false],
    ['read paths', { read: { paths: ['.'] } }, true],
    ['write paths', { write: { paths: ['./src'] } }, true],
    ['network hosts', { network: { hosts: ['example.com'] } }, true],
    ['deny.read', { deny: { read: ['.env'] } }, true],
    ['deny.write', { deny: { write: ['secrets.json'] } }, true],
    ['deny.exec', { deny: { exec: ['sudo *'] } }, true],
    ['deny.network', { deny: { network: ['malicious.com'] } }, true],
  ])(
    'a permissions.toml with only empty lists triggers no Pi permissions warning: %s -> %p',
    (_case, permissions, expected) => {
      expect(hasPermissions(permissions)).toBe(expected)
    }
  )
})

describe('published caller behavior (§9)', () => {
  /**
   * Tests for permissions.toml parsing and translation
   */

  describe('toClaudePermissions', () => {
    it('translates read paths with enforced level', () => {
      const permissions: CanonicalPermissions = {
        read: { paths: ['.', './src'] },
      }

      const result = toClaudePermissions(permissions)

      expect(result.read?.value).toEqual(['.', './src'])
      expect(result.read?.enforcement).toBe('enforced')
    })

    it('translates write paths with enforced level', () => {
      const permissions: CanonicalPermissions = {
        write: { paths: ['./dist', './build'] },
      }

      const result = toClaudePermissions(permissions)

      expect(result.write?.value).toEqual(['./dist', './build'])
      expect(result.write?.enforcement).toBe('enforced')
    })

    it('translates network hosts with lint_only level', () => {
      const permissions: CanonicalPermissions = {
        network: { hosts: ['api.example.com:443'] },
      }

      const result = toClaudePermissions(permissions)

      expect(result.network?.value).toEqual(['api.example.com:443'])
      expect(result.network?.enforcement).toBe('lint_only')
      expect(result.network?.note).toContain('lint-only')
    })
  })

  describe('buildPiToolsList', () => {
    it('returns default tools', () => {
      const result = buildPiToolsList({})
      expect(result).toContain('Read')
      expect(result).toContain('Write')
      expect(result).toContain('Bash')
      expect(result).toContain('Glob')
      expect(result).toContain('Grep')
    })

    it('returns default tools regardless of permissions', () => {
      const permissions: CanonicalPermissions = {
        exec: { commands: ['npm'] },
      }

      const result = buildPiToolsList(permissions)
      expect(result).toContain('Bash')
      expect(result).toContain('Read')
    })
  })

  describe('explainPermissions', () => {
    it('generates explanation for Claude permissions', () => {
      const permissions: CanonicalPermissions = {
        read: { paths: ['.', './src'] },
        exec: { commands: ['npm'] },
      }

      const lines = explainPermissions(permissions, 'claude')

      expect(lines.length).toBeGreaterThan(0)
      expect(lines.some((l) => l.includes('read'))).toBe(true)
      expect(lines.some((l) => l.includes('exec'))).toBe(true)
      expect(lines.some((l) => l.includes('ENFORCED'))).toBe(true)
    })

    it('generates explanation for Pi permissions', () => {
      const permissions: CanonicalPermissions = {
        read: { paths: ['.'] },
        exec: { commands: ['npm'] },
      }

      const lines = explainPermissions(permissions, 'pi')

      expect(lines.length).toBeGreaterThan(0)
      expect(lines.some((l) => l.includes('LINT_ONLY'))).toBe(true)
      expect(lines.some((l) => l.includes('BEST_EFFORT'))).toBe(true)
    })

    it('truncates long value lists', () => {
      const permissions: CanonicalPermissions = {
        read: { paths: ['path1', 'path2', 'path3', 'path4', 'path5'] },
      }

      const lines = explainPermissions(permissions, 'claude')

      expect(lines.some((l) => l.includes('+2 more'))).toBe(true)
    })
  })

  describe('readPermissions', () => {
    let testDir: string
    let spaceRoot: string

    beforeEach(async () => {
      testDir = await mkdtemp(join(tmpdir(), 'read-permissions-'))
      spaceRoot = testDir
    })

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true })
    })

    it('returns permissions and source path when file exists', async () => {
      const tomlContent = `
[read]
paths = ["."]
`
      await writeFile(join(spaceRoot, 'permissions.toml'), tomlContent)

      const result = await readPermissions(spaceRoot)

      expect(result.exists).toBe(true)
      expect(result.permissions?.read?.paths).toEqual(['.'])
      expect(result.sourcePath).toBe(join(spaceRoot, 'permissions.toml'))
    })

    it('returns null permissions when file does not exist', async () => {
      const result = await readPermissions(spaceRoot)

      expect(result.exists).toBe(false)
      expect(result.permissions).toBeNull()
      expect(result.sourcePath).toBeUndefined()
    })
  })

  describe('published permission results and enforcement', () => {
    it('translates read paths with lint_only level', () => {
      const permissions: CanonicalPermissions = {
        read: { paths: ['.', './src'] },
      }

      const result = toPiPermissions(permissions)

      expect(result.read?.value).toEqual(['.', './src'])
      expect(result.read?.enforcement).toBe('lint_only')
      expect(result.read?.note).toContain('no read restrictions')
    })
    it('translates write paths with lint_only level', () => {
      const permissions: CanonicalPermissions = {
        write: { paths: ['./dist'] },
      }

      const result = toPiPermissions(permissions)

      expect(result.write?.value).toEqual(['./dist'])
      expect(result.write?.enforcement).toBe('lint_only')
      expect(result.write?.note).toContain('no write restrictions')
    })
    it('translates network with lint_only level', () => {
      const permissions: CanonicalPermissions = {
        network: { hosts: ['api.example.com:443'] },
      }

      const result = toPiPermissions(permissions)

      expect(result.network?.value).toEqual(['api.example.com:443'])
      expect(result.network?.enforcement).toBe('lint_only')
      expect(result.network?.note).toContain('no network restrictions')
    })
    it('translates deny rules all with lint_only', () => {
      const permissions: CanonicalPermissions = {
        deny: {
          read: ['.env'],
          write: ['secrets.json'],
          exec: ['sudo *'],
          network: ['malicious.com'],
        },
      }

      const result = toPiPermissions(permissions)

      expect(result.deny?.read?.enforcement).toBe('lint_only')
      expect(result.deny?.write?.enforcement).toBe('lint_only')
      expect(result.deny?.exec?.enforcement).toBe('lint_only')
      expect(result.deny?.network?.enforcement).toBe('lint_only')
    })
    it('Claude enforcement levels are correct', () => {
      expect(CLAUDE_ENFORCEMENT['read']).toBe('enforced')
      expect(CLAUDE_ENFORCEMENT['write']).toBe('enforced')
      expect(CLAUDE_ENFORCEMENT['exec']).toBe('enforced')
      expect(CLAUDE_ENFORCEMENT['network']).toBe('lint_only')
      expect(CLAUDE_ENFORCEMENT['deny.read']).toBe('enforced')
      expect(CLAUDE_ENFORCEMENT['deny.write']).toBe('enforced')
      expect(CLAUDE_ENFORCEMENT['deny.exec']).toBe('enforced')
      expect(CLAUDE_ENFORCEMENT['deny.network']).toBe('lint_only')
    })
    it('Pi enforcement levels are correct', () => {
      expect(PI_ENFORCEMENT['read']).toBe('lint_only')
      expect(PI_ENFORCEMENT['write']).toBe('lint_only')
      expect(PI_ENFORCEMENT['exec']).toBe('best_effort')
      expect(PI_ENFORCEMENT['network']).toBe('lint_only')
      expect(PI_ENFORCEMENT['deny.read']).toBe('lint_only')
      expect(PI_ENFORCEMENT['deny.write']).toBe('lint_only')
      expect(PI_ENFORCEMENT['deny.exec']).toBe('lint_only')
      expect(PI_ENFORCEMENT['deny.network']).toBe('lint_only')
    })
  })

  describe('published permissions results', () => {
    it('returns empty array for undefined input', () => {
      expect(normalizePaths(undefined)).toEqual([])
    })
    it('returns empty array for empty array', () => {
      expect(normalizePaths([])).toEqual([])
    })
    it('returns empty array for no input', () => {
      expect(normalizeExecToClaudeRules(undefined, undefined)).toEqual([])
    })
    it('returns false for null', () => {
      expect(hasPermissions(null)).toBe(false)
    })
    it('returns true for exec commands', () => {
      expect(hasPermissions({ exec: { commands: ['npm'] } })).toBe(true)
    })
    it('returns true for exec patterns', () => {
      expect(hasPermissions({ exec: { patterns: ['npm run *'] } })).toBe(true)
    })
  })

  describe('missing permissions file', () => {
    let spaceRoot: string
    beforeEach(async () => {
      spaceRoot = await mkdtemp(join(tmpdir(), 'permissions-missing-'))
    })
    afterEach(async () => {
      await rm(spaceRoot, { recursive: true, force: true })
    })
    it('returns null when permissions.toml does not exist', async () => {
      const result = await readPermissionsToml(spaceRoot)
      expect(result).toBeNull()
    })
    it('permissionsTomlExists returns false when file does not exist', async () => {
      const result = await permissionsTomlExists(spaceRoot)
      expect(result).toBe(false)
    })
  })
})
