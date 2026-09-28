import { parse as parseToml } from '@iarna/toml'
import { PROMPT_TASK_FIELDS, type PromptTaskField } from './task-prompt-facts.js'
import { isRecord } from './type-guards.js'

export type SystemPromptMode = 'replace' | 'append'
export type ContextTemplateSchemaVersion = 2
export type ContextSectionType = 'file' | 'inline' | 'exec' | 'slot' | 'service-probe'

export interface EnvEqualsPredicate {
  name: string
  value: string
}

export interface WhenPredicate {
  runMode?: string | undefined
  exists?: string | undefined
  envSet?: string | undefined
  envEquals?: EnvEqualsPredicate | undefined
  envNotEquals?: EnvEqualsPredicate | undefined
  /** True iff that typed task prompt fact is present (T-09860); never reads env. */
  taskField?: PromptTaskField | undefined
}

export interface SectionWrap {
  prefix?: string | undefined
  suffix?: string | undefined
}

export interface ContextSectionBase {
  name: string
  type: ContextSectionType
  when?: WhenPredicate | undefined
  maxChars?: number | undefined
  wrap?: SectionWrap | undefined
}

export interface FileSectionDef extends ContextSectionBase {
  type: 'file'
  path: string
  required?: boolean | undefined
}

/** One conditional line group of an inline section; included parts join with `\n`. */
export interface InlineSectionPart {
  content: string
  when?: WhenPredicate | undefined
}

export type InlineSectionDef = ContextSectionBase & { type: 'inline' } & (
    | { content: string; parts?: undefined }
    | { parts: InlineSectionPart[]; content?: undefined }
  )

export interface ExecSectionDef extends ContextSectionBase {
  type: 'exec'
  command: string
  timeout?: number | undefined
}

export interface SlotSectionDef extends ContextSectionBase {
  type: 'slot'
  source?: string | undefined
}

export interface ServiceProbeSpec {
  name: string
  endpoint: string
}

export interface ServiceProbeSectionDef extends ContextSectionBase {
  type: 'service-probe'
  services: ServiceProbeSpec[]
  header?: string | undefined
  timeout?: number | undefined
}

export type ContextSection =
  | FileSectionDef
  | InlineSectionDef
  | ExecSectionDef
  | SlotSectionDef
  | ServiceProbeSectionDef

export interface ContextTemplate {
  schemaVersion: ContextTemplateSchemaVersion
  mode: SystemPromptMode
  promptSections: ContextSection[]
  reminderSections: ContextSection[]
  maxChars?: number | undefined
}

const CONTEXT_SECTION_TYPES = ['file', 'inline', 'exec', 'slot', 'service-probe'] as const
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

  const promptSections = parseSections(parsed['prompt'], 'prompt')
  const reminderSections = parseSections(parsed['reminder'], 'reminder')

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

function parseSections(input: unknown, tableName: 'prompt' | 'reminder'): ContextSection[] {
  if (input === undefined) {
    return []
  }

  if (!Array.isArray(input)) {
    throw new Error(`Context template ${tableName} must be an array of tables`)
  }

  return input.map((section, index) => parseSection(section, index, tableName))
}

function parseSection(
  input: unknown,
  index: number,
  tableName: 'prompt' | 'reminder'
): ContextSection {
  const location = describeSection(index, tableName)
  if (!isRecord(input)) {
    throw new Error(`${location} must be a TOML table, received ${describeValue(input)}`)
  }

  const name = parseRequiredString(input['name'], `${location}.name`)
  const type = parseSectionType(input['type'], `${location}.type`)
  const when = parseWhenPredicate(input['when'], `${location}.when`)
  const maxChars = parseOptionalPositiveInteger(input['max_chars'], `${location}.max_chars`)
  const wrap = parseSectionWrap(input['wrap'], `${location}.wrap`)
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
        ...(wrap !== undefined ? { wrap } : {}),
      }
    }

    case 'inline': {
      const body = parseInlineBody(input, sectionLocation)

      return {
        name,
        type,
        ...body,
        ...(when ? { when } : {}),
        ...(maxChars !== undefined ? { maxChars } : {}),
        ...(wrap !== undefined ? { wrap } : {}),
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
        ...(wrap !== undefined ? { wrap } : {}),
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
        ...(wrap !== undefined ? { wrap } : {}),
      }
    }

    case 'service-probe': {
      const services = parseServiceProbeServices(input['services'], `${sectionLocation}.services`)
      const header = parseOptionalString(input['header'], `${sectionLocation}.header`)
      const timeout = parseOptionalNumber(input['timeout'], `${sectionLocation}.timeout`)

      return {
        name,
        type,
        services,
        ...(when ? { when } : {}),
        ...(header !== undefined ? { header } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
        ...(maxChars !== undefined ? { maxChars } : {}),
        ...(wrap !== undefined ? { wrap } : {}),
      }
    }
  }
}

function parseInlineBody(
  input: Record<string, unknown>,
  location: string
): { content: string } | { parts: InlineSectionPart[] } {
  if (input['parts'] === undefined) {
    return { content: parseRequiredString(input['content'], `${location}.content`) }
  }
  if (input['content'] !== undefined) {
    throw new Error(`${location} must declare either content or parts, not both`)
  }
  const parts = input['parts']
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error(`${location}.parts must be a non-empty array of { content, when? } tables`)
  }
  return {
    parts: parts.map((part, index) => {
      const where = `${location}.parts[${index}]`
      if (!isRecord(part)) {
        throw new Error(`${where} must be a TOML table, received ${describeValue(part)}`)
      }
      for (const key of Object.keys(part)) {
        if (key !== 'content' && key !== 'when') {
          throw new Error(`${where}.${key} is not supported; only content and when are allowed`)
        }
      }
      const content = parseRequiredString(part['content'], `${where}.content`)
      const when = parseWhenPredicate(part['when'], `${where}.when`)
      return { content, ...(when ? { when } : {}) }
    }),
  }
}

