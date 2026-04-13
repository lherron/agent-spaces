import { describe, expect, test } from 'bun:test'

import {
  HARNESS_NAMES,
  type HarnessId,
  getHarnessCatalogEntry,
  getHarnessCatalogEntryByFrontend,
  getHarnessFrontendsForProvider,
  normalizeHarnessFrontend,
  normalizeHarnessId,
  resolveHarnessCatalogEntry,
  resolveHarnessFrontendForProvider,
  resolveHarnessProvider,
} from './harness.js'

describe('harness catalog', () => {
  test('normalizes accepted harness aliases and frontends to canonical ids', () => {
    expect(normalizeHarnessId('claude')).toBe('claude')
    expect(normalizeHarnessId('claude-code')).toBe('claude')
    expect(normalizeHarnessId('agent-sdk')).toBe('claude-agent-sdk')
    expect(normalizeHarnessId('codex-cli')).toBe('codex')
    expect(normalizeHarnessId('pi-sdk')).toBe('pi-sdk')
    expect(normalizeHarnessId('pi')).toBe('pi')
  })

  test('resolves runtime frontends only when one exists', () => {
    expect(normalizeHarnessFrontend('claude')).toBe('claude-code')
    expect(normalizeHarnessFrontend('codex')).toBe('codex-cli')
    expect(normalizeHarnessFrontend('agent-sdk')).toBe('agent-sdk')
    expect(normalizeHarnessFrontend('pi-sdk')).toBe('pi-sdk')
    expect(normalizeHarnessFrontend('pi')).toBeUndefined()
  })

  test('resolves provider families from canonical names and aliases', () => {
    expect(resolveHarnessProvider('claude-code')).toBe('anthropic')
    expect(resolveHarnessProvider('claude-agent-sdk')).toBe('anthropic')
    expect(resolveHarnessProvider('codex')).toBe('openai')
    expect(resolveHarnessProvider('pi-sdk')).toBe('openai')
    expect(resolveHarnessProvider('pi')).toBe('openai')
  })

  test('derives preferred placement frontends by provider and transport', () => {
    expect(resolveHarnessFrontendForProvider('anthropic', 'cli')).toBe('claude-code')
    expect(resolveHarnessFrontendForProvider('anthropic', 'sdk')).toBe('agent-sdk')
    expect(resolveHarnessFrontendForProvider('openai', 'cli')).toBe('codex-cli')
    expect(resolveHarnessFrontendForProvider('openai', 'sdk')).toBe('pi-sdk')
  })

  test('exposes catalog entries for ids and frontends', () => {
    const claude = getHarnessCatalogEntry('claude')
    expect(claude).toEqual({
      id: 'claude',
      aliases: ['claude-code'],
      provider: 'anthropic',
      transport: 'cli',
      frontend: 'claude-code',
    })

    expect(getHarnessCatalogEntryByFrontend('pi-sdk')).toMatchObject({
      id: 'pi-sdk',
      provider: 'openai',
      transport: 'sdk',
      frontend: 'pi-sdk',
    })
  })

  test('lists accepted harness names and provider frontends without duplicates', () => {
    expect(new Set(HARNESS_NAMES).size).toBe(HARNESS_NAMES.length)
    expect(HARNESS_NAMES).toContain('claude')
    expect(HARNESS_NAMES).toContain('claude-code')
    expect(HARNESS_NAMES).toContain('codex')
    expect(HARNESS_NAMES).toContain('codex-cli')
    expect(HARNESS_NAMES).toContain('pi')
    expect(HARNESS_NAMES).toContain('pi-sdk')

    expect(getHarnessFrontendsForProvider('anthropic')).toEqual(['claude-code', 'agent-sdk'])
    expect(getHarnessFrontendsForProvider('openai')).toEqual(['pi-sdk', 'codex-cli'])
  })

  test('resolves catalog entries for all canonical harness ids', () => {
    for (const harnessId of [
      'claude',
      'claude-agent-sdk',
      'pi',
      'pi-sdk',
      'codex',
    ] satisfies HarnessId[]) {
      expect(resolveHarnessCatalogEntry(harnessId)).toEqual(getHarnessCatalogEntry(harnessId))
    }
  })
})
