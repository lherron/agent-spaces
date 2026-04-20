import { parse as parseToml } from '@iarna/toml'

export type SystemPromptMode = 'replace' | 'append'
export type ContextTemplateSchemaVersion = 2
export type ContextSectionType = 'file' | 'inline' | 'exec' | 'slot'

export interface WhenPredicate {
  runMode?: string | undefined
  exists?: string | undefined
}

export interface ContextSectionBase {
  name: string
  type: ContextSectionType
  when?: WhenPredicate | undefined
  maxChars?: number | undefined
}

export interface FileSectionDef extends ContextSectionBase {
  type: 'file'
  path: string
  required?: boolean | undefined
}

export interface InlineSectionDef extends ContextSectionBase {
  type: 'inline'
  content: string
}

export interface ExecSectionDef extends ContextSectionBase {
  type: 'exec'
  command: string
  timeout?: number | undefined
}

export interface SlotSectionDef extends ContextSectionBase {
  type: 'slot'
  source?: string | undefined
}

export type ContextSection = FileSectionDef | InlineSectionDef | ExecSectionDef | SlotSectionDef

export interface ContextTemplate {
  schemaVersion: ContextTemplateSchemaVersion
  mode: SystemPromptMode
  promptSections: ContextSection[]
  reminderSections: ContextSection[]
  maxChars?: number | undefined
}

const CONTEXT_SECTION_TYPES = ['file', 'inline', 'exec', 'slot'] as const
const SYSTEM_PROMPT_MODES = ['replace', 'append'] as const

export function parseContextTemplate(tomlContent: string): ContextTemplate {
  const parsed = parseTomlDocument(tomlContent)
  const schemaVersion = parseSchemaVersion(parsed['schema_version'])
  const mode = parseMode(parsed['mode'])
  const maxChars = parseOptionalPositiveInteger(parsed['max_chars'], 'Context template max_chars')

  if (parsed['section'] !== undefined) {
    throw new Error(
      'Context template does not support [[section]]; use [[prompt]] and [[reminder]]'
    )
  }

  const promptSections = parseSections(parsed['prompt'], 'prompt', schemaVersion)
  const reminderSections = parseSections(parsed['reminder'], 'reminder', schemaVersion)

  return {
    schemaVersion,
    mode,
    promptSections,
    reminderSections,
    ...(maxChars !== undefined ? { maxChars } : {}),
  }
}

function parseTomlDocument(tomlContent: string): Record<string, unknown> {
  try {
    const parsed = parseToml(tomlContent)
    if (!isRecord(parsed)) {
      throw new Error('Context template must parse to a TOML table')
    }
    return parsed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid context template TOML: ${message}`)
  }
}

function parseSchemaVersion(input: unknown): ContextTemplateSchemaVersion {
  if (!Number.isInteger(input)) {
    throw new Error(
      `Context template schema_version must be the integer 2, received ${describeValue(input)}`
    )
  }

  if (input !== 2) {
    throw new Error(`Context template schema_version must be 2, received ${input}`)
  }

  return input
}

function parseMode(input: unknown): SystemPromptMode {
  if (input === undefined) {
    return 'replace'
  }

  if (!isOneOf(input, SYSTEM_PROMPT_MODES)) {
    throw new Error(
      `Context template mode must be "replace" or "append", received ${describeValue(input)}`
    )
  }

  return input
}

function parseSections(
  input: unknown,
  tableName: 'prompt' | 'reminder',
  schemaVersion: ContextTemplateSchemaVersion
): ContextSection[] {
  if (input === undefined) {
    return []
  }

  if (!Array.isArray(input)) {
    throw new Error(`Context template ${tableName} must be an array of tables`)
  }

  return input.map((section, index) => parseSection(section, index, tableName, schemaVersion))
}

function parseSection(
  input: unknown,
  index: number,
  tableName: 'prompt' | 'reminder',
  _schemaVersion: ContextTemplateSchemaVersion
): ContextSection {
  const location = describeSection(index, tableName)
  if (!isRecord(input)) {
    throw new Error(`${location} must be a TOML table, received ${describeValue(input)}`)
  }

  const name = parseRequiredString(input['name'], `${location}.name`)
  const type = parseSectionType(input['type'], `${location}.type`)
  const when = parseWhenPredicate(input['when'], `${location}.when`)
  const maxChars = parseOptionalPositiveInteger(input['max_chars'], `${location}.max_chars`)
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
        ...(maxChars !== undefined ? { maxChars } : {}),
      }
    }

    case 'inline': {
      const content = parseRequiredString(input['content'], `${sectionLocation}.content`)

      return {
        name,
        type,
        content,
        ...(when ? { when } : {}),
        ...(maxChars !== undefined ? { maxChars } : {}),
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
        ...(maxChars !== undefined ? { maxChars } : {}),
      }
    }

    case 'slot': {
      const source = parseRequiredString(input['source'], `${sectionLocation}.source`)

      return {
        name,
        type,
        source,
        ...(when ? { when } : {}),
        ...(maxChars !== undefined ? { maxChars } : {}),
      }
    }
  }
}

function parseSectionType(input: unknown, fieldName: string): ContextSectionType {
  if (!isOneOf(input, CONTEXT_SECTION_TYPES)) {
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
    if (key !== 'runMode' && key !== 'exists') {
      throw new Error(`${fieldName}.${key} is not supported; only runMode and exists are allowed`)
    }
  }

  const runMode = parseOptionalString(input['runMode'], `${fieldName}.runMode`)
  const exists = parseOptionalString(input['exists'], `${fieldName}.exists`)

  if (runMode === undefined && exists === undefined) {
    return {}
  }

  return {
    ...(runMode !== undefined ? { runMode } : {}),
    ...(exists !== undefined ? { exists } : {}),
  }
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

function parseOptionalPositiveInteger(input: unknown, fieldName: string): number | undefined {
  if (input === undefined) {
    return undefined
  }

  if (typeof input !== 'number' || !Number.isInteger(input) || input <= 0) {
    throw new Error(`${fieldName} must be a positive integer, received ${describeValue(input)}`)
  }

  return input
}

function describeSection(index: number, tableName: 'prompt' | 'reminder'): string {
  return `Context template ${tableName}[${index + 1}]`
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
