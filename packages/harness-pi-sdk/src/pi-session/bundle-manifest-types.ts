/**
 * Shared Pi SDK bundle manifest types.
 *
 * These interfaces describe the `bundle.json` emitted by `PiSdkAdapter.composeTarget`
 * and consumed by the library loader (`bundle.ts`) and the standalone runner
 * (`pi-sdk/pi-sdk/runner.ts`). They previously existed as near-identical copies in
 * four sites; this is the single source of truth.
 */

export interface PiSdkBundleExtensionEntry {
  spaceId: string
  path: string
}

export interface PiSdkBundleContextEntry {
  spaceId: string
  path: string
  label?: string | undefined
}

export interface PiSdkBundleHookEntry {
  event: string
  script: string
  tools?: string[] | undefined
  blocking?: boolean | undefined
}

export interface PiSdkBundleManifest {
  schemaVersion: number
  harnessId: string
  targetName: string
  rootDir: string
  extensions: PiSdkBundleExtensionEntry[]
  skillsDir?: string | undefined
  contextFiles?: PiSdkBundleContextEntry[] | undefined
  hooks?: PiSdkBundleHookEntry[] | undefined
}
