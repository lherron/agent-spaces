import { constants, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { isHarnessId } from 'spaces-config'
import { HARNESS_CATALOG } from './harness-selection/catalog.js'

export const OBSERVE_RUNTIME_CAPABILITY_REQUEST_VERSION =
  'aspc-observe-runtime-capability-request/v1'
export const OBSERVE_RUNTIME_CAPABILITY_RESPONSE_VERSION =
  'aspc-observe-runtime-capability-response/v1'

const PROBE_TIMEOUT_MS = 3_000
const PROBE_OUTPUT_LIMIT = 65_536
const CODEX_OPERATION_TIMEOUT_MS = 12_000
const CODEX_MAX_CANDIDATES = 8
const MIN_CODEX_VERSION = [0, 124, 0] as const

type Diagnostic = { code: string; probe: string; message: string; candidate?: string }
type ProbeResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; code: string; message: string }

export async function observeRuntimeCapability(
  request: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (request['schemaVersion'] !== OBSERVE_RUNTIME_CAPABILITY_REQUEST_VERSION) {
    return capabilityFailure(
      'incompatible',
      'unsupported_schema',
      'Unsupported capability observation schema'
    )
  }
  const requested = typeof request['harness'] === 'string' ? request['harness'] : ''
  const harness = normalizeHarness(requested)
  if (!harness) {
    return capabilityFailure(
      'incompatible',
      'unsupported_harness',
      `Unsupported harness ${requested}`
    )
  }
  if (harness === 'agent-harness') {
    return capabilitySuccess(requested, harness, 'present', 'present', [])
  }

  const diagnostics: Diagnostic[] = []
  if (harness === 'codex') {
    const result = await observeCodex(diagnostics)
    return capabilitySuccess(
      requested,
      harness,
      result.nativeState,
      result.preparationState,
      diagnostics
    )
  }
  const command =
    harness === 'claude'
      ? findCommand('ASP_CLAUDE_PATH', 'claude')
      : findCommand('ASP_MUSE_PATH', 'muse')
  if (!command) return capabilitySuccess(requested, harness, 'absent', 'absent', diagnostics)
  const version = await boundedProbe(command, ['--version'], PROBE_TIMEOUT_MS)
  if (!version.ok) {
    diagnostics.push({
      code: version.code,
      probe: 'version',
      message: version.message,
      candidate: command,
    })
    return capabilitySuccess(requested, harness, 'unknown', 'unknown', diagnostics)
  }
  return capabilitySuccess(requested, harness, 'present', 'present', diagnostics)
}

async function observeCodex(diagnostics: Diagnostic[]): Promise<{
  nativeState: 'present' | 'absent' | 'unknown'
  preparationState: 'present' | 'absent' | 'unknown'
}> {
  const candidates = await codexCandidates()
  if (candidates.length === 0) return { nativeState: 'absent', preparationState: 'absent' }
  const deadline = Date.now() + CODEX_OPERATION_TIMEOUT_MS
  let sawBelowMinimum = false
  for (const candidate of candidates.slice(0, CODEX_MAX_CANDIDATES)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      diagnostics.push({
        code: 'probe_timeout',
        probe: 'version',
        message: 'Codex observation deadline exceeded',
      })
      return { nativeState: 'unknown', preparationState: 'unknown' }
    }
    const version = await boundedProbe(
      candidate,
      ['--version'],
      Math.min(PROBE_TIMEOUT_MS, remaining)
    )
    if (!version.ok) {
      diagnostics.push({
        code: version.code,
        probe: 'version',
        message: version.message,
        candidate,
      })
      continue
    }
    const parsed = parseSemver(`${version.stdout}\n${version.stderr}`)
    if (!parsed || compareSemver(parsed, MIN_CODEX_VERSION) < 0) {
      sawBelowMinimum = true
      diagnostics.push({
        code: 'version_below_minimum',
        probe: 'version',
        message: `Codex version is below minimum ${MIN_CODEX_VERSION.join('.')}`,
        candidate,
      })
      continue
    }
    const helpRemaining = deadline - Date.now()
    if (helpRemaining <= 0) return { nativeState: 'present', preparationState: 'unknown' }
    const help = await boundedProbe(
      candidate,
      ['app-server', '--help'],
      Math.min(PROBE_TIMEOUT_MS, helpRemaining)
    )
    if (!help.ok) {
      diagnostics.push({
        code: help.code,
        probe: 'app-server-help',
        message: help.message,
        candidate,
      })
      return { nativeState: 'present', preparationState: 'unknown' }
    }
    return { nativeState: 'present', preparationState: 'present' }
  }
  if (sawBelowMinimum && diagnostics.every((item) => item.code === 'version_below_minimum')) {
    return { nativeState: 'absent', preparationState: 'absent' }
  }
  return { nativeState: 'unknown', preparationState: 'unknown' }
}

