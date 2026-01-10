/**
 * Integration tests for `asp repo *` commands.
 *
 * WHY: The repo commands manage the registry lifecycle - initializing,
 * publishing spaces, and querying status. These commands need end-to-end
 * validation to ensure the registry structure is correct.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { exec } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

/** Create a temporary directory for registry testing */
async function createTempDir(): Promise<string> {
  return fs.mkdtemp('/tmp/asp-repo-test-')
}

/** Clean up a temporary directory */
async function cleanupTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

describe('asp repo init', () => {
  let aspHome: string

  beforeEach(async () => {
    aspHome = await createTempDir()
  })

  afterEach(async () => {
    await cleanupTempDir(aspHome)
  })

  test('initializes a new registry with correct structure', async () => {
    // Run repo init via the CLI
    const cliPath = path.resolve(import.meta.dir, '../../packages/cli/bin/asp.js')
    await execAsync(`bun ${cliPath} repo init --asp-home "${aspHome}"`)

    const repoPath = path.join(aspHome, 'repo')

    // Verify .git directory exists
    const gitExists = await fs
      .access(path.join(repoPath, '.git'))
      .then(() => true)
      .catch(() => false)
    expect(gitExists).toBe(true)

    // Verify spaces directory exists
    const spacesExists = await fs
      .access(path.join(repoPath, 'spaces'))
      .then(() => true)
      .catch(() => false)
    expect(spacesExists).toBe(true)

    // Verify registry directory exists
    const registryExists = await fs
      .access(path.join(repoPath, 'registry'))
      .then(() => true)
      .catch(() => false)
    expect(registryExists).toBe(true)

    // Verify dist-tags.json exists and is valid JSON
    const distTagsPath = path.join(repoPath, 'registry', 'dist-tags.json')
    const distTagsContent = await fs.readFile(distTagsPath, 'utf-8')
    const distTags = JSON.parse(distTagsContent)
    expect(distTags).toEqual({})

    // Verify README exists
    const readmeExists = await fs
      .access(path.join(repoPath, 'README.md'))
      .then(() => true)
      .catch(() => false)
    expect(readmeExists).toBe(true)
  })

  test('does not overwrite existing registry', async () => {
    const cliPath = path.resolve(import.meta.dir, '../../packages/cli/bin/asp.js')

    // Initialize first time
    await execAsync(`bun ${cliPath} repo init --asp-home "${aspHome}"`)

    // Create a marker file in the repo
    const markerPath = path.join(aspHome, 'repo', 'marker.txt')
    await fs.writeFile(markerPath, 'test')

    // Initialize again - should not overwrite
    await execAsync(`bun ${cliPath} repo init --asp-home "${aspHome}"`)

    // Verify marker still exists
    const markerExists = await fs
      .access(markerPath)
      .then(() => true)
      .catch(() => false)
    expect(markerExists).toBe(true)
  })
})

describe('asp repo publish', () => {
  let aspHome: string

  beforeEach(async () => {
    aspHome = await createTempDir()

    // Initialize registry first
    const cliPath = path.resolve(import.meta.dir, '../../packages/cli/bin/asp.js')
    await execAsync(`bun ${cliPath} repo init --asp-home "${aspHome}"`)

    // Create a test space
    const spacePath = path.join(aspHome, 'repo', 'spaces', 'test-space')
    await fs.mkdir(spacePath, { recursive: true })
    await fs.writeFile(
      path.join(spacePath, 'space.toml'),
      `schema = 1
id = "test-space"
version = "1.0.0"
`
    )

    // Commit the space
    const repoPath = path.join(aspHome, 'repo')
    await execAsync('git add -A', { cwd: repoPath })
    await execAsync('git commit -m "Add test-space"', { cwd: repoPath })
  })

  afterEach(async () => {
    await cleanupTempDir(aspHome)
  })

  test('creates version tag for a space', async () => {
    const cliPath = path.resolve(import.meta.dir, '../../packages/cli/bin/asp.js')
    const repoPath = path.join(aspHome, 'repo')

    // Publish the space
    await execAsync(`bun ${cliPath} repo publish test-space --tag v1.0.0 --asp-home "${aspHome}"`)

    // Verify tag was created
    const { stdout } = await execAsync('git tag -l "space/test-space/v1.0.0"', { cwd: repoPath })
    expect(stdout.trim()).toBe('space/test-space/v1.0.0')
  })

  test('updates dist-tags when specified', async () => {
    const cliPath = path.resolve(import.meta.dir, '../../packages/cli/bin/asp.js')
    const repoPath = path.join(aspHome, 'repo')

    // Publish with dist-tag
    await execAsync(
      `bun ${cliPath} repo publish test-space --tag v1.0.0 --dist-tag stable --asp-home "${aspHome}"`
    )

    // Verify dist-tags.json was updated
    const distTagsPath = path.join(repoPath, 'registry', 'dist-tags.json')
    const distTagsContent = await fs.readFile(distTagsPath, 'utf-8')
    const distTags = JSON.parse(distTagsContent)

    expect(distTags['test-space']).toBeDefined()
    expect(distTags['test-space'].stable).toBe('v1.0.0')
  })

  test('rejects invalid version format', async () => {
    const cliPath = path.resolve(import.meta.dir, '../../packages/cli/bin/asp.js')

    // Try to publish with invalid version
    try {
      await execAsync(`bun ${cliPath} repo publish test-space --tag 1.0.0 --asp-home "${aspHome}"`)
      expect(true).toBe(false) // Should not reach here
    } catch (error) {
      // Expected to fail
      expect(String(error)).toContain('Invalid version tag format')
    }
  })
})

