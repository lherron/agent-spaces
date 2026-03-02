/**
 * Tests for loadDefaultManifest() and loadProjectManifest() integration with default-targets.toml
 *
 * RED/GREEN TDD: These tests are written BEFORE the implementation.
 * They MUST fail initially (red) and pass only after the functions are implemented.
 *
 * Task: T-00806
 * loadDefaultManifest():
 *   - File exists at $ASP_HOME/default-targets.toml → loads and returns ProjectManifest
 *   - File does not exist → returns null (no error)
 *
 * loadProjectManifest() integration:
 *   - When default-targets.toml exists, loadProjectManifest merges defaults under project targets
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// loadDefaultManifest does not exist yet — this import will cause a compile/runtime error (RED)
import { loadDefaultManifest, loadProjectManifest } from './resolve.js'

describe('loadDefaultManifest', () => {
  let testAspHome: string
  let origAspHome: string | undefined

  beforeEach(async () => {
    testAspHome = join(
      tmpdir(),
      `asp-home-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    await mkdir(testAspHome, { recursive: true })
    origAspHome = process.env['ASP_HOME']
    process.env['ASP_HOME'] = testAspHome
  })

  afterEach(async () => {
    if (origAspHome !== undefined) {
      process.env['ASP_HOME'] = origAspHome
    } else {
      process.env['ASP_HOME'] = undefined
    }
    await rm(testAspHome, { recursive: true, force: true })
  })

  test('returns ProjectManifest when default-targets.toml exists', async () => {
    const defaultTargets = `
schema = 1

[claude]
model = "claude-3-opus"
permission_mode = "auto"

[targets.shared]
compose = ["space:defaults@stable"]
`
    await writeFile(join(testAspHome, 'default-targets.toml'), defaultTargets, 'utf8')

    const result = await loadDefaultManifest()
    expect(result).not.toBeNull()
    expect(result!.schema).toBe(1)
    expect(result!.claude?.model).toBe('claude-3-opus')
    expect(result!.targets.shared).toBeDefined()
    expect(result!.targets.shared.compose).toEqual(['space:defaults@stable'])
  })

  test('returns null when default-targets.toml does not exist (no error)', async () => {
    // testAspHome exists but has no default-targets.toml file
    const result = await loadDefaultManifest()
    expect(result).toBeNull()
  })

  test('uses ASP_HOME env var to locate the file', async () => {
    const customHome = join(tmpdir(), `asp-custom-${Date.now()}`)
    await mkdir(customHome, { recursive: true })
    process.env['ASP_HOME'] = customHome

    const toml = `
schema = 1

[targets.custom]
compose = ["space:custom@stable"]
`
    await writeFile(join(customHome, 'default-targets.toml'), toml, 'utf8')

    const result = await loadDefaultManifest()
    expect(result).not.toBeNull()
    expect(result!.targets.custom).toBeDefined()

    await rm(customHome, { recursive: true, force: true })
  })
})

describe('loadProjectManifest integration with defaults', () => {
  let testAspHome: string
  let testProjectDir: string
  let origAspHome: string | undefined

  beforeEach(async () => {
    testAspHome = join(
      tmpdir(),
      `asp-home-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    testProjectDir = join(
      tmpdir(),
      `asp-project-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    await mkdir(testAspHome, { recursive: true })
    await mkdir(testProjectDir, { recursive: true })
    origAspHome = process.env['ASP_HOME']
    process.env['ASP_HOME'] = testAspHome
  })

  afterEach(async () => {
    if (origAspHome !== undefined) {
      process.env['ASP_HOME'] = origAspHome
    } else {
      process.env['ASP_HOME'] = undefined
    }
    await rm(testAspHome, { recursive: true, force: true })
    await rm(testProjectDir, { recursive: true, force: true })
  })

  test('merges default targets under project targets when default-targets.toml exists', async () => {
    // Write default-targets.toml in ASP_HOME
    const defaultTargets = `
schema = 1

[claude]
model = "claude-3-opus"
permission_mode = "auto"

[targets.shared]
description = "Shared defaults target"
compose = ["space:defaults@stable"]
`
    await writeFile(join(testAspHome, 'default-targets.toml'), defaultTargets, 'utf8')

    // Write project asp-targets.toml
    const projectTargets = `
schema = 1

[claude]
model = "claude-3-sonnet"

[targets.dev]
compose = ["space:dev@latest"]
`
    await writeFile(join(testProjectDir, 'asp-targets.toml'), projectTargets, 'utf8')

    const result = await loadProjectManifest(testProjectDir)

    // Project target is present
    expect(result.targets.dev).toBeDefined()
    expect(result.targets.dev.compose).toEqual(['space:dev@latest'])

    // Default target is merged in
    expect(result.targets.shared).toBeDefined()
    expect(result.targets.shared.compose).toEqual(['space:defaults@stable'])

    // Claude options are field-merged: project model wins, defaults permission_mode inherited
    expect(result.claude?.model).toBe('claude-3-sonnet')
    expect(result.claude?.permission_mode).toBe('auto')
  })

  test('project targets override default targets with same name entirely', async () => {
    // Write default-targets.toml
    const defaultTargets = `
schema = 1

[targets.dev]
description = "Default dev"
compose = ["space:defaults@stable"]
`
    await writeFile(join(testAspHome, 'default-targets.toml'), defaultTargets, 'utf8')

    // Write project asp-targets.toml with same target name
    const projectTargets = `
schema = 1

[targets.dev]
compose = ["space:project-dev@latest"]
`
    await writeFile(join(testProjectDir, 'asp-targets.toml'), projectTargets, 'utf8')

    const result = await loadProjectManifest(testProjectDir)

    // Project's dev target wins entirely
    expect(result.targets.dev.compose).toEqual(['space:project-dev@latest'])
    // Description from defaults is NOT inherited
    expect(result.targets.dev.description).toBeUndefined()
  })

  test('no default-targets.toml → loadProjectManifest works as before', async () => {
    // No default-targets.toml in ASP_HOME

    const projectTargets = `
schema = 1

[targets.dev]
compose = ["space:dev@latest"]
`
    await writeFile(join(testProjectDir, 'asp-targets.toml'), projectTargets, 'utf8')

    const result = await loadProjectManifest(testProjectDir)
    expect(result.targets.dev).toBeDefined()
    expect(result.targets.dev.compose).toEqual(['space:dev@latest'])
  })

  test('uses explicit aspHome argument over process env for defaults merge', async () => {
    const envAspHome = join(
      tmpdir(),
      `asp-env-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    const explicitAspHome = join(
      tmpdir(),
      `asp-explicit-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    await mkdir(envAspHome, { recursive: true })
    await mkdir(explicitAspHome, { recursive: true })

    try {
      await writeFile(
        join(envAspHome, 'default-targets.toml'),
        'schema = 1\n\n[targets.from_env]\ncompose = ["space:env@stable"]\n',
        'utf8'
      )
      await writeFile(
        join(explicitAspHome, 'default-targets.toml'),
        'schema = 1\n\n[targets.from_explicit]\ncompose = ["space:explicit@stable"]\n',
        'utf8'
      )
      await writeFile(
        join(testProjectDir, 'asp-targets.toml'),
        'schema = 1\n\n[targets.dev]\ncompose = ["space:dev@stable"]\n',
        'utf8'
      )

      process.env['ASP_HOME'] = envAspHome
      const result = await loadProjectManifest(testProjectDir, explicitAspHome)

      expect(result.targets.from_explicit).toBeDefined()
      expect(result.targets.from_env).toBeUndefined()
    } finally {
      await rm(envAspHome, { recursive: true, force: true })
      await rm(explicitAspHome, { recursive: true, force: true })
    }
  })
})