async function boundedProbe(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<ProbeResult> {
  let processHandle: ReturnType<typeof Bun.spawn>
  try {
    processHandle = Bun.spawn([command, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
      detached: true,
    })
  } catch (error) {
    return { ok: false, code: 'probe_failed', message: formatError(error) }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let outputBytes = 0
  let outputOverflowed = false
  let overflow: (() => void) | undefined
  const overflowSignal = new Promise<{ kind: 'overflow' }>((resolve) => {
    overflow = () => resolve({ kind: 'overflow' })
  })
  const stdoutRead = readBoundedStream(
    processHandle.stdout as ReadableStream<Uint8Array>,
    () => {
      outputOverflowed = true
      overflow?.()
      processHandle.kill()
    },
    () => outputBytes,
    (bytes) => {
      outputBytes = bytes
    }
  )
  const stderrRead = readBoundedStream(
    processHandle.stderr as ReadableStream<Uint8Array>,
    () => {
      outputOverflowed = true
      overflow?.()
      processHandle.kill()
    },
    () => outputBytes,
    (bytes) => {
      outputBytes = bytes
    }
  )
  const completion = Promise.all([
    processHandle.exited,
    stdoutRead.promise,
    stderrRead.promise,
  ]).then(([exitCode, stdout, stderr]) => ({
    kind: 'complete' as const,
    exitCode,
    stdout,
    stderr,
  }))
  const timed = await Promise.race([
    completion,
    new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
      timer.unref?.()
    }),
    overflowSignal,
  ])
  if (timer) clearTimeout(timer)
  if (timed.kind === 'timeout') {
    await terminateProbe(processHandle, stdoutRead.cancel, stderrRead.cancel)
    return { ok: false, code: 'probe_timeout', message: `Probe exceeded ${timeoutMs}ms` }
  }
  if (timed.kind === 'overflow') {
    await terminateProbe(processHandle, stdoutRead.cancel, stderrRead.cancel)
    return {
      ok: false,
      code: 'probe_output_limit',
      message: `Probe output exceeded ${PROBE_OUTPUT_LIMIT} bytes`,
    }
  }
  const stdoutResult = timed.stdout
  const stderrResult = timed.stderr
  if (outputOverflowed) {
    return {
      ok: false,
      code: 'probe_output_limit',
      message: `Probe output exceeded ${PROBE_OUTPUT_LIMIT} bytes`,
    }
  }
  if (!stdoutResult.ok || !stderrResult.ok) {
    const readFailure = !stdoutResult.ok
      ? stdoutResult.message
      : !stderrResult.ok
        ? stderrResult.message
        : 'Probe output read failed'
    return {
      ok: false,
      code: 'probe_failed',
      message: readFailure,
    }
  }
  const stdout = stdoutResult.value
  const stderr = stderrResult.value
  if (timed.exitCode !== 0) {
    const spawnFailure = timed.exitCode === 127 || /not found|bad interpreter|ENOENT/i.test(stderr)
    return {
      ok: false,
      code: spawnFailure ? 'probe_failed' : 'probe_exit_nonzero',
      message: stderr.trim() || stdout.trim() || `Probe exited ${timed.exitCode}`,
    }
  }
  return { ok: true, stdout, stderr }
}

function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  onOverflow: () => void,
  currentBytes: () => number,
  setBytes: (value: number) => void
): {
  promise: Promise<{ ok: true; value: string } | { ok: false; message: string }>
  cancel: () => Promise<void>
} {
  const reader = stream.getReader()
  return {
    promise: (async () => {
      const decoder = new TextDecoder()
      let value = ''
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          const nextBytes = currentBytes() + chunk.value.byteLength
          setBytes(nextBytes)
          if (nextBytes > PROBE_OUTPUT_LIMIT) {
            onOverflow()
            return { ok: true as const, value: '' }
          }
          value += decoder.decode(chunk.value, { stream: true })
        }
        value += decoder.decode()
        return { ok: true as const, value }
      } catch (error) {
        return { ok: false as const, message: formatError(error) }
      } finally {
        reader.releaseLock()
      }
    })(),
    cancel: async () => {
      try {
        await reader.cancel('probe observation ended')
      } catch {
        // The reader may already have reached EOF.
      }
    },
  }
}

async function terminateProbe(
  processHandle: ReturnType<typeof Bun.spawn>,
  cancelStdout: () => Promise<void>,
  cancelStderr: () => Promise<void>
): Promise<void> {
  try {
    process.kill(-processHandle.pid, 'SIGKILL')
  } catch {
    try {
      processHandle.kill(9)
    } catch {
      // The process may already have exited while its inherited pipes remained open.
    }
  }
  await Promise.all([cancelStdout(), cancelStderr()])
  await Promise.race([
    processHandle.exited.then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 250)),
  ])
}

