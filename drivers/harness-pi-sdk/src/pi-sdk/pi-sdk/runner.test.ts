import { describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComposedTargetBundle } from 'spaces-config'
import { PiSdkAdapter } from '../../adapters/pi-sdk-adapter.js'
import { parseArgs } from './runner.js'

describe('runner parseArgs', () => {
  test('parses a slash-separated model id the adapter emits (no throw)', () => {
    // The adapter emits the project-wide slash convention (openai-codex/gpt-5.5).
    // parseArgs must capture it verbatim; the colon-based split previously threw.
    const args = parseArgs([
      '--bundle',
      '/tmp/bundle',
      '--project',
      '/tmp/project',
      '--mode',
      'print',
      '--model',
      'openai-codex/gpt-5.5',
    ])
    expect(args.model).toBe('openai-codex/gpt-5.5')
  })

  test('model resolution split uses provider/model (slash), not provider:model', () => {
    // Reproduce the runner's split logic against the adapter wire format.
    // Before the fix, split(':') yielded modelId === undefined and threw.
    const model = 'openai-codex/gpt-5.5'
    const slashIndex = model.indexOf('/')
    const provider = slashIndex > 0 ? model.slice(0, slashIndex) : ''
    const modelId = slashIndex > 0 ? model.slice(slashIndex + 1) : ''
    expect(provider).toBe('openai-codex')
    expect(modelId).toBe('gpt-5.5')
  })

  test('accepts --resume with a continuation key (no Unknown argument throw)', () => {
    const sessionPath = '/tmp/sessions/prior.jsonl'
    const args = parseArgs([
      '--bundle',
      '/tmp/bundle',
      '--project',
      '/tmp/project',
      '--mode',
      'interactive',
      '--resume',
      sessionPath,
    ])
    expect(args.resume).toBe(true)
    expect(args.resumePath).toBe(sessionPath)
  })

  test('accepts a bare --resume (continue most recent) without consuming the next flag', () => {
    const args = parseArgs([
      '--bundle',
      '/tmp/bundle',
      '--project',
      '/tmp/project',
      '--resume',
      '--mode',
      'print',
    ])
    expect(args.resume).toBe(true)
    expect(args.resumePath).toBeUndefined()
    // The trailing --mode must still be parsed, not swallowed as a resume path.
    expect(args.mode).toBe('print')
  })

  test('still rejects genuinely unknown flags', () => {
    expect(() =>
      parseArgs([
        '--bundle',
        '/tmp/bundle',
        '--project',
        '/tmp/project',
        '--mode',
        'print',
        '--nope',
      ])
    ).toThrow(/Unknown argument: --nope/)
  })

  test('round-trips the adapter buildRunArgs output through parseArgs', async () => {
    const adapter = new PiSdkAdapter()
    const outputDir = join(tmpdir(), `pi-runner-roundtrip-${Date.now()}`)
    await mkdir(join(outputDir, 'extensions'), { recursive: true })
    await writeFile(
      join(outputDir, 'bundle.json'),
      JSON.stringify({
        schemaVersion: 1,
        harnessId: 'pi-sdk',
        targetName: 'test',
        extensions: [],
      })
    )

    const bundle: ComposedTargetBundle = {
      harnessId: 'pi-sdk',
      targetName: 'test',
      rootDir: outputDir,
      piSdk: {
        bundleManifestPath: join(outputDir, 'bundle.json'),
        extensionsDir: join(outputDir, 'extensions'),
      },
    }

    const runArgs = adapter.buildRunArgs(bundle, {
      interactive: false,
      continuationKey: '/tmp/sessions/prior.jsonl',
    })

    // buildRunArgs prepends the runner module path; parseArgs consumes argv
    // after that entrypoint (mirrors process.argv.slice(2) shape).
    const parsed = parseArgs(runArgs.slice(1))
    expect(parsed.bundle).toBe(outputDir)
    expect(parsed.mode).toBe('print')
    // Default model is the slash-form id; must parse without throwing.
    expect(parsed.model).toBe('openai-codex/gpt-5.5')
    // --resume must carry the continuation key value.
    expect(parsed.resume).toBe(true)
    expect(parsed.resumePath).toBe('/tmp/sessions/prior.jsonl')
  })
})
