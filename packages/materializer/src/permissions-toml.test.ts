/**
 * Tests for permissions.toml parsing and translation
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CLAUDE_ENFORCEMENT,
  type CanonicalPermissions,
  PI_ENFORCEMENT,
  buildPiToolsList,
  explainPermissions,
  hasPermissions,
  normalizeExecToClaudeRules,
  normalizePaths,
  parsePermissionsToml,
  permissionsTomlExists,
  readPermissions,
  readPermissionsToml,
  toClaudePermissions,
  toClaudeSettingsPermissions,
  toPiPermissions,
} from './permissions-toml.js'

describe('parsePermissionsToml', () => {
  it('parses a valid permissions.toml with all sections', () => {
    const content = `
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
`

    const result = parsePermissionsToml(content)

    expect(result.read?.paths).toEqual(['.', '~/.config/myapp', '/etc/hosts'])
    expect(result.write?.paths).toEqual(['./src', './tests', './dist'])
    expect(result.exec?.commands).toEqual(['npm', 'bun', 'git'])
    expect(result.exec?.patterns).toEqual(['npm run *', 'bun test *'])
    expect(result.network?.hosts).toEqual(['api.example.com:443', '*.npmjs.org:443'])
    expect(result.deny?.read).toEqual(['.env', '.env.local', '**/*.pem'])
    expect(result.deny?.write).toEqual(['package-lock.json'])
    expect(result.deny?.exec).toEqual(['rm -rf /', 'sudo *'])
    expect(result.deny?.network).toEqual(['malicious.com'])
  })

  it('parses permissions.toml with only read section', () => {
    const content = `
[read]
paths = [".", "./src"]
`

    const result = parsePermissionsToml(content)

    expect(result.read?.paths).toEqual(['.', './src'])
    expect(result.write).toBeUndefined()
    expect(result.exec).toBeUndefined()
    expect(result.network).toBeUndefined()
    expect(result.deny).toBeUndefined()
  })

  it('parses permissions.toml with only exec section', () => {
    const content = `
[exec]
commands = ["npm", "bun"]
`

    const result = parsePermissionsToml(content)

    expect(result.exec?.commands).toEqual(['npm', 'bun'])
    expect(result.exec?.patterns).toBeUndefined()
  })

  it('parses permissions.toml with only deny section', () => {
    const content = `
[deny]
read = [".env"]
exec = ["sudo *"]
`

    const result = parsePermissionsToml(content)

    expect(result.deny?.read).toEqual(['.env'])
    expect(result.deny?.exec).toEqual(['sudo *'])
    expect(result.deny?.write).toBeUndefined()
    expect(result.deny?.network).toBeUndefined()
  })

  it('returns empty object when no sections defined', () => {
    const content = '# Empty permissions file'
    const result = parsePermissionsToml(content)
    expect(result).toEqual({})
  })
})

describe('normalizePaths', () => {
  it('returns empty array for undefined input', () => {
    expect(normalizePaths(undefined)).toEqual([])
  })

  it('returns empty array for empty array', () => {
    expect(normalizePaths([])).toEqual([])
  })

  it('trims whitespace from paths', () => {
    expect(normalizePaths(['  ./src  ', '  ./tests  '])).toEqual(['./src', './tests'])
  })

  it('filters out empty strings', () => {
    expect(normalizePaths(['./src', '', '  ', './tests'])).toEqual(['./src', './tests'])
  })
})

describe('normalizeExecToClaudeRules', () => {
  it('converts commands to Bash() rules', () => {
    const result = normalizeExecToClaudeRules(['npm', 'bun'], undefined)
    expect(result).toEqual(['Bash(npm *)', 'Bash(bun *)'])
  })

  it('converts patterns to Bash() rules', () => {
    const result = normalizeExecToClaudeRules(undefined, ['npm run *', 'bun test *'])
    expect(result).toEqual(['Bash(npm run *)', 'Bash(bun test *)'])
  })

  it('combines commands and patterns', () => {
    const result = normalizeExecToClaudeRules(['npm'], ['npm run *'])
    expect(result).toEqual(['Bash(npm *)', 'Bash(npm run *)'])
  })

  it('returns empty array for no input', () => {
    expect(normalizeExecToClaudeRules(undefined, undefined)).toEqual([])
  })

  it('trims whitespace', () => {
    const result = normalizeExecToClaudeRules(['  npm  '], ['  bun test *  '])
    expect(result).toEqual(['Bash(npm *)', 'Bash(bun test *)'])
  })
})

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

  it('translates exec commands and patterns with enforced level', () => {
    const permissions: CanonicalPermissions = {
      exec: {
        commands: ['npm', 'bun'],
        patterns: ['npm run *'],
      },
    }

    const result = toClaudePermissions(permissions)

    expect(result.exec?.value).toEqual(['Bash(npm *)', 'Bash(bun *)', 'Bash(npm run *)'])
    expect(result.exec?.enforcement).toBe('enforced')
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

  it('translates deny rules', () => {
    const permissions: CanonicalPermissions = {
      deny: {
        read: ['.env'],
        write: ['package-lock.json'],
        exec: ['sudo *'],
        network: ['malicious.com'],
      },
    }

    const result = toClaudePermissions(permissions)

    expect(result.deny?.read?.value).toEqual(['.env'])
    expect(result.deny?.read?.enforcement).toBe('enforced')
    expect(result.deny?.write?.value).toEqual(['package-lock.json'])
    expect(result.deny?.write?.enforcement).toBe('enforced')
    expect(result.deny?.exec?.value).toEqual(['Bash(sudo *)'])
    expect(result.deny?.exec?.enforcement).toBe('enforced')
    expect(result.deny?.network?.value).toEqual(['malicious.com'])
    expect(result.deny?.network?.enforcement).toBe('lint_only')
  })

  it('returns empty object for empty permissions', () => {
    const result = toClaudePermissions({})
    expect(result).toEqual({})
  })
})

