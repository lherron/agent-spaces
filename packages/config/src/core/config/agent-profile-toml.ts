import TOML from '@iarna/toml'

import { ConfigParseError, ConfigValidationError } from '../errors.js'
import type { AgentRuntimeProfile, HarnessSettings, RunMode } from '../types/agent-profile.js'
import type { AgentIdentity } from '../types/agent-profile.js'
import { type SpaceRefString, isSpaceRefString } from '../types/refs.js'
import type { ClaudeOptions, CodexOptions } from '../types/targets.js'

const AGENT_PROFILE_FILENAME = 'agent-profile.toml'
const RUN_MODES = new Set<RunMode>(['query', 'heartbeat', 'task', 'maintenance'])
const IDENTITY_HARNESSES = new Set([
  'claude-code',
  'claude',
  'codex-cli',
  'codex',
  'agent-sdk',
  'claude-agent-sdk',
  'pi',
  'pi-sdk',
])
const CODEX_APPROVAL_POLICIES = new Set(['untrusted', 'on-failure', 'on-request', 'never'])
const CODEX_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])

interface ValidationIssue {
  path: string
  message: string
  keyword: string
  params: Record<string, unknown>
}

function issue(path: string, message: string, keyword = 'validation'): ValidationIssue {
  return { path, message, keyword, params: {} }
}

function fail(source: string, path: string, message: string, keyword?: string): never {
  throw new ConfigValidationError(`Invalid ${AGENT_PROFILE_FILENAME}`, source, [
    issue(path, message, keyword),
  ])
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
  source: string,
  path: string
): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      fail(source, `${path}/${key}`, `unknown property "${key}"`, 'additionalProperties')
    }
  }
}

function parseStringArray(value: unknown, source: string, path: string): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(source, path, 'must be an array of strings', 'type')
  }
  return [...value]
}

function parseSpaceRefArray(
  value: unknown,
  source: string,
  path: string
): SpaceRefString[] | undefined {
  const refs = parseStringArray(value, source, path)
  if (!refs) {
    return undefined
  }
  for (const ref of refs) {
    if (!isSpaceRefString(ref)) {
      fail(source, path, `"${ref}" is not a valid space reference`, 'pattern')
    }
  }
  return refs as SpaceRefString[]
}

function parseByModeStringArrays(
  value: unknown,
  source: string,
  path: string
): Partial<Record<RunMode, string[]>> | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isPlainObject(value)) {
    fail(source, path, 'must be a table', 'type')
  }

  const result: Partial<Record<RunMode, string[]>> = {}
  for (const [mode, refs] of Object.entries(value)) {
    if (!RUN_MODES.has(mode as RunMode)) {
      fail(source, `${path}/${mode}`, `unsupported run mode "${mode}"`, 'enum')
    }
    const parsedRefs = parseStringArray(refs, source, `${path}/${mode}`)
    if (parsedRefs) {
      result[mode as RunMode] = parsedRefs
    }
  }
  return result
}

function parseByModeSpaceRefs(
  value: unknown,
  source: string,
  path: string
): Partial<Record<RunMode, SpaceRefString[]>> | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isPlainObject(value)) {
    fail(source, path, 'must be a table', 'type')
  }

  const result: Partial<Record<RunMode, SpaceRefString[]>> = {}
  for (const [mode, refs] of Object.entries(value)) {
    if (!RUN_MODES.has(mode as RunMode)) {
      fail(source, `${path}/${mode}`, `unsupported run mode "${mode}"`, 'enum')
    }
    if (Array.isArray(refs)) {
      const parsedRefs = parseSpaceRefArray(refs, source, `${path}/${mode}`)
      if (parsedRefs) {
        result[mode as RunMode] = parsedRefs
      }
      continue
    }
    if (isPlainObject(refs)) {
      assertOnlyKeys(refs, ['base'], source, `${path}/${mode}`)
      const parsedRefs = parseSpaceRefArray(refs['base'], source, `${path}/${mode}/base`)
      if (parsedRefs) {
        result[mode as RunMode] = parsedRefs
      }
      continue
    }
    fail(source, `${path}/${mode}`, 'must be an array of space refs or a table with base', 'type')
  }
  return result
}

function parseHarnessSettings(
  value: unknown,
  source: string,
  path: string,
  schemaVersion: 1 | 2
): HarnessSettings | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isPlainObject(value)) {
    fail(source, path, 'must be a table', 'type')
  }

  const allowedKeys =
    schemaVersion >= 2
      ? ['model', 'sandboxMode', 'approvalPolicy', 'profile', 'yolo', 'claude', 'codex']
      : ['model', 'sandboxMode', 'approvalPolicy', 'profile']
  assertOnlyKeys(value, allowedKeys, source, path)

  const settings: HarnessSettings = {}
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'yolo') {
      if (typeof raw !== 'boolean') {
        fail(source, `${path}/${key}`, 'must be a boolean', 'type')
      }
      settings.yolo = raw
      continue
    }
    if (key === 'claude') {
      settings.claude = parseClaudeOptions(raw, source, `${path}/${key}`)
      continue
    }
    if (key === 'codex') {
      settings.codex = parseCodexOptions(raw, source, `${path}/${key}`)
      continue
    }
    if (typeof raw !== 'string') {
      fail(source, `${path}/${key}`, 'must be a string', 'type')
    }
    if (key === 'model') {
      settings.model = raw
      continue
    }
    if (key === 'sandboxMode') {
      settings.sandboxMode = raw
      continue
    }
    if (key === 'approvalPolicy') {
      settings.approvalPolicy = raw
      continue
    }
    if (key === 'profile') {
      settings.profile = raw
    }
  }
  return settings
}

