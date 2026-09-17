import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

export const OBSERVE_CONTINUATION_ARTIFACT_REQUEST_VERSION =
  'aspc-observe-continuation-artifact-request/v1'
export const OBSERVE_CONTINUATION_ARTIFACT_RESPONSE_VERSION =
  'aspc-observe-continuation-artifact-response/v1'

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

type UnknownRecord = Record<string, unknown>

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

export async function observeContinuationArtifact(
  request: UnknownRecord,
  options: { aspHome?: string | undefined } = {}
): Promise<Record<string, unknown>> {
  if (request['schemaVersion'] !== OBSERVE_CONTINUATION_ARTIFACT_REQUEST_VERSION) {
    return observationFailure(
      'incompatible',
      'unsupported_schema',
      'Unsupported continuation observation schema'
    )
  }
  const continuation = request['continuation'] as
    | { provider?: string; key?: string; artifactFormat?: 'claude' | 'codex' | 'pi' }
    | undefined
  if (!continuation?.provider || !continuation.key) {
    return observationFailure(
      'incompatible',
      'evidence_invalid',
      'Continuation provider and key are required'
    )
  }
  const historicalExecution = request['historicalExecution'] as UnknownRecord | undefined
  const frozen = historicalExecution?.['frozenStartRequest'] as UnknownRecord | undefined
  if (frozen && frozen['keyBinding'] !== 'runtime-continuation') {
    return observationFailure(
      'incompatible',
      'evidence_invalid',
      'Frozen evidence is not bound to the retained runtime continuation'
    )
  }

  const checkedContinuation = continuation as {
    provider: string
    key: string
    artifactFormat?: 'claude' | 'codex' | 'pi'
  }
  const normalizedProvider = normalizeProvider(checkedContinuation.provider)
  if (normalizedProvider === 'unsupported') {
    return observationFailure(
      'incompatible',
      'unsupported_provider',
      `Unsupported continuation provider ${checkedContinuation.provider}`
    )
  }
  const format = resolveArtifactFormat(checkedContinuation, frozen)
  if (format === 'conflict') {
    return observationFailure(
      'incompatible',
      'evidence_invalid',
      'Artifact format conflicts with broker driver evidence'
    )
  }
  if (
    (normalizedProvider === 'claude' && format !== 'claude') ||
    (normalizedProvider === 'codex' && format !== 'codex')
  ) {
    return observationFailure(
      'incompatible',
      'evidence_invalid',
      'Execution provider and artifact format disagree'
    )
  }
  const requested = {
    provider: continuation.provider,
    key: continuation.key,
    ...(continuation.artifactFormat ? { artifactFormat: continuation.artifactFormat } : {}),
  }
  if (format === 'unknown') {
    return observationSuccess(requested, 'unknown', 'none', {
      state: 'unknown',
      code: 'artifact_format_ambiguous',
    })
  }
  if (format === 'pi') {
    const result = await checkContinuationArtifact(
      { provider: 'pi', key: continuation.key },
      { mode: 'stat' }
    )
    return observationSuccess(
      requested,
      'pi',
      'absolute-key',
      !isAbsolute(continuation.key)
        ? { state: 'unknown', code: 'key_not_absolute' }
        : artifactState(result)
    )
  }

  if (format === 'codex') {
    const frozenHome = frozenCodexHome(frozen)
    if (frozenHome && options.aspHome && !isSameOrInside(frozenHome, options.aspHome)) {
      return observationFailure(
        'incompatible',
        'evidence_invalid',
        'Frozen provider home is outside the configured historical ASP home'
      )
    }
    const recorded = historicalExecution?.['recordedPlacement'] as UnknownRecord | undefined
    const derivedHome = deriveRecordedCodexHome(recorded, options.aspHome)
    let derivedResult: ContinuationArtifactResult | undefined
    if (derivedHome) {
      derivedResult = await checkContinuationArtifact(
        { provider: 'codex', key: continuation.key },
        { mode: 'scan', codexHome: derivedHome }
      )
    }
    if (frozenHome) {
      if (!(await isReadableDirectory(frozenHome))) {
        return observationSuccess(requested, 'codex', 'frozen-home', {
          state: 'unknown',
          code: 'home_unreadable',
        })
      }
      const frozenResult = await checkContinuationArtifact(
        { provider: 'codex', key: continuation.key },
        { mode: 'scan', codexHome: frozenHome }
      )
      const diagnostics =
        derivedResult !== undefined && derivedResult !== frozenResult
          ? [
              {
                code: 'historical_evidence_disagrees',
                message: 'Frozen provider home and recorded placement rule disagree',
              },
            ]
          : []
      return observationSuccess(
        requested,
        'codex',
        'frozen-home',
        artifactState(frozenResult),
        diagnostics
      )
    }
    if (derivedHome) {
      return observationSuccess(
        requested,
        'codex',
        'recorded-placement-rule',
        derivedResult === 'present'
          ? { state: 'present', code: 'artifact_present' }
          : { state: 'unknown', code: 'home_not_historical' }
      )
    }
    return observationSuccess(requested, 'codex', 'none', {
      state: 'unknown',
      code: 'context_unavailable',
    })
  }

  const cwd = (frozen?.['placement'] as UnknownRecord | undefined)?.['cwd'] as string | undefined
  const claudeHome = frozenClaudeHome(frozen)
  const result = await checkContinuationArtifact(
    { provider: 'claude', key: continuation.key },
    { mode: 'stat', cwd, claudeHome }
  )
  return observationSuccess(
    requested,
    'claude',
    cwd && claudeHome ? 'frozen-home' : 'none',
    cwd && claudeHome ? artifactState(result) : { state: 'unknown', code: 'context_unavailable' }
  )
}