describe('toClaudeSettingsPermissions', () => {
  it('builds allow rules from read and write', () => {
    const claudePerms = toClaudePermissions({
      read: { paths: ['.'] },
      write: { paths: ['./src'] },
    })

    const result = toClaudeSettingsPermissions(claudePerms)

    expect(result.allow).toContain('Read')
    expect(result.allow).toContain('Write')
  })

  it('includes exec rules in allow', () => {
    const claudePerms = toClaudePermissions({
      exec: { commands: ['npm'] },
    })

    const result = toClaudeSettingsPermissions(claudePerms)

    expect(result.allow).toContain('Bash(npm *)')
  })

  it('builds deny rules from deny section', () => {
    const claudePerms = toClaudePermissions({
      deny: {
        read: ['.env'],
        write: ['secrets.json'],
        exec: ['sudo *'],
      },
    })

    const result = toClaudeSettingsPermissions(claudePerms)

    expect(result.deny).toContain('Read(.env)')
    expect(result.deny).toContain('Write(secrets.json)')
    expect(result.deny).toContain('Bash(sudo *)')
  })

  it('returns empty object for empty permissions', () => {
    const result = toClaudeSettingsPermissions({})
    expect(result).toEqual({})
  })
})

describe('toPiPermissions', () => {
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

  it('translates exec with best_effort level', () => {
    const permissions: CanonicalPermissions = {
      exec: {
        commands: ['npm', 'bun'],
        patterns: ['npm run *'],
      },
    }

    const result = toPiPermissions(permissions)

    expect(result.exec?.value).toEqual(['npm', 'bun', 'npm run *'])
    expect(result.exec?.enforcement).toBe('best_effort')
    expect(result.exec?.note).toContain('Best-effort')
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

describe('hasPermissions', () => {
  it('returns false for null', () => {
    expect(hasPermissions(null)).toBe(false)
  })

  it('returns false for empty object', () => {
    expect(hasPermissions({})).toBe(false)
  })

  it('returns true for read paths', () => {
    expect(hasPermissions({ read: { paths: ['.'] } })).toBe(true)
  })

  it('returns true for write paths', () => {
    expect(hasPermissions({ write: { paths: ['./src'] } })).toBe(true)
  })

  it('returns true for exec commands', () => {
    expect(hasPermissions({ exec: { commands: ['npm'] } })).toBe(true)
  })

  it('returns true for exec patterns', () => {
    expect(hasPermissions({ exec: { patterns: ['npm run *'] } })).toBe(true)
  })

  it('returns true for network hosts', () => {
    expect(hasPermissions({ network: { hosts: ['example.com'] } })).toBe(true)
  })

  it('returns true for deny rules', () => {
    expect(hasPermissions({ deny: { read: ['.env'] } })).toBe(true)
    expect(hasPermissions({ deny: { write: ['secrets.json'] } })).toBe(true)
    expect(hasPermissions({ deny: { exec: ['sudo *'] } })).toBe(true)
    expect(hasPermissions({ deny: { network: ['malicious.com'] } })).toBe(true)
  })

  it('returns false for empty arrays', () => {
    expect(hasPermissions({ read: { paths: [] } })).toBe(false)
    expect(hasPermissions({ deny: { read: [] } })).toBe(false)
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

describe('enforcement constants', () => {
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

describe('readPermissionsToml / permissionsTomlExists', () => {
  const testDir = join(import.meta.dir, '../../.test-permissions-toml')
  const spaceRoot = testDir

  beforeEach(async () => {
    await mkdir(spaceRoot, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('reads permissions.toml from directory', async () => {
    const tomlContent = `
[read]
paths = [".", "./src"]

[exec]
commands = ["npm"]
`
    await writeFile(join(spaceRoot, 'permissions.toml'), tomlContent)

    const result = await readPermissionsToml(spaceRoot)

    expect(result).not.toBeNull()
    expect(result?.read?.paths).toEqual(['.', './src'])
    expect(result?.exec?.commands).toEqual(['npm'])
  })

  it('returns null when permissions.toml does not exist', async () => {
    const result = await readPermissionsToml(spaceRoot)
    expect(result).toBeNull()
  })

  it('permissionsTomlExists returns true when file exists', async () => {
    await writeFile(join(spaceRoot, 'permissions.toml'), '[read]\npaths = ["."]')

    const result = await permissionsTomlExists(spaceRoot)
    expect(result).toBe(true)
  })

  it('permissionsTomlExists returns false when file does not exist', async () => {
    const result = await permissionsTomlExists(spaceRoot)
    expect(result).toBe(false)
  })
})

describe('readPermissions', () => {
  const testDir = join(import.meta.dir, '../../.test-read-permissions')
  const spaceRoot = testDir

  beforeEach(async () => {
    await mkdir(spaceRoot, { recursive: true })
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