function parseServiceProbeServices(input: unknown, fieldName: string): ServiceProbeSpec[] {
  if (!Array.isArray(input)) {
    throw new Error(`${fieldName} must be an array of {name, endpoint} tables`)
  }
  return input.map((entry, index) => {
    const where = `${fieldName}[${index}]`
    if (!isRecord(entry)) {
      throw new Error(`${where} must be a TOML table`)
    }
    return {
      name: parseRequiredString(entry['name'], `${where}.name`),
      endpoint: parseRequiredString(entry['endpoint'], `${where}.endpoint`),
    }
  })
}

function parseSectionType(input: unknown, fieldName: string): ContextSectionType {
  if (!isOneOf(input, CONTEXT_SECTION_TYPES)) {
    throw new Error(
      `${fieldName} must be one of "file", "inline", "exec", "slot", or "service-probe", received ${describeValue(
        input
      )}`
    )
  }

  return input
}

const SUPPORTED_WHEN_KEYS = [
  'runMode',
  'exists',
  'envSet',
  'envEquals',
  'envNotEquals',
  'taskField',
] as const

function parseWhenPredicate(input: unknown, fieldName: string): WhenPredicate | undefined {
  if (input === undefined) {
    return undefined
  }

  if (!isRecord(input)) {
    throw new Error(`${fieldName} must be a TOML table, received ${describeValue(input)}`)
  }

  const keys = Object.keys(input)
  for (const key of keys) {
    if (!SUPPORTED_WHEN_KEYS.includes(key as (typeof SUPPORTED_WHEN_KEYS)[number])) {
      throw new Error(
        `${fieldName}.${key} is not supported; allowed keys are ${SUPPORTED_WHEN_KEYS.join(', ')}`
      )
    }
  }

  const runMode = parseOptionalString(input['runMode'], `${fieldName}.runMode`)
  const exists = parseOptionalString(input['exists'], `${fieldName}.exists`)
  const envSet = parseOptionalString(input['envSet'], `${fieldName}.envSet`)
  const envEquals = parseEnvEqualsPredicate(input['envEquals'], `${fieldName}.envEquals`)
  const envNotEquals = parseEnvEqualsPredicate(input['envNotEquals'], `${fieldName}.envNotEquals`)
  const taskField = parseTaskField(input['taskField'], `${fieldName}.taskField`)

  if (envSet !== undefined && envSet.length === 0) {
    throw new Error(`${fieldName}.envSet must be a non-empty env var name`)
  }

  if (
    runMode === undefined &&
    exists === undefined &&
    envSet === undefined &&
    envEquals === undefined &&
    envNotEquals === undefined &&
    taskField === undefined
  ) {
    return {}
  }

  return {
    ...(runMode !== undefined ? { runMode } : {}),
    ...(exists !== undefined ? { exists } : {}),
    ...(envSet !== undefined ? { envSet } : {}),
    ...(envEquals !== undefined ? { envEquals } : {}),
    ...(envNotEquals !== undefined ? { envNotEquals } : {}),
    ...(taskField !== undefined ? { taskField } : {}),
  }
}

function parseTaskField(input: unknown, fieldName: string): PromptTaskField | undefined {
  if (input === undefined) {
    return undefined
  }
  if (!isOneOf(input, PROMPT_TASK_FIELDS)) {
    throw new Error(
      `${fieldName} must be one of ${PROMPT_TASK_FIELDS.join(', ')}, received ${describeValue(input)}`
    )
  }
  return input
}

function parseEnvEqualsPredicate(
  input: unknown,
  fieldName: string
): EnvEqualsPredicate | undefined {
  if (input === undefined) {
    return undefined
  }

  if (!isRecord(input)) {
    throw new Error(
      `${fieldName} must be a TOML table { name = "FOO", value = "bar" }, received ${describeValue(input)}`
    )
  }

  for (const key of Object.keys(input)) {
    if (key !== 'name' && key !== 'value') {
      throw new Error(`${fieldName}.${key} is not supported; only name and value are allowed`)
    }
  }

  const name = parseRequiredString(input['name'], `${fieldName}.name`)
  const value = input['value']
  if (typeof value !== 'string') {
    throw new Error(`${fieldName}.value must be a string, received ${describeValue(value)}`)
  }

  return { name, value }
}

function parseSectionWrap(input: unknown, fieldName: string): SectionWrap | undefined {
  if (input === undefined) {
    return undefined
  }

  if (!isRecord(input)) {
    throw new Error(`${fieldName} must be a TOML table, received ${describeValue(input)}`)
  }

  const keys = Object.keys(input)
  for (const key of keys) {
    if (key !== 'prefix' && key !== 'suffix') {
      throw new Error(`${fieldName}.${key} is not supported; only prefix and suffix are allowed`)
    }
  }

  const prefix = parseOptionalString(input['prefix'], `${fieldName}.prefix`)
  const suffix = parseOptionalString(input['suffix'], `${fieldName}.suffix`)

  return {
    ...(prefix !== undefined ? { prefix } : {}),
    ...(suffix !== undefined ? { suffix } : {}),
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
