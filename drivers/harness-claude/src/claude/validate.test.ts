import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPluginNameCollisions, validatePlugin } from './validate.js'

let root = ''
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'claude-plugin-validation-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

test.each([
  {
    name: 'missing directory',
    manifest: undefined,
    createDir: false,
    valid: false,
    error: 'Directory not accessible:',
  },
  {
    name: 'missing manifest',
    manifest: undefined,
    createDir: true,
    valid: false,
    error: 'Missing required .claude-plugin/plugin.json file',
  },
  {
    name: 'missing name',
    manifest: { version: '1.0.0' },
    createDir: true,
    valid: false,
    error: "plugin.json missing required 'name' field",
  },
  {
    name: 'valid manifest',
    manifest: { name: 'my-plugin', version: '1.0.0' },
    createDir: true,
    valid: true,
  },
  {
    name: 'non-kebab name',
    manifest: { name: 'MyPlugin' },
    createDir: true,
    valid: true,
    warning: 'kebab-case',
  },
] as const)('$name reports the expected plugin validation result', async (row) => {
  const dir = join(root, row.name.replaceAll(' ', '-'))
  if (row.createDir) await mkdir(dir, { recursive: true })
  if (row.manifest) {
    await mkdir(join(dir, '.claude-plugin'), { recursive: true })
    await writeFile(join(dir, '.claude-plugin/plugin.json'), JSON.stringify(row.manifest))
  }
  const result = await validatePlugin(dir)
  expect(result.valid).toBe(row.valid)
  if ('error' in row) expect(result.errors.join('\n')).toContain(row.error)
  if ('warning' in row) expect(result.warnings.join('\n')).toContain(row.warning)
  if (row.name === 'valid manifest')
    expect([result.pluginName, result.pluginVersion]).toEqual(['my-plugin', '1.0.0'])
})

test.each([
  { names: ['shared-name', 'shared-name', 'unique-name'], collision: 'shared-name' },
  { names: ['name-a', 'name-b'], collision: undefined },
])('plugin names $names report their collision, if any', ({ names, collision }) => {
  const results = names.map((pluginName, index) => ({
    path: join(root, String(index)),
    valid: true,
    errors: [],
    warnings: [],
    pluginName,
  }))
  const collisions = checkPluginNameCollisions(results)
  if (collision) {
    expect(collisions).toHaveLength(1)
    expect(collisions[0]).toContain(collision)
  } else expect(collisions).toEqual([])
})
