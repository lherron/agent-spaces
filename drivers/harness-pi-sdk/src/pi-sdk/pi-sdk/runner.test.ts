import { describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComposedTargetBundle } from 'spaces-config'
import { PiSdkAdapter } from '../../adapters/pi-sdk-adapter.js'
import { parseArgs } from './runner.js'

describe('runner parseArgs', () => {
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
