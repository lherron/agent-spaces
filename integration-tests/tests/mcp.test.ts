/**
 * Integration tests for MCP configuration composition.
 *
 * WHY: Spaces can declare MCP servers that should be available when
 * running Claude. We need to test that:
 * - MCP configs are composed from multiple spaces
 * - The --mcp-config flag is passed to Claude during `asp run`
 * - MCP server name collisions are handled appropriately
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { build, install, runWithPrompt } from 'spaces-engine'

import {
  SAMPLE_REGISTRY_DIR,
  cleanupShimOutput,
  cleanupTempAspHome,
  cleanupTempProject,
  createTempAspHome,
  createTempProject,
  getTestEnv,
  initSampleRegistry,
  readShimOutput,
} from './setup.js'

describe('MCP config composition', () => {
  let aspHome: string
  let projectDir: string
  let outputDir: string
  let originalEnv: NodeJS.ProcessEnv

  beforeAll(async () => {
    await initSampleRegistry()
  })

  afterAll(async () => {
    // Note: Don't clean up sample registry - other parallel tests may need it
  })

  beforeEach(async () => {
    originalEnv = { ...process.env }
    aspHome = await createTempAspHome()
    outputDir = await fs.mkdtemp('/tmp/asp-mcp-test-')
  })

  afterEach(async () => {
    process.env = originalEnv
    await cleanupTempAspHome(aspHome)
    if (projectDir) {
      await cleanupTempProject(projectDir)
    }
    await fs.rm(outputDir, { recursive: true, force: true })
    await cleanupShimOutput()
  })

  test('asp build generates mcpConfigPath when MCP servers are present', async () => {
    projectDir = await createTempProject({
      mcp: {
        description: 'MCP test target',
        compose: ['space:mcp-server-a@stable', 'space:mcp-server-b@stable'],
      },
    })

    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    const result = await build('mcp', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
    })

    // Should have mcpConfigPath set
    expect(result.mcpConfigPath).toBeDefined()
    expect(result.mcpConfigPath).toContain('mcp.json')

    // Verify mcp.json file exists
    const mcpConfigExists = await fs
      .access(result.mcpConfigPath!)
      .then(() => true)
      .catch(() => false)
    expect(mcpConfigExists).toBe(true)

    // Verify mcp.json structure
    const mcpContent = await fs.readFile(result.mcpConfigPath!, 'utf-8')
    const mcpConfig = JSON.parse(mcpContent)

    expect(mcpConfig.mcpServers).toBeDefined()
    expect(mcpConfig.mcpServers['server-alpha']).toBeDefined()
    expect(mcpConfig.mcpServers['server-beta']).toBeDefined()
  })

  test('asp build composes MCP servers from multiple spaces', async () => {
    projectDir = await createTempProject({
      mcp: {
        compose: ['space:mcp-server-a@stable', 'space:mcp-server-b@stable'],
      },
    })

    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    const result = await build('mcp', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
    })

    expect(result.mcpConfigPath).toBeDefined()

    const mcpContent = await fs.readFile(result.mcpConfigPath!, 'utf-8')
    const mcpConfig = JSON.parse(mcpContent)

    // Verify server-alpha config from mcp-server-a
    expect(mcpConfig.mcpServers['server-alpha']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@example/server-alpha'],
      env: { ALPHA_KEY: 'test-value' },
    })

    // Verify server-beta config from mcp-server-b
    expect(mcpConfig.mcpServers['server-beta']).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['./server-beta.js'],
    })
  })

  test('asp build does not generate mcpConfigPath when no MCP servers', async () => {
    projectDir = await createTempProject({
      base: {
        compose: ['space:base@stable'],
      },
    })

    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    const result = await build('base', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
    })

    // Should NOT have mcpConfigPath set (base space has no MCP servers)
    expect(result.mcpConfigPath).toBeUndefined()

    // Verify mcp.json file does not exist
    const mcpConfigPath = path.join(outputDir, 'mcp.json')
    const mcpConfigExists = await fs
      .access(mcpConfigPath)
      .then(() => true)
      .catch(() => false)
    expect(mcpConfigExists).toBe(false)
  })

  test('asp run passes --mcp-config to Claude when MCP servers present', async () => {
    projectDir = await createTempProject({
      mcp: {
        compose: ['space:mcp-server-a@stable'],
      },
    })

    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    // Set up environment for claude shim
    const testEnv = getTestEnv(aspHome)
    for (const [key, value] of Object.entries(testEnv)) {
      process.env[key] = value
    }

    const result = await runWithPrompt('mcp', 'Test MCP', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    expect(result.exitCode).toBe(0)

    // Read shim output to verify --mcp-config was passed
    const shimOutput = await readShimOutput()

    // Should have mcpConfig set
    expect(shimOutput.mcpConfig).not.toBeNull()
    expect(shimOutput.mcpConfig).toContain('mcp.json')

    // Also verify --mcp-config is in args
    const mcpConfigIndex = shimOutput.args.indexOf('--mcp-config')
    expect(mcpConfigIndex).toBeGreaterThanOrEqual(0)
    expect(shimOutput.args[mcpConfigIndex + 1]).toContain('mcp.json')
  })

  test('asp run does not pass --mcp-config when no MCP servers', async () => {
    projectDir = await createTempProject({
      base: {
        compose: ['space:base@stable'],
      },
    })

    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    // Set up environment for claude shim
    const testEnv = getTestEnv(aspHome)
    for (const [key, value] of Object.entries(testEnv)) {
      process.env[key] = value
    }

    const result = await runWithPrompt('base', 'Test no MCP', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    expect(result.exitCode).toBe(0)

    // Read shim output
    const shimOutput = await readShimOutput()

    // Should NOT have mcpConfig set
    expect(shimOutput.mcpConfig).toBeNull()

    // Also verify --mcp-config is NOT in args
    const mcpConfigIndex = shimOutput.args.indexOf('--mcp-config')
    expect(mcpConfigIndex).toBe(-1)
  })

  test('later spaces override earlier MCP server definitions', async () => {
    // When two spaces define the same server, later one wins
    projectDir = await createTempProject({
      collision: {
        compose: ['space:mcp-collision-a@stable', 'space:mcp-collision-b@stable'],
      },
    })

    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    const result = await build('collision', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
    })

    expect(result.mcpConfigPath).toBeDefined()

    const mcpContent = await fs.readFile(result.mcpConfigPath!, 'utf-8')
    const mcpConfig = JSON.parse(mcpContent)

    // Should have shared-server, using mcp-collision-b's definition (later wins)
    expect(mcpConfig.mcpServers['shared-server']).toBeDefined()
    expect(mcpConfig.mcpServers['shared-server'].args).toContain('@example/shared-server-v2')
  })

  test('mixed spaces with and without MCP configs work correctly', async () => {
    // Combine spaces: base (no MCP), mcp-server-a (has MCP)
    projectDir = await createTempProject({
      mixed: {
        compose: ['space:base@stable', 'space:mcp-server-a@stable'],
      },
    })

    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    const result = await build('mixed', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
    })

    // Should have mcpConfigPath because one space has MCP
    expect(result.mcpConfigPath).toBeDefined()

    const mcpContent = await fs.readFile(result.mcpConfigPath!, 'utf-8')
    const mcpConfig = JSON.parse(mcpContent)

    // Should only have server-alpha (from mcp-server-a)
    expect(Object.keys(mcpConfig.mcpServers)).toEqual(['server-alpha'])
    expect(mcpConfig.mcpServers['server-alpha']).toBeDefined()
  })
})
