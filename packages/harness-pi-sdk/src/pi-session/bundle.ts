import { resolve } from 'node:path'
import { loadSkills } from '@mariozechner/pi-coding-agent'
import type { ExtensionFactory, Skill } from '@mariozechner/pi-coding-agent'
import type { PiSdkBundleManifest } from './bundle-manifest-types.js'
import { buildHookExtension, collectBundleSpaceIds, loadBundleManifest } from './hook-runtime.js'
import { loadManifestContextFiles, loadManifestExtensionFactories } from './manifest-loading.js'

export type {
  PiSdkBundleHookEntry,
  PiSdkBundleManifest,
} from './bundle-manifest-types.js'

export interface PiSdkContextFile {
  path: string
  content: string
  label?: string | undefined
}

export interface LoadPiSdkBundleOptions {
  cwd: string
  yolo?: boolean
  noExtensions?: boolean
  noSkills?: boolean
  agentDir?: string
}

export interface PiSdkBundleLoadResult {
  targetName: string
  bundleRoot: string
  extensions: ExtensionFactory[]
  skills: Skill[]
  contextFiles: PiSdkContextFile[]
  manifest: PiSdkBundleManifest
}

export async function loadPiSdkBundle(
  bundleRoot: string,
  options: LoadPiSdkBundleOptions
): Promise<PiSdkBundleLoadResult> {
  const manifest = await loadBundleManifest(bundleRoot)
  const extensionFactories: ExtensionFactory[] = []
  const noExtensions = options.noExtensions ?? false
  const noSkills = options.noSkills ?? false
  const yolo = options.yolo ?? false

  const hooks = noExtensions ? [] : (manifest.hooks ?? [])
  if (hooks.length > 0) {
    const spaceIds = collectBundleSpaceIds(manifest)
    extensionFactories.push(
      buildHookExtension({
        hooks,
        bundleRoot,
        targetName: manifest.targetName,
        spaceIds,
        yolo,
        cwd: options.cwd,
      }) as ExtensionFactory
    )
  }

  if (!noExtensions) {
    const loaded = await loadManifestExtensionFactories(manifest, bundleRoot)
    extensionFactories.push(...(loaded as ExtensionFactory[]))
  }

  const contextFiles = await loadManifestContextFiles(manifest, bundleRoot)

  let skills: Skill[] = []
  if (!noSkills && manifest.skillsDir) {
    const { skills: discovered } = loadSkills({
      cwd: options.cwd,
      agentDir: options.agentDir ?? bundleRoot,
      skillPaths: [resolve(bundleRoot, manifest.skillsDir)],
      includeDefaults: false,
    })
    skills = discovered
  }

  return {
    targetName: manifest.targetName,
    bundleRoot,
    extensions: extensionFactories,
    skills,
    contextFiles,
    manifest,
  }
}
