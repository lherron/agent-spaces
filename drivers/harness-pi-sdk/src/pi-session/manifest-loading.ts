/**
 * Shared manifest-driven loaders for Pi SDK bundles.
 *
 * Both the library loader (`bundle.ts`) and the standalone runner
 * (`pi-sdk/pi-sdk/runner.ts`) dynamically import the manifest's extension
 * modules (asserting each exports a default function) and read its context
 * files. This is the single implementation of that machinery so both stay in
 * lock-step.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PiSdkBundleManifest } from './bundle-manifest-types.js'

export const PI_SDK_HARNESS_ID = 'pi-sdk'
export const PI_SDK_BUNDLE_SCHEMA_VERSION = 1

export type ParsedPiSdkBundleManifest = Partial<PiSdkBundleManifest> & {
  harnessId?: string | undefined
  schemaVersion?: number | undefined
}

/** A loaded manifest context file: the resolved path, its content, and label. */
export interface LoadedContextFile {
  path: string
  content: string
  label?: string | undefined
}

/** Read and parse a Pi SDK `bundle.json` without enforcing schemaVersion policy. */
export async function readPiSdkBundleManifest<TManifest = ParsedPiSdkBundleManifest>(
  manifestPath: string
): Promise<TManifest> {
  const raw = await readFile(manifestPath, 'utf-8')
  return JSON.parse(raw) as TManifest
}

/** Assert the parsed manifest belongs to the Pi SDK harness. */
export function assertPiSdkBundleHarness(
  harnessId: string | undefined,
  makeErrorMessage: (harnessId: string | undefined) => string = (harnessId) =>
    `Unexpected bundle harness: ${harnessId}`
): void {
  if (harnessId !== PI_SDK_HARNESS_ID) {
    throw new Error(makeErrorMessage(harnessId))
  }
}

/**
 * Dynamically import each extension declared in the manifest, returning the
 * default-exported (or module-level) factory functions. Throws if an extension
 * module does not export a callable factory.
 */
export async function loadManifestExtensionFactories(
  manifest: PiSdkBundleManifest,
  bundleRoot: string
): Promise<Array<(...args: never[]) => unknown>> {
  const factories: Array<(...args: never[]) => unknown> = []
  for (const extension of manifest.extensions) {
    const extensionPath = resolve(bundleRoot, extension.path)
    const module = await import(pathToFileURL(extensionPath).href)
    const factory = module.default ?? module
    if (typeof factory !== 'function') {
      throw new Error(`Extension ${extensionPath} does not export a default function`)
    }
    factories.push(factory)
  }
  return factories
}

/** Read every context file declared in the manifest, resolving paths and labels. */
export async function loadManifestContextFiles(
  manifest: PiSdkBundleManifest,
  bundleRoot: string
): Promise<LoadedContextFile[]> {
  return Promise.all(
    (manifest.contextFiles ?? []).map(async (entry) => {
      const filePath = resolve(bundleRoot, entry.path)
      const content = await readFile(filePath, 'utf-8')
      return { path: filePath, content, label: entry.label }
    })
  )
}
