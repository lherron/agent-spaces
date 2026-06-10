import { createHash } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import {
  type ComposedTargetBundle,
  type HarnessAdapter,
  type HarnessRunOptions,
  PathResolver,
  copyDir,
  getAspHome,
  getProjectAgentScopePath,
  sanitizeProjectAgentScopeSegment,
  withLock,
} from 'spaces-config'
import {
  CODEX_INTERACTIVE_HOOK_EVENTS,
  buildHrcCodexHooksConfig,
  trustCodexHooksInConfigToml,
} from 'spaces-harness-codex'

import { moveDirWithCopyFallback, pathExists } from './run/util.js'

function isWithinPath(path: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/')
}

/** Hex length of the truncated sha256 used to key an ad-hoc codex runtime home. */
const CODEX_RUNTIME_KEY_LENGTH = 24

function computeCodexRuntimeKey(targetName: string, cwd: string): string {
  return createHash('sha256')
    .update(`codex-runtime-v1\0${targetName}\0${resolve(cwd)}`)
    .digest('hex')
    .slice(0, CODEX_RUNTIME_KEY_LENGTH)
}

interface CodexRuntimeMetadata {
  schemaVersion: 1
  harnessId: 'codex'
  mode: 'project' | 'ad-hoc'
  targetName: string
  complete?: true | undefined
  fingerprint?: string | undefined
  projectPath?: string | undefined
  cwd?: string | undefined
}

export function getProjectCodexRuntimeHomePath(
  aspHome: string,
  projectPath: string,
  targetName: string
): string {
  return getProjectAgentScopePath(aspHome, projectPath, targetName)
}

function getLegacyProjectCodexRuntimeHomePath(projectPath: string, targetName: string): string {
  return join(projectPath, 'asp_modules', targetName, 'codex', 'codex.runtime')
}

const CODEX_RUNTIME_METADATA_FILE = '.asp-runtime.json'

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function computeCodexRuntimeFingerprint(input: {
  templateHome: string
  bundleRoot: string
  targetName: string
  projectPath?: string | undefined
  cwd?: string | undefined
  interactive?: boolean | undefined
}): string {
  return createHash('sha256')
    .update(
      stableJson({
        schemaVersion: 1,
        templateHome: resolve(input.templateHome),
        bundleRoot: resolve(input.bundleRoot),
        targetName: input.targetName,
        projectPath: input.projectPath ? resolve(input.projectPath) : undefined,
        cwd: input.cwd ? resolve(input.cwd) : undefined,
        interactive: input.interactive === true,
      })
    )
    .digest('hex')
}

