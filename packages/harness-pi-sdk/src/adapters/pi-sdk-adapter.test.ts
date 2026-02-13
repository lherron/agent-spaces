import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComposeTargetInput, ComposedTargetBundle, ResolvedSpaceArtifact } from 'spaces-config'
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

  describe('buildRunArgs', () => {
    test('uses default model openai-codex:gpt-5.3-codex when no model specified', async () => {
      const outputDir = join(tmpDir, 'output')
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

      const args = adapter.buildRunArgs(bundle, {})
      expect(args).toContain('--model')
      const modelIndex = args.indexOf('--model')
      expect(args[modelIndex + 1]).toBe('openai-codex:gpt-5.3-codex')
    })

    test('uses custom model when specified', async () => {
      const outputDir = join(tmpDir, 'output')
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

      const args = adapter.buildRunArgs(bundle, { model: 'anthropic:claude-3-opus' })
      expect(args).toContain('--model')
      const modelIndex = args.indexOf('--model')
      expect(args[modelIndex + 1]).toBe('anthropic:claude-3-opus')
    })
  })
})
