import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComposeTargetInput, ResolvedSpaceArtifact } from 'spaces-core'
import { PiSdkAdapter } from './pi-sdk-adapter.js'

describe('PiSdkAdapter', () => {
  let adapter: PiSdkAdapter
  let tmpDir: string

  beforeEach(async () => {
    adapter = new PiSdkAdapter()
    tmpDir = join(tmpdir(), `pi-sdk-compose-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('composeTarget writes bundle.json with ordered extensions', async () => {
    const artifactA = join(tmpDir, 'artifact-a')
    const artifactB = join(tmpDir, 'artifact-b')

    await mkdir(join(artifactA, 'extensions'), { recursive: true })
    await mkdir(join(artifactA, 'context'), { recursive: true })
    await writeFile(join(artifactA, 'extensions', 'b.js'), 'export {}')
    await writeFile(join(artifactA, 'extensions', 'a.js'), 'export {}')
    await writeFile(join(artifactA, 'context', 'space-a.md'), '# A')

    await mkdir(join(artifactB, 'extensions'), { recursive: true })
    await mkdir(join(artifactB, 'context'), { recursive: true })
    await writeFile(join(artifactB, 'extensions', 'c.js'), 'export {}')
    await writeFile(join(artifactB, 'context', 'space-b.md'), '# B')

    const artifacts: ResolvedSpaceArtifact[] = [
      {
        spaceKey: 'space-a@dev',
        spaceId: 'space-a',
        artifactPath: artifactA,
        pluginName: 'space-a',
        pluginVersion: '1.0.0',
      },
      {
        spaceKey: 'space-b@dev',
        spaceId: 'space-b',
        artifactPath: artifactB,
        pluginName: 'space-b',
        pluginVersion: '1.0.0',
      },
    ]

    const input: ComposeTargetInput = {
      targetName: 'dev',
      compose: [],
      roots: [],
      loadOrder: [],
      artifacts,
      settingsInputs: [{}, {}],
    }

    const outputDir = join(tmpDir, 'output')
    const result = await adapter.composeTarget(input, outputDir, { clean: true })

    expect(result.bundle.harnessId).toBe('pi-sdk')
    expect(result.bundle.piSdk?.bundleManifestPath).toBe(join(outputDir, 'bundle.json'))

    const manifest = JSON.parse(await readFile(join(outputDir, 'bundle.json'), 'utf-8')) as {
      extensions: Array<{ spaceId: string; path: string }>
      contextFiles: Array<{ spaceId: string; path: string; label?: string }>
      harnessId: string
    }

    expect(manifest.harnessId).toBe('pi-sdk')
    expect(manifest.extensions).toEqual([
      { spaceId: 'space-a', path: 'extensions/a.js' },
      { spaceId: 'space-a', path: 'extensions/b.js' },
      { spaceId: 'space-b', path: 'extensions/c.js' },
    ])
    expect(manifest.contextFiles).toEqual([
      { spaceId: 'space-a', path: 'context/space-a.md', label: 'space:space-a instructions' },
      { spaceId: 'space-b', path: 'context/space-b.md', label: 'space:space-b instructions' },
    ])
  })
})
