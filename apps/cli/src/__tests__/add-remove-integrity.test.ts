/**
 * `asp add` / `asp remove` integrity, driven through the real binary (T-10318):
 * other targets keep their lock, a failed add leaves the targets file alone,
 * a bare id removes any ref form, "not found" fails, and comments survive.
 */

import { afterEach, beforeEach, describe, expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type AspResult, cliTest, runAsp } from './asp-cli.js'

const TARGETS = `# Top comment: keep me
schema = 2

# demo target comment
[targets.demo]
compose = ["space:project:alpha"]  # inline comment

[targets.other]
# other target comment
compose = [
  "space:project:beta", # beta stays
  "space:project:gamma",
]
`

let root: string
let project: string
let aspHome: string

function asp(...args: string[]): AspResult {
  return runAsp([...args, '--project', project], { ASP_HOME: aspHome })
}

async function readLock(): Promise<{ targets: Record<string, unknown>; spaces: object }> {
  return JSON.parse(await readFile(join(project, 'asp-lock.json'), 'utf8'))
}

async function readTargets(): Promise<string> {
  return readFile(join(project, 'asp-targets.toml'), 'utf8')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'asp-add-remove-'))
  project = join(root, 'project')
  aspHome = join(root, 'asp-home')
  await mkdir(aspHome, { recursive: true })
  for (const id of ['alpha', 'beta', 'gamma']) {
    await mkdir(join(project, 'spaces', id), { recursive: true })
    await writeFile(
      join(project, 'spaces', id, 'space.toml'),
      `schema = 1\nid = "${id}"\nversion = "0.1.0"\n\n[plugin]\nname = "${id}"\n`
    )
  }
  await writeFile(join(project, 'asp-targets.toml'), TARGETS)
  expect(asp('install').exitCode).toBe(0)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('asp add / asp remove integrity', () => {
  cliTest('add and remove on one target keep the other target locked', async () => {
    const otherBefore = JSON.stringify((await readLock()).targets['other'])

    expect(asp('add', 'space:project:gamma', '--target', 'demo').exitCode).toBe(0)
    expect(Object.keys((await readLock()).targets).sort()).toEqual(['demo', 'other'])
    expect(JSON.stringify((await readLock()).targets['other'])).toBe(otherBefore)
    expect(asp('explain', 'other').exitCode).toBe(0)

    expect(asp('remove', 'space:project:gamma', '--target', 'demo').exitCode).toBe(0)
    expect(JSON.stringify((await readLock()).targets['other'])).toBe(otherBefore)
    expect(asp('explain', 'other').exitCode).toBe(0)
  })

  cliTest('a failed add leaves asp-targets.toml byte-identical', async () => {
    const before = await readTargets()
    const result = asp('add', 'space:project:missing', '--target', 'demo', '--no-install')
    expect(result.exitCode).not.toBe(0)
    expect(await readTargets()).toBe(before)
  })

  cliTest('remove by bare id matches a space:project ref; not found fails', async () => {
    expect(asp('remove', 'gamma', '--target', 'other').exitCode).toBe(0)
    expect(await readTargets()).not.toContain('space:project:gamma')

    const before = await readTargets()
    const missing = asp('remove', 'nope', '--target', 'other', '--no-install')
    expect(missing.exitCode).not.toBe(0)
    expect(missing.stderr).toContain('not found')
    expect(await readTargets()).toBe(before)
  })

  cliTest('add then remove round-trips the file with comments intact', async () => {
    expect(asp('add', 'space:project:alpha', '--target', 'other', '--no-install').exitCode).toBe(0)
    const added = await readTargets()
    expect(added).toBe(
      TARGETS.replace(
        '  "space:project:gamma",\n',
        '  "space:project:gamma",\n  "space:project:alpha",\n'
      )
    )

    expect(asp('remove', 'alpha', '--target', 'other', '--no-install').exitCode).toBe(0)
    expect(await readTargets()).toBe(TARGETS)
  })
})