async function codexRuntimeHomeMatches(runtimeHome: string, fingerprint: string): Promise<boolean> {
  try {
    const metadata = JSON.parse(
      await readFile(join(runtimeHome, CODEX_RUNTIME_METADATA_FILE), 'utf-8')
    ) as CodexRuntimeMetadata
    if (metadata.complete !== true || metadata.fingerprint !== fingerprint) {
      return false
    }
    for (const required of ['AGENTS.md', 'config.toml']) {
      if (!(await pathExists(join(runtimeHome, required)))) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

async function writeCodexRuntimeMetadata(
  runtimeHome: string,
  metadata: CodexRuntimeMetadata
): Promise<void> {
  await writeFile(
    join(runtimeHome, CODEX_RUNTIME_METADATA_FILE),
    `${JSON.stringify(metadata, null, 2)}\n`
  )
}

function resolveCodexRuntimeHomePath(
  bundle: ComposedTargetBundle,
  runOptions: HarnessRunOptions
): string {
  if (runOptions.projectPath) {
    const aspHome = runOptions.aspHome ?? getAspHome()
    const runtimeTargetName = runOptions.codexRuntimeTargetName
    if (runOptions.projectId && runtimeTargetName) {
      return join(
        aspHome,
        'codex-homes',
        `${sanitizeProjectAgentScopeSegment(runOptions.projectId)}_${sanitizeProjectAgentScopeSegment(
          runtimeTargetName
        )}`
      )
    }
    if (runtimeTargetName) {
      return getProjectCodexRuntimeHomePath(aspHome, runOptions.projectPath, runtimeTargetName)
    }
    const paths = new PathResolver({ aspHome })
    const isProjectBundle =
      bundle.rootDir ===
        paths.projectHarnessOutput(runOptions.projectPath, bundle.targetName, bundle.harnessId) ||
      isWithinPath(
        bundle.rootDir,
        paths.projectHarnessBundleRoot(runOptions.projectPath, bundle.targetName)
      )
    const inferredRuntimeTargetName = isProjectBundle ? bundle.targetName : undefined
    if (inferredRuntimeTargetName) {
      return getProjectCodexRuntimeHomePath(
        aspHome,
        runOptions.projectPath,
        inferredRuntimeTargetName
      )
    }
  }

  const aspHome = runOptions.aspHome ?? getAspHome()
  const cwd = runOptions.cwd ?? runOptions.projectPath ?? process.cwd()
  const key = computeCodexRuntimeKey(bundle.targetName, cwd)
  return join(aspHome, 'codex-homes', key, 'home')
}

function formatTomlProjectKey(projectPath: string): string {
  return `[projects.${JSON.stringify(projectPath)}]`
}

export function ensureCodexProjectTrust(configToml: string, projectPath: string): string {
  const normalizedProjectPath = resolve(projectPath)
  const projectKey = formatTomlProjectKey(normalizedProjectPath)
  if (configToml.includes(projectKey)) {
    return configToml
  }

  const suffix = configToml.endsWith('\n') ? '' : '\n'
  return `${configToml}${suffix}\n${projectKey}\ntrust_level = "trusted"\n`
}

export async function migrateLegacyProjectCodexRuntimeHome(
  aspHome: string,
  projectPath: string,
  targetName: string
): Promise<string> {
  const runtimeHome = getProjectCodexRuntimeHomePath(aspHome, projectPath, targetName)
  const legacyRuntimeHome = getLegacyProjectCodexRuntimeHomePath(projectPath, targetName)

  if (runtimeHome === legacyRuntimeHome) {
    return runtimeHome
  }

  const runtimeExists = await pathExists(runtimeHome)
  const legacyExists = await pathExists(legacyRuntimeHome)
  if (runtimeExists || !legacyExists) {
    return runtimeHome
  }

  await moveDirWithCopyFallback(legacyRuntimeHome, runtimeHome, { clearDestFirst: true })

  return runtimeHome
}

/** Managed single-file entries synced from the codex.home template into the runtime home. */
const MANAGED_FILES = [
  'AGENTS.md',
  'config.toml',
  'hooks.json',
  'mcp.json',
  'manifest.json',
  'auth.json',
] as const

/** Managed directory entries synced from the codex.home template into the runtime home. */
const MANAGED_DIRS = ['skills', 'prompts'] as const

async function syncManagedFile(
  templateHome: string,
  runtimeHome: string,
  relativePath: string
): Promise<void> {
  const srcPath = join(templateHome, relativePath)
  const destPath = join(runtimeHome, relativePath)

  if (!(await pathExists(srcPath))) {
    await rm(destPath, { recursive: true, force: true })
    return
  }

  const srcStat = await lstat(srcPath)
  await rm(destPath, { recursive: true, force: true })

  if (srcStat.isSymbolicLink()) {
    const target = await readlink(srcPath)
    await symlink(target, destPath)
    return
  }

  await copyFile(srcPath, destPath)
}

async function syncManagedDir(
  templateHome: string,
  runtimeHome: string,
  relativePath: string
): Promise<void> {
  const srcPath = join(templateHome, relativePath)
  const destPath = join(runtimeHome, relativePath)

  if (!(await pathExists(srcPath))) {
    await rm(destPath, { recursive: true, force: true })
    return
  }

  await rm(destPath, { recursive: true, force: true })
  await copyDir(srcPath, destPath, { useHardlinks: false })
}

export async function prepareCodexRuntimeHome(
  bundle: ComposedTargetBundle,
  runOptions: HarnessRunOptions
): Promise<string> {
  const templateHome = bundle.codex?.homeTemplatePath ?? join(bundle.rootDir, 'codex.home')
  const runtimeHome = resolveCodexRuntimeHomePath(bundle, runOptions)
  const projectPath = runOptions.cwd ?? runOptions.projectPath
  const fingerprint = computeCodexRuntimeFingerprint({
    templateHome,
    bundleRoot: bundle.rootDir,
    targetName: runOptions.codexRuntimeTargetName ?? bundle.targetName,
    projectPath,
    cwd: runOptions.cwd,
    interactive: runOptions.interactive,
  })
  await mkdir(runtimeHome, { recursive: true })

  await withLock(
    join(runtimeHome, '.asp-runtime.lock'),
    async () => {
      if (await codexRuntimeHomeMatches(runtimeHome, fingerprint)) {
        return
      }

      for (const relativePath of MANAGED_FILES) {
        await syncManagedFile(templateHome, runtimeHome, relativePath)
      }
      for (const relativePath of MANAGED_DIRS) {
        await syncManagedDir(templateHome, runtimeHome, relativePath)
      }

      const configPath = join(runtimeHome, 'config.toml')
      const hooksPath = join(runtimeHome, 'hooks.json')
      if (runOptions.interactive === true) {
        await writeFile(
          hooksPath,
          `${JSON.stringify(buildHrcCodexHooksConfig(CODEX_INTERACTIVE_HOOK_EVENTS), null, 2)}\n`
        )
      }
      if (await pathExists(configPath)) {
        let configToml = await readFile(configPath, 'utf-8')
        if (await pathExists(hooksPath)) {
          const hooksJson = await readFile(hooksPath, 'utf-8')
          configToml = trustCodexHooksInConfigToml(configToml, hooksPath, hooksJson, {
            replaceHooksPaths: [join(templateHome, 'hooks.json')],
          })
        }
        if (projectPath) {
          configToml = ensureCodexProjectTrust(configToml, projectPath)
        }
        await writeFile(configPath, configToml)
      }

      const metadata: CodexRuntimeMetadata = projectPath
        ? {
            schemaVersion: 1,
            harnessId: 'codex',
            mode: 'project',
            targetName: runOptions.codexRuntimeTargetName ?? bundle.targetName,
            complete: true,
            fingerprint,
            projectPath: resolve(projectPath),
          }
        : {
            schemaVersion: 1,
            harnessId: 'codex',
            mode: 'ad-hoc',
            targetName: bundle.targetName,
            complete: true,
            fingerprint,
            cwd: resolve(runOptions.cwd ?? process.cwd()),
          }
      await writeCodexRuntimeMetadata(runtimeHome, metadata)
    },
    { stale: 60_000, retries: 600 }
  )

  return runtimeHome
}

export async function prepareRunOptions(
  adapter: HarnessAdapter,
  bundle: ComposedTargetBundle,
  runOptions: HarnessRunOptions
): Promise<HarnessRunOptions> {
  if (adapter.id !== 'codex') {
    return runOptions
  }

  const codexHomeDir = await prepareCodexRuntimeHome(bundle, runOptions)
  return { ...runOptions, codexHomeDir }
}
