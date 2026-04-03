import { parse as parseToml } from '@iarna/toml'

export type SystemPromptSectionType = 'file' | 'inline' | 'exec' | 'slot'

export type SystemPromptMode = 'replace' | 'append'

export type SystemPromptSlotName = 'additional-base' | 'scaffold'

export interface WhenPredicate {
  runMode?: string | undefined
}

export interface SystemPromptSectionBase {
  name: string
  type: SystemPromptSectionType
  when?: WhenPredicate | undefined
}

export interface FileSectionDef extends SystemPromptSectionBase {
  type: 'file'
  path: string
  required?: boolean | undefined
}

export interface InlineSectionDef extends SystemPromptSectionBase {
  type: 'inline'
  content: string
}

export interface ExecSectionDef extends SystemPromptSectionBase {
  type: 'exec'
  command: string
  timeout?: number | undefined
}

export interface SlotSectionDef extends SystemPromptSectionBase {
  type: 'slot'
  name: SystemPromptSlotName
}

export type SystemPromptSection =
  | FileSectionDef
  | InlineSectionDef
  | ExecSectionDef
  | SlotSectionDef

export interface SystemPromptTemplate {
  schemaVersion: number
  mode: SystemPromptMode
  sections: SystemPromptSection[]
}

const SYSTEM_PROMPT_SECTION_TYPES = ['file', 'inline', 'exec', 'slot'] as const
const SYSTEM_PROMPT_MODES = ['replace', 'append'] as const
const SYSTEM_PROMPT_SLOT_NAMES = ['additional-base', 'scaffold'] as const

export function parseSystemPromptTemplate(tomlContent: string): SystemPromptTemplate {
  const parsed = parseTomlDocument(tomlContent)
  const schemaVersion = parseSchemaVersion(parsed['schema_version'])
  const mode = parseMode(parsed['mode'])
  const sections = parseSections(parsed['section'])

  return {
    schemaVersion,
    mode,
    sections,
  }
}

function parseTomlDocument(tomlContent: string): Record<string, unknown> {
  try {
    const parsed = parseToml(tomlContent)
    if (!isRecord(parsed)) {
      throw new Error('System prompt template must parse to a TOML table')
    }
    return parsed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid system prompt template TOML: ${message}`)
  }
}

function parseSchemaVersion(input: unknown): number {
  if (!Number.isInteger(input)) {
    throw new Error(
      `System prompt template schema_version must be the integer 1, received ${describeValue(input)}`
    )
  }

  if (input !== 1) {
    throw new Error(`System prompt template schema_version must be 1, received ${input}`)
  }

  return input
}

function parseMode(input: unknown): SystemPromptMode {
  if (input === undefined) {
    return 'replace'
  }

  if (!isOneOf(input, SYSTEM_PROMPT_MODES)) {
    throw new Error(
      `System prompt template mode must be "replace" or "append", received ${describeValue(input)}`
    )
  }

  return input
}

function parseSections(input: unknown): SystemPromptSection[] {
  if (input === undefined) {
    return []
  }

  if (!Array.isArray(input)) {
    throw new Error('System prompt template section must be an array of tables')
  }

  return input.map((section, index) => parseSection(section, index))
}

function parseSection(input: unknown, index: number): SystemPromptSection {
  const location = describeSection(index)
  if (!isRecord(input)) {
    throw new Error(`${location} must be a TOML table, received ${describeValue(input)}`)
  }

  const name = parseRequiredString(input['name'], `${location}.name`)
  const type = parseSectionType(input['type'], `${location}.type`)
  const when = parseWhenPredicate(input['when'], `${location}.when`)
  const sectionLocation = `${location} (${name})`

  switch (type) {
    case 'file': {
      const path = parseRequiredString(input['path'], `${sectionLocation}.path`)
      const required = parseOptionalBoolean(input['required'], `${sectionLocation}.required`)

      return {
        name,
        type,
        path,
        ...(when ? { when } : {}),
        ...(required !== undefined ? { required } : {}),
      }
    }

    case 'inline': {
      const content = parseRequiredString(input['content'], `${sectionLocation}.content`)

      return {
        name,
        type,
        content,
        ...(when ? { when } : {}),
      }
    }

    case 'exec': {
      const command = parseRequiredString(input['command'], `${sectionLocation}.command`)
      const timeout = parseOptionalNumber(input['timeout'], `${sectionLocation}.timeout`)

      return {
        name,
        type,
        command,
        ...(when ? { when } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
      }
    }

    case 'slot': {
      if (!isOneOf(name, SYSTEM_PROMPT_SLOT_NAMES)) {
        throw new Error(
          `${sectionLocation}.name must be "additional-base" or "scaffold" for slot sections, received ${describeValue(
            name
          )}`
        )
      }

      return {
        name,
        type,
        ...(when ? { when } : {}),
      }
    }
  }
}

function parseSectionType(input: unknown, fieldName: string): SystemPromptSectionType {
  if (!isOneOf(input, SYSTEM_PROMPT_SECTION_TYPES)) {
    throw new Error(
      `${fieldName} must be one of "file", "inline", "exec", or "slot", received ${describeValue(
        input
      )}`
    )
  }

  return input
}

function parseWhenPredicate(input: unknown, fieldName: string): WhenPredicate | undefined {
  if (input === undefined) {
    return undefined
  }

  if (!isRecord(input)) {
    throw new Error(`${fieldName} must be a TOML table, received ${describeValue(input)}`)
  }

  const keys = Object.keys(input)
  for (const key of keys) {
    if (key !== 'runMode') {
      throw new Error(`${fieldName}.${key} is not supported; only runMode is allowed`)
    }
  }

  const runMode = parseOptionalString(input['runMode'], `${fieldName}.runMode`)
  if (runMode === undefined) {
    return {}
  }

  return { runMode }
}

function parseRequiredString(input: unknown, fieldName: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string, received ${describeValue(input)}`)
  }

  return input
}

function parseOptionalString(input: unknown, fieldName: string): string | undefined {
  if (input === undefined) {
    return undefined
  }

  if (typeof input !== 'string') {
    throw new Error(`${fieldName} must be a string, received ${describeValue(input)}`)
  }

  return input
}

function parseOptionalBoolean(input: unknown, fieldName: string): boolean | undefined {
  if (input === undefined) {
    return undefined
  }

  if (typeof input !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean, received ${describeValue(input)}`)
  }

  return input
}

function parseOptionalNumber(input: unknown, fieldName: string): number | undefined {
  if (input === undefined) {
    return undefined
  }

  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error(`${fieldName} must be a finite number, received ${describeValue(input)}`)
  }

  return input
}

function describeSection(index: number): string {
  return `System prompt template section[${index + 1}]`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && values.includes(value)
}

function describeValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined'
  }

  if (typeof value === 'string') {
    return JSON.stringify(value)
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  if (Array.isArray(value)) {
    return 'an array'
  }

  if (value === null) {
    return 'null'
  }

  return typeof value === 'object' ? 'an object' : typeof value
}
