import { createHash } from 'node:crypto'
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

import {
  type ComposedTargetBundle,
  type HarnessAdapter,
  type HarnessRunOptions,
  PathResolver,
  copyDir,
  getAspHome,
} from 'spaces-config'
import { applyPraesidiumContextToCodexHome } from 'spaces-harness-codex'

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function isWithinPath(path: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/')
}

function computeCodexRuntimeKey(targetName: string, cwd: string): string {
  return createHash('sha256')
    .update(`codex-runtime-v1\0${targetName}\0${resolve(cwd)}`)
    .digest('hex')
    .slice(0, 24)
}

interface CodexRuntimeMetadata {
  schemaVersion: 1
  harnessId: 'codex'
  mode: 'project' | 'ad-hoc'
  targetName: string
  projectPath?: string | undefined
  cwd?: string | undefined
}

function sanitizeCodexRuntimeSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
  return sanitized || 'default'
}

export function getProjectCodexRuntimeHomePath(
  aspHome: string,
  projectPath: string,
  targetName: string
): string {
  const projectSlug = sanitizeCodexRuntimeSegment(basename(resolve(projectPath)))
  const targetSlug = sanitizeCodexRuntimeSegment(targetName)
  return join(aspHome, 'codex-homes', `${projectSlug}_${targetSlug}`)
}

function getLegacyProjectCodexRuntimeHomePath(projectPath: string, targetName: string): string {
  return join(projectPath, 'asp_modules', targetName, 'codex', 'codex.runtime')
}

const CODEX_RUNTIME_METADATA_FILE = '.asp-runtime.json'

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
    const paths = new PathResolver({ aspHome })
    const runtimeTargetName =
      runOptions.codexRuntimeTargetName ??
      (isWithinPath(bundle.rootDir, paths.projectTargets(runOptions.projectPath))
        ? bundle.targetName
        : undefined)
    if (runtimeTargetName) {
      return getProjectCodexRuntimeHomePath(aspHome, runOptions.projectPath, runtimeTargetName)
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

  await mkdir(dirname(runtimeHome), { recursive: true })
  try {
    await rm(runtimeHome, { recursive: true, force: true })
    await rename(legacyRuntimeHome, runtimeHome)
  } catch {
    await rm(runtimeHome, { recursive: true, force: true })
    await cp(legacyRuntimeHome, runtimeHome, { recursive: true, force: true })
    await rm(legacyRuntimeHome, { recursive: true, force: true })
  }

  return runtimeHome
}

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
  await mkdir(runtimeHome, { recursive: true })

  await syncManagedFile(templateHome, runtimeHome, 'AGENTS.md')
  await syncManagedFile(templateHome, runtimeHome, 'config.toml')
  await syncManagedFile(templateHome, runtimeHome, 'hooks.json')
  await syncManagedFile(templateHome, runtimeHome, 'mcp.json')
  await syncManagedFile(templateHome, runtimeHome, 'manifest.json')
  await syncManagedFile(templateHome, runtimeHome, 'auth.json')
  await syncManagedDir(templateHome, runtimeHome, 'skills')
  await syncManagedDir(templateHome, runtimeHome, 'prompts')

  await applyPraesidiumContextToCodexHome(runtimeHome, {
    systemPrompt: runOptions.systemPrompt,
    reminderContent: runOptions.reminderContent,
  })

  const configPath = join(runtimeHome, 'config.toml')
  const projectPath = runOptions.cwd ?? runOptions.projectPath
  if (projectPath && (await pathExists(configPath))) {
    const configToml = await readFile(configPath, 'utf-8')
    const trustedConfig = ensureCodexProjectTrust(configToml, projectPath)
    if (trustedConfig !== configToml) {
      await writeFile(configPath, trustedConfig)
    }
  }

  const metadata: CodexRuntimeMetadata = projectPath
    ? {
        schemaVersion: 1,
        harnessId: 'codex',
        mode: 'project',
        targetName: runOptions.codexRuntimeTargetName ?? bundle.targetName,
        projectPath: resolve(projectPath),
      }
    : {
        schemaVersion: 1,
        harnessId: 'codex',
        mode: 'ad-hoc',
        targetName: bundle.targetName,
        cwd: resolve(runOptions.cwd ?? process.cwd()),
      }
  await writeCodexRuntimeMetadata(runtimeHome, metadata)

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