describe('asp repo status', () => {
  let aspHome: string

  beforeEach(async () => {
    aspHome = await createTempDir()

    // Initialize registry
    const cliPath = path.resolve(import.meta.dir, '../../packages/cli/bin/asp.js')
    await execAsync(`bun ${cliPath} repo init --asp-home "${aspHome}"`)

    // Create a test space
    const spacePath = path.join(aspHome, 'repo', 'spaces', 'test-space')
    await fs.mkdir(spacePath, { recursive: true })
    await fs.writeFile(
      path.join(spacePath, 'space.toml'),
      `schema = 1
id = "test-space"
version = "1.0.0"
`
    )

    // Commit
    const repoPath = path.join(aspHome, 'repo')
    await execAsync('git add -A', { cwd: repoPath })
    await execAsync('git commit -m "Add test-space"', { cwd: repoPath })
  })

  afterEach(async () => {
    await cleanupTempDir(aspHome)
  })

  test('outputs JSON status correctly', async () => {
    const cliPath = path.resolve(import.meta.dir, '../../packages/cli/bin/asp.js')

    const { stdout } = await execAsync(
      `bun ${cliPath} repo status --json --asp-home "${aspHome}"`
    )

    const status = JSON.parse(stdout)
    expect(status.repoPath).toBe(path.join(aspHome, 'repo'))
    expect(status.clean).toBe(true)
    expect(status.spaces).toContain('test-space')
  })

  test('shows modified status when files changed', async () => {
    const cliPath = path.resolve(import.meta.dir, '../../packages/cli/bin/asp.js')
    const repoPath = path.join(aspHome, 'repo')

    // Modify a file
    await fs.writeFile(path.join(repoPath, 'new-file.txt'), 'test')

    const { stdout } = await execAsync(
      `bun ${cliPath} repo status --json --asp-home "${aspHome}"`
    )

    const status = JSON.parse(stdout)
    expect(status.clean).toBe(false)
    expect(status.untracked).toContain('new-file.txt')
  })
})

describe('asp repo tags', () => {
  let aspHome: string

  beforeEach(async () => {
    aspHome = await createTempDir()

    // Initialize registry
    const cliPath = path.resolve(import.meta.dir, '../../packages/cli/bin/asp.js')
    await execAsync(`bun ${cliPath} repo init --asp-home "${aspHome}"`)

    // Create a test space
    const spacePath = path.join(aspHome, 'repo', 'spaces', 'test-space')
    await fs.mkdir(spacePath, { recursive: true })
    await fs.writeFile(
      path.join(spacePath, 'space.toml'),
      `schema = 1
id = "test-space"
version = "1.0.0"
`
    )

    // Commit
    const repoPath = path.join(aspHome, 'repo')
    await execAsync('git add -A', { cwd: repoPath })
    await execAsync('git commit -m "Add test-space"', { cwd: repoPath })

    // Publish multiple versions
    await execAsync(
      `bun ${cliPath} repo publish test-space --tag v1.0.0 --dist-tag stable --asp-home "${aspHome}"`
    )
    await execAsync(
      `bun ${cliPath} repo publish test-space --tag v1.1.0 --dist-tag latest --asp-home "${aspHome}"`
    )
  })

  afterEach(async () => {
    await cleanupTempDir(aspHome)
  })

  test('lists tags for a space in JSON format', async () => {
    const cliPath = path.resolve(import.meta.dir, '../../packages/cli/bin/asp.js')

    const { stdout } = await execAsync(
      `bun ${cliPath} repo tags test-space --json --asp-home "${aspHome}"`
    )

    const tags = JSON.parse(stdout)
    expect(tags.spaceId).toBe('test-space')
    expect(tags.versions).toContain('v1.0.0')
    expect(tags.versions).toContain('v1.1.0')
    expect(tags.distTags.stable).toBe('v1.0.0')
    expect(tags.distTags.latest).toBe('v1.1.0')
  })
})
