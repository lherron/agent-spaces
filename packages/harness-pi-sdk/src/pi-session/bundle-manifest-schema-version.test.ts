import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiSdkAdapter } from '../adapters/pi-sdk-adapter.js'
import { loadBundleManifest } from './hook-runtime.js'

describe('Pi SDK bundle schemaVersion loader characterization (T-04641)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'pi-sdk-schema-version-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  async function writeManifest(manifest: Record<string, unknown>): Promise<void> {
    await writeFile(join(tmpDir, 'bundle.json'), JSON.stringify(manifest, null, 2))
  }

  describe('loadTargetBundle', () => {
    const adapter = new PiSdkAdapter()

    test('accepts a missing schemaVersion when the harness matches', async () => {
      // Characterization for daedalus DM#7939: loadTargetBundle currently does not
      // enforce schemaVersion, so a shared parse+harness step must not tighten it.
      await writeManifest({ harnessId: 'pi-sdk' })

      const bundle = await adapter.loadTargetBundle(tmpDir, 'target-under-test')

      expect(bundle).toMatchObject({
        harnessId: 'pi-sdk',
        targetName: 'target-under-test',
        rootDir: tmpDir,
        piSdk: {
          bundleManifestPath: join(tmpDir, 'bundle.json'),
          extensionsDir: join(tmpDir, 'extensions'),
        },
      })
    })

    test('accepts an unsupported schemaVersion when the harness matches', async () => {
      // Negative guard against accidentally inheriting loadBundleManifest's stricter
      // schemaVersion validation during the T-04641 refactor.
      await writeManifest({ schemaVersion: 2, harnessId: 'pi-sdk' })

      const bundle = await adapter.loadTargetBundle(tmpDir, 'target-under-test')

      expect(bundle.harnessId).toBe('pi-sdk')
      expect(bundle.targetName).toBe('target-under-test')
      expect(bundle.piSdk.bundleManifestPath).toBe(join(tmpDir, 'bundle.json'))
    })

    test('accepts the current schemaVersion when the harness matches', async () => {
      await writeManifest({ schemaVersion: 1, harnessId: 'pi-sdk' })

      await expect(adapter.loadTargetBundle(tmpDir, 'target-under-test')).resolves.toMatchObject({
        harnessId: 'pi-sdk',
        targetName: 'target-under-test',
      })
    })
  })

  describe('loadBundleManifest', () => {
    test('rejects a missing schemaVersion', async () => {
      await writeManifest({ harnessId: 'pi-sdk' })

      await expect(loadBundleManifest(tmpDir)).rejects.toThrow(
        'Unsupported bundle schemaVersion: undefined'
      )
    })

    test('rejects an unsupported schemaVersion', async () => {
      await writeManifest({ schemaVersion: 2, harnessId: 'pi-sdk' })

      await expect(loadBundleManifest(tmpDir)).rejects.toThrow(
        'Unsupported bundle schemaVersion: 2'
      )
    })

    test('accepts the current schemaVersion when the harness matches', async () => {
      const manifest = {
        schemaVersion: 1,
        harnessId: 'pi-sdk',
        targetName: 'target-under-test',
        rootDir: tmpDir,
        extensions: [],
      }
      await writeManifest(manifest)

      await expect(loadBundleManifest(tmpDir)).resolves.toEqual(manifest)
    })
  })
})
