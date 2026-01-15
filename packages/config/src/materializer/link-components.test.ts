/**
 * Tests for link-components module.
 *
 * WHY: Component linking is how space content becomes plugin content.
 * These tests verify the component list and directory detection.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  COMPONENT_DIRS,
  INSTRUCTIONS_FILE_AGNOSTIC,
  INSTRUCTIONS_FILE_CLAUDE,
  linkInstructionsFile,
} from './link-components.js'

describe('COMPONENT_DIRS', () => {
  it('should include all expected directories', () => {
    expect(COMPONENT_DIRS).toContain('commands')
    expect(COMPONENT_DIRS).toContain('skills')
    expect(COMPONENT_DIRS).toContain('agents')
    expect(COMPONENT_DIRS).toContain('hooks')
    expect(COMPONENT_DIRS).toContain('scripts')
    expect(COMPONENT_DIRS).toContain('mcp')
  })

  it('should have 6 component types', () => {
    expect(COMPONENT_DIRS.length).toBe(6)
  })
})

describe('Instructions file constants', () => {
  it('should have correct agnostic filename', () => {
    expect(INSTRUCTIONS_FILE_AGNOSTIC).toBe('AGENT.md')
  })

  it('should have correct Claude filename', () => {
    expect(INSTRUCTIONS_FILE_CLAUDE).toBe('CLAUDE.md')
  })
})

describe('linkInstructionsFile', () => {
  let tempDir: string
  let snapshotDir: string
  let pluginDir: string

  beforeEach(async () => {
    tempDir = `/tmp/asp-link-instructions-test-${Date.now()}`
    snapshotDir = join(tempDir, 'snapshot')
    pluginDir = join(tempDir, 'plugin')
    await mkdir(snapshotDir, { recursive: true })
    await mkdir(pluginDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('for Claude harness', () => {
    it('should link AGENT.md as CLAUDE.md', async () => {
      const content = '# Agent Instructions\nThis is AGENT.md'
      await writeFile(join(snapshotDir, 'AGENT.md'), content)

      const result = await linkInstructionsFile(snapshotDir, pluginDir, 'claude')

      expect(result.linked).toBe(true)
      expect(result.sourceFile).toBe('AGENT.md')
      expect(result.destFile).toBe('CLAUDE.md')

      const linkedContent = await readFile(join(pluginDir, 'CLAUDE.md'), 'utf-8')
      expect(linkedContent).toBe(content)
    })

    it('should link CLAUDE.md as CLAUDE.md (legacy pattern)', async () => {
      const content = '# Claude Instructions\nThis is CLAUDE.md'
      await writeFile(join(snapshotDir, 'CLAUDE.md'), content)

      const result = await linkInstructionsFile(snapshotDir, pluginDir, 'claude')

      expect(result.linked).toBe(true)
      expect(result.sourceFile).toBe('CLAUDE.md')
      expect(result.destFile).toBe('CLAUDE.md')

      const linkedContent = await readFile(join(pluginDir, 'CLAUDE.md'), 'utf-8')
      expect(linkedContent).toBe(content)
    })

    it('should prefer AGENT.md over CLAUDE.md when both exist', async () => {
      const agentContent = '# Agent Instructions\nThis is AGENT.md'
      const claudeContent = '# Claude Instructions\nThis is CLAUDE.md'
      await writeFile(join(snapshotDir, 'AGENT.md'), agentContent)
      await writeFile(join(snapshotDir, 'CLAUDE.md'), claudeContent)

      const result = await linkInstructionsFile(snapshotDir, pluginDir, 'claude')

      expect(result.linked).toBe(true)
      expect(result.sourceFile).toBe('AGENT.md')
      expect(result.destFile).toBe('CLAUDE.md')

      const linkedContent = await readFile(join(pluginDir, 'CLAUDE.md'), 'utf-8')
      expect(linkedContent).toBe(agentContent)
    })

    it('should return not linked when no instructions file exists', async () => {
      const result = await linkInstructionsFile(snapshotDir, pluginDir, 'claude')

      expect(result.linked).toBe(false)
      expect(result.sourceFile).toBeUndefined()
      expect(result.destFile).toBeUndefined()
    })
  })

  describe('for Pi harness', () => {
    it('should link AGENT.md as AGENT.md', async () => {
      const content = '# Agent Instructions\nThis is AGENT.md'
      await writeFile(join(snapshotDir, 'AGENT.md'), content)

      const result = await linkInstructionsFile(snapshotDir, pluginDir, 'pi')

      expect(result.linked).toBe(true)
      expect(result.sourceFile).toBe('AGENT.md')
      expect(result.destFile).toBe('AGENT.md')

      const linkedContent = await readFile(join(pluginDir, 'AGENT.md'), 'utf-8')
      expect(linkedContent).toBe(content)
    })

    it('should not link CLAUDE.md for Pi (Pi only uses AGENT.md)', async () => {
      const content = '# Claude Instructions\nThis is CLAUDE.md'
      await writeFile(join(snapshotDir, 'CLAUDE.md'), content)

      const result = await linkInstructionsFile(snapshotDir, pluginDir, 'pi')

      expect(result.linked).toBe(false)
      expect(result.sourceFile).toBeUndefined()
      expect(result.destFile).toBeUndefined()
    })

    it('should return not linked when no AGENT.md exists', async () => {
      const result = await linkInstructionsFile(snapshotDir, pluginDir, 'pi')

      expect(result.linked).toBe(false)
      expect(result.sourceFile).toBeUndefined()
      expect(result.destFile).toBeUndefined()
    })
  })
})