function parseHarnessByMode(
  value: unknown,
  source: string,
  path: string,
  schemaVersion: 1 | 2
): Partial<Record<RunMode, HarnessSettings>> | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isPlainObject(value)) {
    fail(source, path, 'must be a table', 'type')
  }

  const result: Partial<Record<RunMode, HarnessSettings>> = {}
  for (const [mode, settings] of Object.entries(value)) {
    if (!RUN_MODES.has(mode as RunMode)) {
      fail(source, `${path}/${mode}`, `unsupported run mode "${mode}"`, 'enum')
    }
    const parsedSettings = parseHarnessSettings(settings, source, `${path}/${mode}`, schemaVersion)
    if (parsedSettings) {
      result[mode as RunMode] = parsedSettings
    }
  }
  return result
}

function parseIdentity(value: unknown, source: string, path: string): AgentIdentity | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isPlainObject(value)) {
    fail(source, path, 'must be a table', 'type')
  }

  assertOnlyKeys(value, ['display', 'role', 'harness'], source, path)

  const identity: AgentIdentity = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') {
      fail(source, `${path}/${key}`, 'must be a string', 'type')
    }
    if (key === 'harness' && !IDENTITY_HARNESSES.has(raw)) {
      fail(source, `${path}/${key}`, `unsupported harness "${raw}"`, 'enum')
    }
    identity[key as keyof AgentIdentity] = raw
  }
  return identity
}

function parseClaudeOptions(
  value: unknown,
  source: string,
  path: string
): ClaudeOptions | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isPlainObject(value)) {
    fail(source, path, 'must be a table', 'type')
  }

  assertOnlyKeys(value, ['model', 'permission_mode', 'args'], source, path)

  const options: ClaudeOptions = {}
  if (value['model'] !== undefined) {
    if (typeof value['model'] !== 'string') {
      fail(source, `${path}/model`, 'must be a string', 'type')
    }
    options.model = value['model']
  }
  if (value['permission_mode'] !== undefined) {
    if (typeof value['permission_mode'] !== 'string') {
      fail(source, `${path}/permission_mode`, 'must be a string', 'type')
    }
    options.permission_mode = value['permission_mode']
  }
  if (value['args'] !== undefined) {
    const args = parseStringArray(value['args'], source, `${path}/args`)
    if (args) {
      options.args = args
    }
  }
  return options
}

function parseCodexOptions(value: unknown, source: string, path: string): CodexOptions | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isPlainObject(value)) {
    fail(source, path, 'must be a table', 'type')
  }

  assertOnlyKeys(
    value,
    ['model', 'model_reasoning_effort', 'approval_policy', 'sandbox_mode', 'profile'],
    source,
    path
  )

  const options: CodexOptions = {}
  if (value['model'] !== undefined) {
    if (typeof value['model'] !== 'string') {
      fail(source, `${path}/model`, 'must be a string', 'type')
    }
    options.model = value['model']
  }
  if (value['model_reasoning_effort'] !== undefined) {
    if (typeof value['model_reasoning_effort'] !== 'string') {
      fail(source, `${path}/model_reasoning_effort`, 'must be a string', 'type')
    }
    options.model_reasoning_effort = value['model_reasoning_effort']
  }
  if (value['approval_policy'] !== undefined) {
    if (typeof value['approval_policy'] !== 'string') {
      fail(source, `${path}/approval_policy`, 'must be a string', 'type')
    }
    if (!CODEX_APPROVAL_POLICIES.has(value['approval_policy'])) {
      fail(
        source,
        `${path}/approval_policy`,
        `unsupported approval policy "${value['approval_policy']}"`,
        'enum'
      )
    }
    options.approval_policy = value['approval_policy'] as CodexOptions['approval_policy']
  }
  if (value['sandbox_mode'] !== undefined) {
    if (typeof value['sandbox_mode'] !== 'string') {
      fail(source, `${path}/sandbox_mode`, 'must be a string', 'type')
    }
    if (!CODEX_SANDBOX_MODES.has(value['sandbox_mode'])) {
      fail(
        source,
        `${path}/sandbox_mode`,
        `unsupported sandbox mode "${value['sandbox_mode']}"`,
        'enum'
      )
    }
    options.sandbox_mode = value['sandbox_mode'] as CodexOptions['sandbox_mode']
  }
  if (value['profile'] !== undefined) {
    if (typeof value['profile'] !== 'string') {
      fail(source, `${path}/profile`, 'must be a string', 'type')
    }
    options.profile = value['profile']
  }
  return options
}

