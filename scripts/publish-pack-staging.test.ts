import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { packForPublish } from './lib/asp-publish/pack'
import { REPO_ROOT } from './lib/asp-publish/package-set'
import { extractTarball } from './lib/asp-publish/tarball'

// T-10320: packing (dry run or real publish) once rewrote each package.json in
// the checkout and restored it afterwards, so a sibling seat could see or
// commit the rewritten manifest and a killed pack left it dirty. The checkout
// must only ever be read: content AND mtime of every file stay unchanged.

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    const info = await stat(path)
    const hash = createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
    out[relative(dir, path)] = `${hash} ${info.mtimeMs} ${info.mode}`
  }
  return out
}

test('packing reads the package dir and never writes it; the tarball carries the publish rewrites', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asp-pack-staging-'))
  temps.push(root)
  const pkgDir = join(root, 'pkg')
  await mkdir(join(pkgDir, 'dist'), { recursive: true })
  await mkdir(join(pkgDir, 'node_modules', 'left-alone'), { recursive: true })
  await writeFile(join(pkgDir, 'dist', 'index.js'), 'export const x = 1\n')
  await writeFile(join(pkgDir, 'node_modules', 'left-alone', 'index.js'), '\n')
  await writeFile(
    join(pkgDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'pack-staging-fixture',
        version: '0.1.0',
        private: true,
        type: 'module',
        main: './dist/index.js',
        files: ['dist'],
        exports: { '.': { bun: './src/index.ts', import: './dist/index.js' } },
        dependencies: { 'agent-scope': 'workspace:*', zod: '^3.0.0' },
      },
      null,
      2
    )}\n`
  )
  const before = await snapshot(pkgDir)

  const packed = await packForPublish(relative(REPO_ROOT, pkgDir), {
    versionsByName: new Map([
      ['pack-staging-fixture', '0.1.0-dev.20990101000000'],
      ['agent-scope', '0.1.1-dev.20990101000000'],
    ]),
    builtAt: '2099-01-01T00:00:00.000Z',
    source: {
      repository: 'agent-spaces',
      canonicalRemote: 'git@example.invalid:agent-spaces.git',
      sourceCommit: 'a'.repeat(40),
      canonicalRef: 'refs/heads/main',
      canonical: false,
    },
  })
  temps.push(packed.tmp)

  expect(await snapshot(pkgDir)).toEqual(before)
  expect(packed.tmp.startsWith(pkgDir)).toBe(false)

  const extracted = extractTarball(packed.tarballPath, join(root, 'extract'), packed.name)
  const shipped = JSON.parse(await readFile(join(extracted, 'package.json'), 'utf8'))
  expect(shipped.version).toBe('0.1.0-dev.20990101000000')
  expect(shipped.private).toBeUndefined()
  expect(shipped.exports).toEqual({ '.': { import: './dist/index.js' } })
  expect(shipped.dependencies).toEqual({
    'agent-scope': '0.1.1-dev.20990101000000',
    zod: '^3.0.0',
  })
  expect(shipped.praesidiumBuild).toMatchObject({
    setVersion: '0.1.0-dev.20990101000000',
    builtAt: '2099-01-01T00:00:00.000Z',
  })
  expect(await readdir(extracted)).toEqual(expect.arrayContaining(['dist', 'package.json']))
  expect(await readdir(extracted)).not.toContain('node_modules')
})