async function capabilitySuccess(
  requested: string,
  harness: string,
  nativeState: 'present' | 'absent' | 'unknown',
  preparationState: 'present' | 'absent' | 'unknown',
  diagnostics: Diagnostic[]
): Promise<Record<string, unknown>> {
  const entry = isHarnessId(harness) ? HARNESS_CATALOG[harness] : undefined
  const credentials = await credentialFact(harness)
  const ready = preparationState === 'present' && credentials.state === 'present'
  return {
    schemaVersion: OBSERVE_RUNTIME_CAPABILITY_RESPONSE_VERSION,
    ok: true,
    harness: {
      requested,
      ...(entry !== undefined ? { modelProvider: entry.defaultModelProvider } : {}),
    },
    registration: { state: 'present', code: 'registered' },
    nativeRuntime:
      nativeState === 'present'
        ? { state: 'present', code: 'native_available' }
        : nativeState === 'absent'
          ? { state: 'absent', code: 'native_unavailable' }
          : { state: 'unknown', code: 'detection_failed' },
    credentials,
    preparation: ready
      ? { state: 'present', code: 'preparation_ready' }
      : preparationState === 'absent'
        ? { state: 'absent', code: 'native_unavailable' }
        : credentials.state === 'absent'
          ? { state: 'absent', code: 'credentials_missing' }
          : { state: 'unknown', code: 'preparation_unknown' },
    diagnostics,
  }
}

async function credentialFact(
  harness: string
): Promise<
  | { state: 'present'; code: 'credentials_present' | 'credentials_not_required' }
  | { state: 'absent'; code: 'credentials_missing' }
  | { state: 'unknown'; code: 'credential_source_unreadable' }
> {
  // agent-harness owns this retained native-worker credential probe. The
  // underlying Pi-compatible auth location is an implementation detail, not a
  // selectable harness identity.
  if (harness === 'agent-harness') {
    const present = Boolean(process.env['OPENAI_API_KEY'] || process.env['ANTHROPIC_API_KEY'])
    if (present) return { state: 'present', code: 'credentials_present' }
    return credentialPathFact(join(runtimeHome(), '.pi', 'agent', 'auth.json'))
  }
  if (harness === 'claude') {
    if (process.env['ANTHROPIC_API_KEY']) {
      return { state: 'present', code: 'credentials_present' }
    }
    return credentialPathFact(join(runtimeHome(), '.claude.json'))
  }
  if (harness === 'codex') {
    if (process.env['OPENAI_API_KEY']) return { state: 'present', code: 'credentials_present' }
    return credentialPathFact(join(runtimeHome(), '.codex', 'auth.json'))
  }
  return { state: 'present', code: 'credentials_not_required' }
}

async function credentialPathFact(
  path: string
): Promise<
  | { state: 'present'; code: 'credentials_present' }
  | { state: 'absent'; code: 'credentials_missing' }
  | { state: 'unknown'; code: 'credential_source_unreadable' }
> {
  try {
    await access(path, constants.R_OK)
    return { state: 'present', code: 'credentials_present' }
  } catch (error) {
    return isNotFound(error)
      ? { state: 'absent', code: 'credentials_missing' }
      : { state: 'unknown', code: 'credential_source_unreadable' }
  }
}

function runtimeHome(): string {
  return process.env['HOME'] ?? homedir()
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

function capabilityFailure(kind: 'unavailable' | 'incompatible', code: string, message: string) {
  return {
    schemaVersion: OBSERVE_RUNTIME_CAPABILITY_RESPONSE_VERSION,
    ok: false,
    failure: { kind, code, message },
  }
}

function normalizeHarness(
  value: string
): 'agent-harness' | 'claude' | 'codex' | 'muse' | undefined {
  return isHarnessId(value) ? value : undefined
}

function findCommand(envName: string, command: string): string | undefined {
  const override = process.env[envName]
  if (override) return override
  return (process.env['PATH'] ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, command))
    .find((candidate) => Bun.file(candidate).size > 0)
}

async function codexCandidates(): Promise<string[]> {
  const override = process.env['ASP_CODEX_PATH']
  if (override) {
    try {
      await access(override, constants.X_OK)
      return [override]
    } catch {
      return [override]
    }
  }
  const candidates = [
    ...(process.env['ASP_CODEX_SKIP_COMMON_PATHS'] === '1'
      ? []
      : [
          join(homedir(), '.local/bin/codex'),
          join(homedir(), '.bun/bin/codex'),
          '/opt/homebrew/bin/codex',
          '/usr/local/bin/codex',
        ]),
    ...(process.env['PATH'] ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, 'codex')),
  ].filter((value): value is string => Boolean(value))
  const unique = [...new Set(candidates)]
  const existing: string[] = []
  for (const candidate of unique) {
    try {
      await access(candidate, constants.X_OK)
      existing.push(candidate)
    } catch {
      // Only existing candidates consume the bounded candidate budget.
    }
  }
  return existing
}

function parseSemver(value: string): readonly [number, number, number] | undefined {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

function compareSemver(
  left: readonly [number, number, number],
  right: readonly [number, number, number]
): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
