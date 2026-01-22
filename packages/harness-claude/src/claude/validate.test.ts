/**
 * Tests for claude validate module.
 *
 * WHY: Plugin validation catches configuration issues early.
 * These tests verify correct detection of various problems.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type PluginValidationResult,
  checkPluginNameCollisions,
  validatePlugin,
} from './validate.js'

const testDir = join(import.meta.dir, '../.test-plugins')

beforeAll(async () => {
  await mkdir(testDir, { recursive: true })
})

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('validatePlugin', () => {
  it('should fail for non-existent directory', async () => {
    const result = await validatePlugin('/non/existent/path')
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('should fail for missing plugin.json', async () => {
    const pluginDir = join(testDir, 'no-plugin-json')
    await mkdir(pluginDir, { recursive: true })

    const result = await validatePlugin(pluginDir)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Missing required .claude-plugin/plugin.json file')
  })

  it('should fail for missing name in plugin.json', async () => {
    const pluginDir = join(testDir, 'no-name')
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(pluginDir, '.claude-plugin/plugin.json'),
      JSON.stringify({ version: '1.0.0' })
    )

    const result = await validatePlugin(pluginDir)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain("plugin.json missing required 'name' field")
  })

  it('should pass for valid plugin', async () => {
    const pluginDir = join(testDir, 'valid')
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(pluginDir, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'my-plugin', version: '1.0.0' })
    )

    const result = await validatePlugin(pluginDir)
    expect(result.valid).toBe(true)
    expect(result.pluginName).toBe('my-plugin')
    expect(result.pluginVersion).toBe('1.0.0')
  })

  it('should warn for non-kebab-case names', async () => {
    const pluginDir = join(testDir, 'bad-name')
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(pluginDir, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'MyPlugin' })
    )

    const result = await validatePlugin(pluginDir)
    expect(result.valid).toBe(true) // Still valid, just a warning
    expect(result.warnings.some((w) => w.includes('kebab-case'))).toBe(true)
  })
})

describe('checkPluginNameCollisions', () => {
  it('should detect duplicate plugin names', () => {
    const results: PluginValidationResult[] = [
      { path: '/path/a', valid: true, errors: [], warnings: [], pluginName: 'shared-name' },
      { path: '/path/b', valid: true, errors: [], warnings: [], pluginName: 'shared-name' },
      { path: '/path/c', valid: true, errors: [], warnings: [], pluginName: 'unique-name' },
    ]

    const collisions = checkPluginNameCollisions(results)
    expect(collisions.length).toBe(1)
    expect(collisions[0]).toContain('shared-name')
  })

  it('should return empty for no collisions', () => {
    const results: PluginValidationResult[] = [
      { path: '/path/a', valid: true, errors: [], warnings: [], pluginName: 'name-a' },
      { path: '/path/b', valid: true, errors: [], warnings: [], pluginName: 'name-b' },
    ]

    const collisions = checkPluginNameCollisions(results)
    expect(collisions.length).toBe(0)
  })
})
