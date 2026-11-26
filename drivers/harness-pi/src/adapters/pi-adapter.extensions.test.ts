import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiBundleError, bundleExtension, discoverExtensions } from './pi-adapter.js'

describe('Extension bundling', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `pi-bundle-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  describe('bundleExtension', () => {
    test('bundles TypeScript to JavaScript', async () => {
      const srcPath = join(tmpDir, 'tool.ts')
      const outPath = join(tmpDir, 'tool.js')

      await writeFile(
        srcPath,
        `
export function hello(): string {
  return 'hello world';
}
`
      )

      await bundleExtension(srcPath, outPath)

      const exists = await Bun.file(outPath).exists()
      expect(exists).toBe(true)

      const content = await Bun.file(outPath).text()
      expect(content).toContain('hello')
    })

    test('bundles JavaScript files', async () => {
      const srcPath = join(tmpDir, 'tool.js')
      const outPath = join(tmpDir, 'tool.bundle.js')

      await writeFile(
        srcPath,
        `
export function util() {
  return 42;
}
`
      )

      await bundleExtension(srcPath, outPath)

      const exists = await Bun.file(outPath).exists()
      expect(exists).toBe(true)
    })

    test('respects format option', async () => {
      const srcPath = join(tmpDir, 'tool.ts')
      const outPath = join(tmpDir, 'tool.cjs')

      await writeFile(srcPath, 'export const x = 1;')

      await bundleExtension(srcPath, outPath, { format: 'cjs' })

      const content = await Bun.file(outPath).text()
      // The default format is ESM; cjs must emit module.exports and no ESM export statement.
      expect(content).toContain('module.exports')
      expect(content).not.toMatch(/^export\s/m)
    })

    test('throws PiBundleError for invalid code', async () => {
      const srcPath = join(tmpDir, 'invalid.ts')
      const outPath = join(tmpDir, 'invalid.js')

      // Write invalid TypeScript - import from non-existent module
      // that should fail bundling
      await writeFile(
        srcPath,
        `
import { nonExistent } from 'absolutely-nonexistent-module-12345';
export const x = nonExistent();
`
      )

      await expect(bundleExtension(srcPath, outPath)).rejects.toThrow(PiBundleError)
    })
  })

  describe('discoverExtensions', () => {
    test('discovers TypeScript extensions', async () => {
      const extensionsDir = join(tmpDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })
      await writeFile(join(extensionsDir, 'tool1.ts'), 'export const a = 1;')
      await writeFile(join(extensionsDir, 'tool2.ts'), 'export const b = 2;')

      const extensions = await discoverExtensions(tmpDir)

      expect(extensions).toHaveLength(2)
      expect(extensions.some((e) => e.endsWith('tool1.ts'))).toBe(true)
      expect(extensions.some((e) => e.endsWith('tool2.ts'))).toBe(true)
    })

    test('discovers JavaScript extensions', async () => {
      const extensionsDir = join(tmpDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })
      await writeFile(join(extensionsDir, 'util.js'), 'export const c = 3;')

      const extensions = await discoverExtensions(tmpDir)

      expect(extensions).toHaveLength(1)
      expect(extensions[0]).toContain('util.js')
    })

    test('ignores package.json and node_modules', async () => {
      const extensionsDir = join(tmpDir, 'extensions')
      await mkdir(extensionsDir, { recursive: true })
      await writeFile(join(extensionsDir, 'tool.ts'), 'export const x = 1;')
      await writeFile(join(extensionsDir, 'package.json'), '{}')
      await mkdir(join(extensionsDir, 'node_modules'), { recursive: true })

      const extensions = await discoverExtensions(tmpDir)

      expect(extensions).toHaveLength(1)
      expect(extensions[0]).toContain('tool.ts')
    })

    test('returns empty array when no extensions directory', async () => {
      const extensions = await discoverExtensions(tmpDir)

      expect(extensions).toEqual([])
    })

    test('returns empty array when extensions is not a directory', async () => {
      await writeFile(join(tmpDir, 'extensions'), 'not a directory')

      const extensions = await discoverExtensions(tmpDir)

      expect(extensions).toEqual([])
    })
  })
})

describe('Error classes', () => {
  describe('PiBundleError', () => {
    test('includes extension path and stderr', () => {
      const error = new PiBundleError('/path/to/ext.ts', 'Syntax error on line 5')

      expect(error.message).toContain('/path/to/ext.ts')
      expect(error.message).toContain('Syntax error on line 5')
      expect(error.extensionPath).toBe('/path/to/ext.ts')
      expect(error.stderr).toBe('Syntax error on line 5')
      expect(error.name).toBe('PiBundleError')
    })
  })
})
