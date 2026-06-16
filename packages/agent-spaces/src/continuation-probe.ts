import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

export type ContinuationArtifactResult = 'present' | 'missing' | 'unknown'

export type ContinuationArtifactRef = {
  provider: string
  key: string
}

export type CheckContinuationArtifactOptions = {
  codexHome?: string | undefined
  claudeHome?: string | undefined
  cwd?: string | undefined
  mode?: 'stat' | 'scan' | undefined
}

const CODEX_SCAN_MAX_ENTRIES = 100_000
const CODEX_SCAN_MAX_DEPTH = 8

export async function checkContinuationArtifact(
  ref: ContinuationArtifactRef,
  options: CheckContinuationArtifactOptions = {}
): Promise<ContinuationArtifactResult> {
  if (!ref.key) {
    return 'unknown'
  }

  switch (normalizeProvider(ref.provider)) {
    case 'pi':
      return statPath(ref.key, { requireAbsolute: true })
    case 'codex':
      return checkCodexContinuation(ref.key, options)
    case 'claude':
      return checkClaudeContinuation(ref.key, options)
    default:
      return 'unknown'
  }
}

function normalizeProvider(provider: string): 'pi' | 'codex' | 'claude' | 'unknown' {
  const normalized = provider.toLowerCase()
  if (normalized === 'pi' || normalized === 'pi-sdk' || normalized === 'openai/pi-sdk') {
    return 'pi'
  }
  if (normalized === 'codex' || normalized === 'codex-cli' || normalized === 'openai/codex-cli') {
    return 'codex'
  }
  if (
    normalized === 'anthropic' ||
    normalized === 'claude' ||
    normalized === 'claude-code' ||
    normalized === 'claude-code-cli'
  ) {
    return 'claude'
  }
  return 'unknown'
}

async function checkCodexContinuation(
  key: string,
  options: CheckContinuationArtifactOptions
): Promise<ContinuationArtifactResult> {
  if (options.mode !== 'scan') {
    return 'unknown'
  }

  const codexHome = options.codexHome ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
  const sessionsDir = join(codexHome, 'sessions')
  const targetSuffix = `-${key}.jsonl`
  const scanResult = await scanForCodexRollout(sessionsDir, targetSuffix)
  return scanResult
}

async function checkClaudeContinuation(
  key: string,
  options: CheckContinuationArtifactOptions
): Promise<ContinuationArtifactResult> {
  if (!options.cwd) {
    return 'unknown'
  }

  const claudeHome = options.claudeHome ?? join(homedir(), '.claude')
  const encodedCwd = encodeClaudeProjectPath(resolve(options.cwd))
  return statPath(join(claudeHome, 'projects', encodedCwd, `${key}.jsonl`))
}

function encodeClaudeProjectPath(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-')
}

async function statPath(
  filePath: string,
  options: { requireAbsolute?: boolean } = {}
): Promise<ContinuationArtifactResult> {
  if (options.requireAbsolute === true && !isAbsolute(filePath)) {
    return 'unknown'
  }

  try {
    await stat(filePath)
    return 'present'
  } catch (error) {
    return isNotFound(error) ? 'missing' : 'unknown'
  }
}

async function scanForCodexRollout(
  sessionsDir: string,
  targetSuffix: string
): Promise<ContinuationArtifactResult> {
  const pending: Array<{ path: string; depth: number }> = [{ path: sessionsDir, depth: 0 }]
  let scannedEntries = 0

  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) {
      break
    }

    let entries: Dirent<string>[]
    try {
      entries = await readdir(current.path, { withFileTypes: true })
    } catch (error) {
      if (current.path === sessionsDir && isNotFound(error)) {
        return 'missing'
      }
      return 'unknown'
    }

    scannedEntries += entries.length
    if (scannedEntries > CODEX_SCAN_MAX_ENTRIES) {
      return 'unknown'
    }

    for (const entry of entries) {
      const entryPath = join(current.path, entry.name)
      if (entry.isFile() && isMatchingCodexRollout(entry.name, targetSuffix)) {
        return 'present'
      }
      if (entry.isDirectory()) {
        if (current.depth + 1 > CODEX_SCAN_MAX_DEPTH) {
          return 'unknown'
        }
        pending.push({ path: entryPath, depth: current.depth + 1 })
      }
    }
  }

  return 'missing'
}

function isMatchingCodexRollout(fileName: string, targetSuffix: string): boolean {
  return (
    fileName.startsWith('rollout-') &&
    basename(fileName) === fileName &&
    fileName.endsWith(targetSuffix)
  )
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'ENOENT' ||
      (error as { code?: unknown }).code === 'ENOTDIR')
  )
}
