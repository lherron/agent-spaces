/**
 * Tests for plugin-json module.
 *
 * WHY: Plugin.json generation is core to materialization.
 * These tests verify correct field mapping from manifests.
 */

import { describe, expect, it } from 'bun:test'
import type { SpaceId, SpaceManifest } from '../core/index.js'
import { type PluginJson, generatePluginJson } from './plugin-json.js'

function createManifest(overrides: Partial<SpaceManifest> = {}): SpaceManifest {
  return {
    schema: 1,
    id: 'test-space' as SpaceId,
    ...overrides,
  }
}

const pluginJsonCases: Array<[string, Partial<SpaceManifest>, PluginJson]> = [
  [
    'plugin.name overrides the space id',
    { plugin: { name: 'custom-plugin' } },
    { name: 'custom-plugin' },
  ],
  ['the space version is copied', { version: '1.2.3' }, { name: 'test-space', version: '1.2.3' }],
  [
    'plugin.version beats the space version',
    { version: '1.0.0', plugin: { version: '2.0.0' } },
    { name: 'test-space', version: '2.0.0' },
  ],
  [
    'plugin.description is used',
    { plugin: { description: 'A test plugin' } },
    { name: 'test-space', description: 'A test plugin' },
  ],
  [
    'the space description is the fallback',
    { description: 'Space description' },
    { name: 'test-space', description: 'Space description' },
  ],
  [
    'author name, email and url are copied',
    {
      plugin: {
        author: { name: 'Test Author', email: 'test@example.com', url: 'https://example.com' },
      },
    },
    {
      name: 'test-space',
      author: { name: 'Test Author', email: 'test@example.com', url: 'https://example.com' },
    },
  ],
  [
    'homepage, repository, license and keywords are copied',
    {
      plugin: {
        homepage: 'https://example.com',
        repository: 'https://github.com/test/repo',
        license: 'MIT',
        keywords: ['test', 'plugin'],
      },
    },
    {
      name: 'test-space',
      homepage: 'https://example.com',
      repository: 'https://github.com/test/repo',
      license: 'MIT',
      keywords: ['test', 'plugin'],
    },
  ],
  ['absent optional fields are omitted', {}, { name: 'test-space' }],
]

describe('generatePluginJson', () => {
  it.each(pluginJsonCases)(
    'space.toml plugin metadata maps into .claude-plugin/plugin.json, plugin.* overriding space fields: %s',
    (_case, overrides, expected) => {
      expect(generatePluginJson(createManifest(overrides))).toStrictEqual(expected)
    }
  )
})
