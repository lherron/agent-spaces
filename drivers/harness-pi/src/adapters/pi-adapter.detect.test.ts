import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAdapter, PiNotFoundError, clearPiCache, findPiBinary } from './pi-adapter.js'

const piPathOverrides = ['PI_PATH', 'ASP_PI_PATH'] as const
let tmpDir: string
let mockPiPath: string
let savedOverrides: (string | undefined)[]

beforeEach(async () => {
  savedOverrides = piPathOverrides.map((key) => process.env[key])
  for (const key of piPathOverrides) {
    Reflect.deleteProperty(process.env, key)
  }
  clearPiCache()
  tmpDir = await mkdtemp(join(tmpdir(), 'pi-detect-'))
  mockPiPath = join(tmpDir, 'mock-pi')
})

afterEach(async () => {
  for (const [index, key] of piPathOverrides.entries()) {
    const saved = savedOverrides[index]
    if (saved === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = saved
  }
  clearPiCache()
  await rm(tmpDir, { recursive: true, force: true })
})

async function writeMockPi(path: string, version: string, helpLines: string[] = []) {
  const help = helpLines.map((line) => `  echo "${line}"`).join('\n')
  await writeFile(
    path,
    `#!/bin/bash
if [[ "$1" == "--version" ]]; then
  echo "${version}"
  exit 0
fi
if [[ "$1" == "--help" ]]; then
${help}
  exit 0
fi
exit 0
`
  )
  await chmod(path, 0o755)
}

describe('PiAdapter', () => {
  const adapter = new PiAdapter()

  describe('id and name', () => {
    test('has correct id', () => {
      expect(adapter.id).toBe('agent-harness')
    })

    test('has correct name', () => {
      expect(adapter.name).toBe('Agent Harness')
    })
  })

  describe('detect', () => {
    test('returns available: true when pi is found', async () => {
      // Create a mock pi that outputs version info and help
      await writeMockPi(mockPiPath, '1.2.3', [
        '--extension  Load an extension',
        '--skills     Skills directory',
      ])
      process.env['PI_PATH'] = mockPiPath

      const result = await adapter.detect()

      expect(result.available).toBe(true)
      expect(result.path).toBe(mockPiPath)
    })

    test('returns version when detected', async () => {
      await writeMockPi(mockPiPath, '2.0.1')
      process.env['PI_PATH'] = mockPiPath

      const result = await adapter.detect()

      expect(result.available).toBe(true)
      expect(result.version).toBe('2.0.1')
    })

    test('returns available: false when pi is not found', async () => {
      // Point to non-existent binary
      process.env['PI_PATH'] = '/nonexistent/pi'

      const result = await adapter.detect()

      expect(result.available).toBe(false)
      expect(result.error).toBeDefined()
    })

    test('ASP_PI_PATH takes precedence over PI_PATH', async () => {
      await writeMockPi(mockPiPath, '3.1.4')
      // The canonical ASP_PI_PATH override must win (mirrors ASP_CLAUDE_PATH/ASP_CODEX_PATH).
      process.env['ASP_PI_PATH'] = mockPiPath
      process.env['PI_PATH'] = '/nonexistent/pi'

      const result = await adapter.detect()

      expect(result.available).toBe(true)
      expect(result.path).toBe(mockPiPath)
    })

    test('includes capabilities when available', async () => {
      await writeMockPi(mockPiPath, '1.0.0', [
        '--extension  Load extensions',
        '--skills     Skills directory',
      ])
      process.env['PI_PATH'] = mockPiPath

      const result = await adapter.detect()

      expect(result.available).toBe(true)
      expect(result.capabilities).toBeDefined()
      expect(result.capabilities).toContain('extensions')
      expect(result.capabilities).toContain('skills')
      expect(result.capabilities).toContain('toolNamespacing')
    })
  })
})

describe('Pi detection utilities', () => {
  describe('findPiBinary', () => {
    test('uses PI_PATH environment variable when set', async () => {
      await writeFile(mockPiPath, '#!/bin/bash\nexit 0')
      await chmod(mockPiPath, 0o755)
      process.env['PI_PATH'] = mockPiPath

      const path = await findPiBinary()

      expect(path).toBe(mockPiPath)
    })

    test.each([
      ['throws PiNotFoundError when PI_PATH is invalid', '/nonexistent/path/to/pi'],
      [
        'throws PiNotFoundError when PI_PATH points to non-existent file',
        '/definitely/nonexistent/path/that/does/not/exist/pi',
      ],
    ])('%s', async (_name, path) => {
      process.env['PI_PATH'] = path

      await expect(findPiBinary()).rejects.toThrow(PiNotFoundError)
    })

    test('finds a non-executable `pi.js`-style entrypoint on PATH (run via bun)', async () => {
      // A `pi` entrypoint on PATH that is a .js file (run via bun) and is NOT
      // marked executable must still be detected — the PATH search uses the
      // same isUsablePiEntrypoint predicate as the common-paths loop.
      const originalPath = process.env['PATH']
      const pathDir = join(tmpDir, 'path-js-bin')
      await mkdir(pathDir, { recursive: true })
      // A `pi.js` entrypoint, written WITHOUT the executable bit (run via bun).
      // The old isExecutable-only PATH search missed this; the shared
      // isUsablePiEntrypoint predicate accepts it because the .js file exists.
      const piJsPath = join(pathDir, 'pi.js')
      await writeFile(piJsPath, 'console.log("0.0.0")')
      await chmod(piJsPath, 0o644)

      // Isolate PATH to just our dir so the real `pi` (if installed) can't win.
      process.env['PATH'] = pathDir

      try {
        const path = await findPiBinary()
        expect(path).toBe(piJsPath)
      } finally {
        if (originalPath !== undefined) process.env['PATH'] = originalPath
        else Reflect.deleteProperty(process.env, 'PATH')
      }
    })
  })
})

describe('detect capability inference', () => {
  test('omits extension/skill capabilities when --help advertises neither flag', async () => {
    const adapter = new PiAdapter()
    // --help succeeds but never mentions --extension or --skills, so the
    // capability probes should resolve to false.
    await writeMockPi(mockPiPath, '1.0.0', ['usage: pi [--model MODEL]'])
    process.env['PI_PATH'] = mockPiPath

    const result = await adapter.detect()

    expect(result.available).toBe(true)
    expect(result.capabilities).not.toContain('extensions')
    expect(result.capabilities).not.toContain('skills')
    // toolNamespacing is always advertised.
    expect(result.capabilities).toContain('toolNamespacing')
  })

  test('detects skills capability from the real pi flag (--skill / --no-skills, not --skills)', async () => {
    const adapter = new PiAdapter()
    // The real pi CLI advertises `--skill <path>` and `--no-skills`, and never
    // the string `--skills`. The probe must look for `--skill`; probing the old
    // `--skills` would (incorrectly) miss this help text and report no skills.
    await writeMockPi(mockPiPath, '1.0.0', [
      '  --extension, -e <path>    Load an extension file',
      '  --skill <path>            Load a skill file or directory',
      '  --no-skills, -ns          Disable skills discovery and loading',
    ])
    process.env['PI_PATH'] = mockPiPath

    const result = await adapter.detect()

    expect(result.available).toBe(true)
    expect(result.capabilities).toContain('extensions')
    expect(result.capabilities).toContain('skills')
  })
})

describe('Error classes', () => {
  describe('PiNotFoundError', () => {
    test('includes searched paths in message', () => {
      const error = new PiNotFoundError(['/usr/bin/pi', '/usr/local/bin/pi'])

      expect(error.message).toContain('/usr/bin/pi')
      expect(error.message).toContain('/usr/local/bin/pi')
      expect(error.name).toBe('PiNotFoundError')
    })
  })
})