function resolveArtifactFormat(
  continuation: { provider: string; artifactFormat?: 'claude' | 'codex' | 'pi' },
  frozen: UnknownRecord | undefined
): 'claude' | 'codex' | 'pi' | 'unknown' | 'conflict' {
  const startRequest = frozen?.['startRequest'] as UnknownRecord | undefined
  const spec = startRequest?.['spec'] as UnknownRecord | undefined
  const driverRecord = spec?.['driver'] as UnknownRecord | undefined
  const driver = frozen?.['brokerDriver'] ?? driverRecord?.['kind']
  const fromDriver = driverFormat(driver)
  if (continuation.artifactFormat && fromDriver && continuation.artifactFormat !== fromDriver) {
    return 'conflict'
  }
  if (continuation.artifactFormat) return continuation.artifactFormat
  if (fromDriver) return fromDriver
  const providerFormat = normalizeProvider(continuation.provider)
  return providerFormat === 'unsupported' ? 'unknown' : providerFormat
}

function driverFormat(driver: unknown): 'claude' | 'codex' | 'pi' | undefined {
  if (driver === 'pi-sdk' || driver === 'pi-tui-tmux') return 'pi'
  if (driver === 'codex-app-server' || driver === 'codex-cli-tmux') return 'codex'
  if (driver === 'claude-code-tmux') return 'claude'
  return undefined
}

function frozenCodexHome(frozen: UnknownRecord | undefined): string | undefined {
  const startRequest = frozen?.['startRequest'] as UnknownRecord | undefined
  const spec = startRequest?.['spec'] as UnknownRecord | undefined
  const processSpec = spec?.['process'] as UnknownRecord | undefined
  const lockedEnv = processSpec?.['lockedEnv'] as UnknownRecord | undefined
  const value = lockedEnv?.['CODEX_HOME']
  return typeof value === 'string' && isAbsolute(value) ? value : undefined
}

function frozenClaudeHome(frozen: UnknownRecord | undefined): string | undefined {
  const startRequest = frozen?.['startRequest'] as UnknownRecord | undefined
  const spec = startRequest?.['spec'] as UnknownRecord | undefined
  const processSpec = spec?.['process'] as UnknownRecord | undefined
  const lockedEnv = processSpec?.['lockedEnv'] as UnknownRecord | undefined
  const configDir = lockedEnv?.['CLAUDE_CONFIG_DIR']
  if (typeof configDir === 'string' && isAbsolute(configDir)) return configDir
  const home = lockedEnv?.['HOME']
  return typeof home === 'string' && isAbsolute(home) ? join(home, '.claude') : undefined
}

function deriveRecordedCodexHome(
  recorded: UnknownRecord | undefined,
  daemonAspHome: string | undefined
): string | undefined {
  if (!recorded) return undefined
  const placement = recorded['placement'] as UnknownRecord | undefined
  const agentRoot = placement?.['agentRoot']
  const projectRoot = placement?.['projectRoot']
  const aspHome =
    typeof recorded['aspHome'] === 'string' ? (recorded['aspHome'] as string) : daemonAspHome
  if (typeof agentRoot !== 'string' || typeof projectRoot !== 'string' || !aspHome) return undefined
  return join(aspHome, 'codex-homes', `${basename(projectRoot)}_${basename(agentRoot)}`)
}

function isSameOrInside(child: string, parent: string): boolean {
  const path = relative(resolve(parent), resolve(child))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

async function isReadableDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function artifactState(result: ContinuationArtifactResult): Record<string, string> {
  if (result === 'present') return { state: 'present', code: 'artifact_present' }
  if (result === 'missing') return { state: 'missing', code: 'artifact_missing' }
  return { state: 'unknown', code: 'home_unreadable' }
}

function observationSuccess(
  requested: Record<string, unknown>,
  format: 'claude' | 'codex' | 'pi' | 'unknown',
  basis: 'frozen-home' | 'recorded-placement-rule' | 'absolute-key' | 'none',
  artifact: Record<string, string>,
  diagnostics: Array<Record<string, string>> = []
): Record<string, unknown> {
  const provider = requested['provider']
  return {
    schemaVersion: OBSERVE_CONTINUATION_ARTIFACT_RESPONSE_VERSION,
    ok: true,
    requested,
    ...(provider === 'anthropic' || provider === 'openai' ? { executionProvider: provider } : {}),
    artifactFormat: format,
    artifact,
    basis,
    diagnostics,
  }
}

function observationFailure(kind: 'unavailable' | 'incompatible', code: string, message: string) {
  return {
    schemaVersion: OBSERVE_CONTINUATION_ARTIFACT_RESPONSE_VERSION,
    ok: false,
    failure: { kind, code, message },
  }
}

function normalizeProvider(
  provider: string
): 'pi' | 'codex' | 'claude' | 'unknown' | 'unsupported' {
  const normalized = provider.toLowerCase()
  if (normalized === 'pi' || normalized === 'pi-sdk' || normalized === 'openai/pi-sdk') {
    return 'pi'
  }
  if (
    normalized === 'codex' ||
    normalized === 'codex-cli' ||
    normalized === 'openai-codex' ||
    normalized === 'openai/codex-cli'
  ) {
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
  if (normalized === 'openai') return 'unknown'
  return 'unsupported'
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
