/**
 * Tests for plugin-json module.
 *
 * WHY: Plugin.json generation is core to materialization.
 * These tests verify correct field mapping from manifests.
 */

import { describe, expect, it } from 'bun:test'
import type { SpaceId, SpaceManifest } from 'spaces-core'
import { generatePluginJson } from './plugin-json.js'

function createManifest(overrides: Partial<SpaceManifest> = {}): SpaceManifest {
  return {
    schema: 1,
    id: 'test-space' as SpaceId,
    ...overrides,
  }
}

describe('generatePluginJson', () => {
  it('should use space id as plugin name by default', () => {
    const manifest = createManifest()
    const json = generatePluginJson(manifest)
    expect(json.name).toBe('test-space')
  })

  it('should use plugin.name if specified', () => {
    const manifest = createManifest({
      plugin: { name: 'custom-plugin' },
    })
    const json = generatePluginJson(manifest)
    expect(json.name).toBe('custom-plugin')
  })

  it('should include version from space', () => {
    const manifest = createManifest({ version: '1.2.3' })
    const json = generatePluginJson(manifest)
    expect(json.version).toBe('1.2.3')
  })

  it('should use plugin.version over space version', () => {
    const manifest = createManifest({
      version: '1.0.0',
      plugin: { version: '2.0.0' },
    })
    const json = generatePluginJson(manifest)
    expect(json.version).toBe('2.0.0')
  })

  it('should include description from plugin', () => {
    const manifest = createManifest({
      plugin: { description: 'A test plugin' },
    })
    const json = generatePluginJson(manifest)
    expect(json.description).toBe('A test plugin')
  })

  it('should fall back to space description', () => {
    const manifest = createManifest({
      description: 'Space description',
    })
    const json = generatePluginJson(manifest)
    expect(json.description).toBe('Space description')
  })

  it('should include author information', () => {
    const manifest = createManifest({
      plugin: {
        author: {
          name: 'Test Author',
          email: 'test@example.com',
          url: 'https://example.com',
        },
      },
    })
    const json = generatePluginJson(manifest)
    expect(json.author?.name).toBe('Test Author')
    expect(json.author?.email).toBe('test@example.com')
    expect(json.author?.url).toBe('https://example.com')
  })

  it('should include optional fields when present', () => {
    const manifest = createManifest({
      plugin: {
        homepage: 'https://example.com',
        repository: 'https://github.com/test/repo',
        license: 'MIT',
        keywords: ['test', 'plugin'],
      },
    })
    const json = generatePluginJson(manifest)
    expect(json.homepage).toBe('https://example.com')
    expect(json.repository).toBe('https://github.com/test/repo')
    expect(json.license).toBe('MIT')
    expect(json.keywords).toEqual(['test', 'plugin'])
  })

  it('should not include undefined optional fields', () => {
    const manifest = createManifest()
    const json = generatePluginJson(manifest)
    expect(json.version).toBeUndefined()
    expect(json.description).toBeUndefined()
    expect(json.author).toBeUndefined()
    expect(json.homepage).toBeUndefined()
  })
})
