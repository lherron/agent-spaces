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

    // Characterization for daedalus DM#7939: loadTargetBundle does not enforce
    // schemaVersion, so a shared parse+harness step must not tighten it (negative
    // guard against inheriting loadBundleManifest's stricter validation, T-04641).
    test.each([
      ['missing', {}],
      ['2 (unsupported)', { schemaVersion: 2 }],
      ['1 (current)', { schemaVersion: 1 }],
    ])(
      'loadTargetBundle accepts schemaVersion %s when the harness matches',
      async (_label, version) => {
        await writeManifest({ ...version, harnessId: 'pi-sdk' })

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
      }
    )
  })

  describe('loadBundleManifest', () => {
    test.each([
      ['missing', {}, 'Unsupported bundle schemaVersion: undefined'],
      ['2 (unsupported)', { schemaVersion: 2 }, 'Unsupported bundle schemaVersion: 2'],
    ])(
      'loadBundleManifest rejects schemaVersion %s, naming the value',
      async (_label, version, message) => {
        await writeManifest({ ...version, harnessId: 'pi-sdk' })

        await expect(loadBundleManifest(tmpDir)).rejects.toThrow(message)
      }
    )

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
