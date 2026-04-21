import { describe, expect, test } from 'bun:test'
import type { ProjectManifest } from '../types/targets.js'
import { getEffectiveCodexOptions, mergeCodexOptions } from '../types/targets.js'
import { parseTargetsToml, serializeTargetsToml } from './targets-toml.js'

describe('parseTargetsToml: status_line in [codex]', () => {
  test('parses top-level [codex] status_line', () => {
    const toml = `
schema = 1

[codex]
status_line = ["model-with-reasoning", "context-remaining", "current-dir"]

[targets.default]
compose = ["space:my-space@stable"]
`
    const result = parseTargetsToml(toml)
    expect(result.codex?.status_line).toEqual([
      'model-with-reasoning',
      'context-remaining',
      'current-dir',
    ])
  })

  test('parses target-level [targets.default.codex] status_line', () => {
    const toml = `
schema = 1

[targets.default]
compose = ["space:my-space@stable"]

[targets.default.codex]
status_line = ["model", "context-remaining", "git-branch"]
`
    const result = parseTargetsToml(toml)
    expect(result.targets.default.codex?.status_line).toEqual([
      'model',
      'context-remaining',
      'git-branch',
    ])
  })
})

describe('mergeCodexOptions: status_line', () => {
  test('target override beats top-level', () => {
    const merged = mergeCodexOptions(
      { status_line: ['model-with-reasoning', 'context-remaining', 'current-dir'] },
      { status_line: ['model', 'git-branch'] }
    )
    expect(merged.status_line).toEqual(['model', 'git-branch'])
  })

  test('top-level used when target does not specify', () => {
    const merged = mergeCodexOptions(
      { status_line: ['model-with-reasoning', 'context-remaining', 'current-dir'] },
      {}
    )
    expect(merged.status_line).toEqual(['model-with-reasoning', 'context-remaining', 'current-dir'])
  })
})

describe('getEffectiveCodexOptions: status_line', () => {
  test('target-level overrides top-level', () => {
    const manifest: ProjectManifest = {
      schema: 1,
      codex: { status_line: ['model-with-reasoning', 'context-remaining', 'current-dir'] },
      targets: {
        fast: {
          compose: ['space:fast@stable'],
          codex: { status_line: ['model', 'git-branch'] },
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
      schema: 1,
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
