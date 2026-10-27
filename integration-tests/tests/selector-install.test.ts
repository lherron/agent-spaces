import { beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { install } from 'spaces-execution'
import {
  SAMPLE_REGISTRY_DIR,
  cleanupTempAspHome,
  cleanupTempProject,
  createTempAspHome,
  createTempProject,
  initSampleRegistry,
} from './setup.js'

beforeAll(async () => {
  await initSampleRegistry()
})

test.each([
  ['1.0.0', '1.0.0'],
  ['^1.0.0', '1.1.0'],
  ['~1.0.0', '1.0.1'],
  ['^2.0.0', '2.0.0'],
])('install locks base@%s to version %s and its tagged commit', async (selector, version) => {
  const home = await createTempAspHome()
  const project = await createTempProject({ dev: { compose: [`space:base@${selector}`] } })
  try {
    const result = await install({
      projectPath: project,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome: home,
    })
    const entry = Object.values(result.lock.spaces).find((space) => space.id === 'base')
    const tag = `space/base/v${version}`
    const commit = execFileSync('git', ['rev-parse', `${tag}^{commit}`], {
      cwd: SAMPLE_REGISTRY_DIR,
      encoding: 'utf8',
    }).trim()
    expect(entry?.resolvedFrom).toMatchObject({ selector, tag, semver: version })
    expect(String(entry?.commit)).toBe(commit)
  } finally {
    await cleanupTempProject(project)
    await cleanupTempAspHome(home)
  }
})

test.each(['9.9.9', '^3.0.0'])(
  'install refuses base@%s when no version matches',
  async (selector) => {
    const home = await createTempAspHome()
    const project = await createTempProject({ dev: { compose: [`space:base@${selector}`] } })
    try {
      await expect(
        install({ projectPath: project, registryPath: SAMPLE_REGISTRY_DIR, aspHome: home })
      ).rejects.toThrow(selector)
    } finally {
      await cleanupTempProject(project)
      await cleanupTempAspHome(home)
    }
  }
)

test.each([12, 40])(
  'install locks a %s-character git pin to the selected commit',
  async (length) => {
    const home = await createTempAspHome()
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: SAMPLE_REGISTRY_DIR,
      encoding: 'utf8',
    }).trim()
    const pin = commit.slice(0, length)
    const project = await createTempProject({ dev: { compose: [`space:base@git:${pin}`] } })
    try {
      const result = await install({
        projectPath: project,
        registryPath: SAMPLE_REGISTRY_DIR,
        aspHome: home,
      })
      expect(
        String(Object.values(result.lock.spaces).find((space) => space.id === 'base')?.commit)
      ).toBe(pin)
    } finally {
      await cleanupTempProject(project)
      await cleanupTempAspHome(home)
    }
  }
)