export function parseAgentProfile(content: string, filePath?: string): AgentRuntimeProfile {
  const source = filePath ?? AGENT_PROFILE_FILENAME

  let parsed: unknown
  try {
    parsed = TOML.parse(content)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ConfigParseError(`Failed to parse TOML: ${message}`, source)
  }

  if (!isPlainObject(parsed)) {
    fail(source, '/', 'must be a table', 'type')
  }

  assertOnlyKeys(
    parsed,
    [
      'schemaVersion',
      'identity',
      'priming_prompt',
      'priming_prompt_file',
      'instructions',
      'session',
      'spaces',
      'targets',
      'harnessDefaults',
      'harnessByMode',
    ],
    source,
    ''
  )

  const schemaVersion = parsed['schemaVersion']
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    fail(source, '/schemaVersion', 'unsupported schema version; expected 1 or 2', 'const')
  }

  const profile: AgentRuntimeProfile = {
    schemaVersion,
  }

  if (schemaVersion === 1) {
    for (const key of ['identity', 'priming_prompt', 'priming_prompt_file']) {
      if (parsed[key] !== undefined) {
        fail(source, `/${key}`, 'unsupported in schemaVersion 1; requires schemaVersion 2', 'const')
      }
    }
  }

  profile.identity = parseIdentity(parsed['identity'], source, '/identity')

  if (parsed['priming_prompt'] !== undefined) {
    if (typeof parsed['priming_prompt'] !== 'string') {
      fail(source, '/priming_prompt', 'must be a string', 'type')
    }
    profile.priming_prompt = parsed['priming_prompt']
  }

  if (parsed['priming_prompt_file'] !== undefined) {
    if (typeof parsed['priming_prompt_file'] !== 'string') {
      fail(source, '/priming_prompt_file', 'must be a string', 'type')
    }
    profile.priming_prompt_file = parsed['priming_prompt_file']
  }

  if (profile.priming_prompt !== undefined && profile.priming_prompt_file !== undefined) {
    fail(
      source,
      '/priming_prompt_file',
      'cannot set both priming_prompt and priming_prompt_file',
      'conflict'
    )
  }

  if (parsed['instructions'] !== undefined) {
    const instructions = parsed['instructions']
    if (!isPlainObject(instructions)) {
      fail(source, '/instructions', 'must be a table', 'type')
    }
    assertOnlyKeys(instructions, ['additionalBase', 'byMode'], source, '/instructions')
    profile.instructions = {
      additionalBase: parseStringArray(
        instructions['additionalBase'],
        source,
        '/instructions/additionalBase'
      ),
      byMode: parseByModeStringArrays(instructions['byMode'], source, '/instructions/byMode'),
    }
  }

  if (parsed['session'] !== undefined) {
    if (schemaVersion === 1) {
      fail(source, '/session', 'unsupported in schemaVersion 1; requires schemaVersion 2', 'const')
    }

    const session = parsed['session']
    if (!isPlainObject(session)) {
      fail(source, '/session', 'must be a table', 'type')
    }

    assertOnlyKeys(session, ['additionalContext', 'additionalExec'], source, '/session')
    profile.session = {
      additionalContext: parseStringArray(
        session['additionalContext'],
        source,
        '/session/additionalContext'
      ),
      additionalExec: parseStringArray(
        session['additionalExec'],
        source,
        '/session/additionalExec'
      ),
    }
  }

  if (parsed['spaces'] !== undefined) {
    const spaces = parsed['spaces']
    if (!isPlainObject(spaces)) {
      fail(source, '/spaces', 'must be a table', 'type')
    }
    assertOnlyKeys(spaces, ['base', 'byMode'], source, '/spaces')
    profile.spaces = {
      base: parseSpaceRefArray(spaces['base'], source, '/spaces/base'),
      byMode: parseByModeSpaceRefs(spaces['byMode'], source, '/spaces/byMode'),
    }
  }

  if (parsed['targets'] !== undefined) {
    const targets = parsed['targets']
    if (!isPlainObject(targets)) {
      fail(source, '/targets', 'must be a table', 'type')
    }
    profile.targets = {}
    for (const [targetName, rawTarget] of Object.entries(targets)) {
      if (!isPlainObject(rawTarget)) {
        fail(source, `/targets/${targetName}`, 'must be a table', 'type')
      }
      assertOnlyKeys(rawTarget, ['compose'], source, `/targets/${targetName}`)
      const compose = parseSpaceRefArray(
        rawTarget['compose'],
        source,
        `/targets/${targetName}/compose`
      )
      if (!compose || compose.length === 0) {
        fail(
          source,
          `/targets/${targetName}/compose`,
          'must contain at least one space reference',
          'minItems'
        )
      }
      profile.targets[targetName] = { compose }
    }
  }

  profile.harnessDefaults = parseHarnessSettings(
    parsed['harnessDefaults'],
    source,
    '/harnessDefaults',
    schemaVersion
  )
  profile.harnessByMode = parseHarnessByMode(
    parsed['harnessByMode'],
    source,
    '/harnessByMode',
    schemaVersion
  )

  return profile
}
