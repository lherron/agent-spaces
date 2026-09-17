/**
 * buildMuseServeDescriptor tests: spawn shape stays minimal — model/effort
 * travel as data (wire-side), never as serve CLI flags.
 */
import { describe, expect, test } from 'bun:test'
import { buildMuseServeDescriptor } from './descriptor.js'

describe('buildMuseServeDescriptor', () => {
  test('defaults to muse serve --trust-workspace with workspace for session/start', () => {
    const descriptor = buildMuseServeDescriptor({ rootDir: '/out' })
    expect(descriptor.bin).toBe('muse')
    expect(descriptor.workspace).toBe('/out/muse.workspace')
    expect(descriptor.args).toEqual(['serve', '--trust-workspace'])
  })

  test('model/effort/approval ride as data, not CLI flags', () => {
    const descriptor = buildMuseServeDescriptor(
      { rootDir: '/out', workspaceDir: '/out/muse.workspace' },
      { model: 'm', reasoningEffort: 'high', approvalPolicy: 'never', extraArgs: ['--x', '1'] }
    )
    expect(descriptor.args).toEqual(['serve', '--trust-workspace', '--x', '1'])
    expect(descriptor.model).toBe('m')
    expect(descriptor.reasoningEffort).toBe('high')
    expect(descriptor.approvalPolicy).toBe('never')
  })

  test('serveBin and workspace overrides apply', () => {
    const descriptor = buildMuseServeDescriptor(
      { rootDir: '/out' },
      { serveBin: '/custom/muse', workspace: '/w' }
    )
    expect(descriptor.bin).toBe('/custom/muse')
    expect(descriptor.workspace).toBe('/w')
  })
})
