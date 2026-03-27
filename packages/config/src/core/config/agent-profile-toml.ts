import TOML from '@iarna/toml'

import { ConfigParseError, ConfigValidationError } from '../errors.js'
import type { AgentRuntimeProfile, HarnessSettings, RunMode } from '../types/agent-profile.js'
import { type SpaceRefString, isSpaceRefString } from '../types/refs.js'

const AGENT_PROFILE_FILENAME = 'agent-profile.toml'
const RUN_MODES = new Set<RunMode>(['query', 'heartbeat', 'task', 'maintenance'])

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
  path: string
): HarnessSettings | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isPlainObject(value)) {
    fail(source, path, 'must be a table', 'type')
  }

  assertOnlyKeys(value, ['model', 'sandboxMode', 'approvalPolicy', 'profile'], source, path)

  const settings: HarnessSettings = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') {
      fail(source, `${path}/${key}`, 'must be a string', 'type')
    }
    settings[key as keyof HarnessSettings] = raw
  }
  return settings
}

function parseHarnessByMode(
  value: unknown,
  source: string,
  path: string
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
    const parsedSettings = parseHarnessSettings(settings, source, `${path}/${mode}`)
    if (parsedSettings) {
      result[mode as RunMode] = parsedSettings
    }
  }
  return result
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
    ['schemaVersion', 'instructions', 'spaces', 'targets', 'harnessDefaults', 'harnessByMode'],
    source,
    ''
  )

  if (parsed['schemaVersion'] !== 1) {
    fail(source, '/schemaVersion', 'unsupported schema version; expected 1', 'const')
  }

  const profile: AgentRuntimeProfile = {
    schemaVersion: 1,
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
    '/harnessDefaults'
  )
  profile.harnessByMode = parseHarnessByMode(parsed['harnessByMode'], source, '/harnessByMode')

  return profile
}
