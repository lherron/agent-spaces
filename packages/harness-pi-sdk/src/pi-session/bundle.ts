import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadSkills } from '@mariozechner/pi-coding-agent'
import type { ExtensionFactory, Skill } from '@mariozechner/pi-coding-agent'
import type { PiSdkBundleManifest } from './bundle-manifest-types.js'
import { buildHookExtension, loadBundleManifest } from './hook-runtime.js'

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
    const spaceIds = Array.from(
      new Set([
        ...manifest.extensions.map((entry) => entry.spaceId),
        ...(manifest.contextFiles ?? []).map((entry) => entry.spaceId),
      ])
    )
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
    for (const extension of manifest.extensions) {
      const extensionPath = resolve(bundleRoot, extension.path)
      const module = await import(pathToFileURL(extensionPath).href)
      const factory = module.default ?? module
      if (typeof factory !== 'function') {
        throw new Error(`Extension ${extensionPath} does not export a default function`)
      }
      extensionFactories.push(factory)
    }
  }

  const contextFiles = await Promise.all(
    (manifest.contextFiles ?? []).map(async (entry) => {
      const filePath = resolve(bundleRoot, entry.path)
      const content = await readFile(filePath, 'utf-8')
      return { path: filePath, content, label: entry.label }
    })
  )

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
