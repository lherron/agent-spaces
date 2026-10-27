import { expect, test } from 'bun:test'
import { buildMuseServeDescriptor } from './index.js'

test('serve descriptor preserves defaults and caller-provided wire and process options', () => {
  const basic = buildMuseServeDescriptor({ rootDir: '/out' })
  expect(basic.bin).toBe('muse')
  expect(basic.workspace).toBe('/out/muse.workspace')
  expect(basic.args).toEqual(['serve', '--trust-workspace'])

  const wire = buildMuseServeDescriptor(
    { rootDir: '/out', workspaceDir: '/out/muse.workspace' },
    { model: 'm', reasoningEffort: 'high', approvalPolicy: 'never', extraArgs: ['--x', '1'] }
  )
  expect(wire.args).toEqual(['serve', '--trust-workspace', '--x', '1'])
  expect([wire.model, wire.reasoningEffort, wire.approvalPolicy]).toEqual(['m', 'high', 'never'])

  const overrides = buildMuseServeDescriptor(
    { rootDir: '/out' },
    { serveBin: '/custom/muse', workspace: '/w' }
  )
  expect([overrides.bin, overrides.workspace]).toEqual(['/custom/muse', '/w'])
})
