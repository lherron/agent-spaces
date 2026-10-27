import { describe, expect, test } from 'bun:test'
import type { ProjectManifest } from '../types/targets.js'
import { getEffectiveCodexOptions } from '../types/targets.js'
import { parseTargetsToml, serializeTargetsToml } from './targets-toml.js'

describe('getEffectiveCodexOptions: status_line', () => {
  test('target-level overrides top-level', () => {
    const manifest: ProjectManifest = {
      schema: 2,
      codex: { status_line: ['model-with-reasoning', 'context-remaining', 'current-dir'] },
      targets: {
        fast: {
          compose: ['space:fast@stable'],
          provisioning: { codex: { status_line: ['model', 'git-branch'] } },
        },
      },
    }

    const opts = getEffectiveCodexOptions(manifest, 'fast')
    expect(opts.status_line).toEqual(['model', 'git-branch'])
  })
})

describe('round-trip: status_line', () => {
  test('top-level [codex] status_line survives serialize/parse cycle', () => {
    const original: ProjectManifest = {
      schema: 2,
      codex: { status_line: ['model-with-reasoning', 'context-remaining', 'current-dir'] },
      targets: {
        default: { compose: ['space:default@stable'] },
      },
    }

    const serialized = serializeTargetsToml(original)
    const parsed = parseTargetsToml(serialized)
    expect(parsed.codex?.status_line).toEqual([
      'model-with-reasoning',
      'context-remaining',
      'current-dir',
    ])
  })
})
