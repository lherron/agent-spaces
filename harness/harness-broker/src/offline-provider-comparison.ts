import { createHash } from 'node:crypto'
import type {
  BrokerComparisonForm,
  ComparisonPayload,
  InvocationEventEnvelope,
  ProviderObservation,
  ProviderObservationType,
} from 'spaces-harness-broker-protocol'
import { PROVIDER_OBSERVATION_SCHEMA } from 'spaces-harness-broker-protocol'

type Provider = 'codex' | 'claude-code' | 'unknown'
type Disposition = 'ignored' | 'unsupported' | 'unknown'
type NormalizedToolResult =
  | { output?: string | undefined; exitCode?: number | undefined }
  | { content: unknown[] }
type AdapterResult = {
  observation?: ProviderObservation | undefined
  warning?: string | undefined
  disposition?: Disposition | undefined
  provider?: Exclude<Provider, 'unknown'> | undefined
}

export interface ProviderPageResult {
  provider: Provider
  providerBeforePage: Provider
  observations: ProviderObservation[]
  warnings: string[]
  counts: {
    lines: number
    parsedRecords: number
    invalidJsonRecords: number
    applicableObservations: number
    ignoredRecords: number
    unsupportedRecords: number
    unknownRecords: number
    observationsByType: Record<ProviderObservationType, number>
  }
}

export function parseProviderPage(input: {
  lines: string[]
  afterLine: number
  throughLine: number
}): ProviderPageResult {
  const ignoredCodexCallIds = new Set<string>()
  const observations: ProviderObservation[] = []
  const warnings: string[] = []
  const counts = emptyCounts()
  let provider: Provider = 'unknown'
  let seenProvider: Exclude<Provider, 'unknown'> | undefined
  let mixedProviders = false
  let providerBeforePage: Provider = 'unknown'

  for (let index = 0; index < input.throughLine; index += 1) {
    const physicalLine = index + 1
    const line = input.lines[index] ?? ''
    const inPage = physicalLine > input.afterLine
    if (physicalLine === input.afterLine + 1) providerBeforePage = provider
    if (line.trim().length === 0) continue
    if (inPage) counts.lines += 1
    const parsed = safeJsonParse(line)
    if (!isRecord(parsed)) {
      if (inPage) {
        counts.invalidJsonRecords += 1
        warnings.push(`line ${physicalLine}: invalid JSON`)
      }
      continue
    }
    if (inPage) counts.parsedRecords += 1

    const adapted = adaptCodexRecord(parsed, physicalLine, ignoredCodexCallIds)
    const result = adapted ?? adaptClaudeRecord(parsed, physicalLine)
    if (result === undefined) {
      if (inPage && recordLooksProviderRelevant(parsed)) {
        counts.unknownRecords += 1
        warnings.push(
          `line ${physicalLine}: provider JSONL record is not capture-relevant in verifier v1`
        )
      }
      continue
    }
    if (result.provider !== undefined) {
      if (seenProvider === undefined) seenProvider = result.provider
      else if (seenProvider !== result.provider) mixedProviders = true
      provider = mixedProviders ? 'unknown' : seenProvider
    }
    if (!inPage) continue
    if (result.observation !== undefined) {
      observations.push(result.observation)
      counts.applicableObservations += 1
      counts.observationsByType[result.observation.type] += 1
    }
    if (result.warning !== undefined) warnings.push(result.warning)
    if (result.disposition !== undefined) counts[`${result.disposition}Records`] += 1
  }

  if (input.throughLine <= input.afterLine) providerBeforePage = provider

  return { provider, providerBeforePage, observations, warnings, counts }
}

export function brokerComparisonForms(events: InvocationEventEnvelope[]): BrokerComparisonForm[] {
  return events.map((event) => {
    switch (event.type) {
      case 'user.message': {
        const text = compactText(event.payload.content) ?? ''
        return comparison(event, { content: text })
      }
      case 'assistant.message.completed': {
        const text = compactText(textFromContent(event.payload.content)) ?? ''
        return comparison(event, { content: text })
      }
      case 'tool.call.started': {
        const normalizedPayload: ComparisonPayload = {
          toolCallId: event.payload.toolCallId,
          name: event.payload.name,
          input: normalizeBrokerToolInput(event.payload.input),
        }
        return comparison(event, normalizedPayload, event.payload.toolCallId)
      }
      case 'tool.call.completed': {
        const normalizedPayload: ComparisonPayload = {
          toolCallId: event.payload.toolCallId,
          result: normalizeToolResult(event.payload.result),
          ...(typeof event.payload.isError === 'boolean' ? { isError: event.payload.isError } : {}),
        }
        return comparison(event, normalizedPayload, event.payload.toolCallId)
      }
      case 'tool.call.failed': {
        const normalizedPayload: ComparisonPayload = {
          toolCallId: event.payload.toolCallId,
          result: normalizeToolResult(event.payload.message),
          isError: true,
        }
        return comparison(event, normalizedPayload, event.payload.toolCallId)
      }
      default:
        throw new Error(`non-comparable broker event type: ${event.type}`)
    }
  })
}

function comparison(
  event: InvocationEventEnvelope,
  normalizedPayload: ComparisonPayload,
  correlationKey?: string
): BrokerComparisonForm {
  return {
    seq: event.seq,
    type: event.type as ProviderObservationType,
    ...(correlationKey !== undefined ? { correlationKey } : {}),
    normalizedPayload,
    payloadHash: hashPayload(normalizedPayload),
  }
}

function adaptCodexRecord(
  record: Record<string, unknown>,
  line: number,
  ignoredCallIds: Set<string>
): AdapterResult | undefined {
  if (record['jsonrpc'] === '2.0' && typeof record['method'] === 'string') {
    if (record['method'] !== 'item/started' && record['method'] !== 'item/completed') {
      return { provider: 'codex', disposition: 'ignored' }
    }
    const params = record['params']
    const item = isRecord(params) && isRecord(params['item']) ? params['item'] : undefined
    if (item === undefined) {
      return {
        provider: 'codex',
        disposition: 'unknown',
        warning: `line ${line}: Codex ${record['method']} notification has no item`,
      }
    }
    if (item['type'] !== 'commandExecution') {
      return { provider: 'codex', disposition: 'ignored' }
    }
    const callId = stringField(item, 'id')
    if (record['method'] === 'item/started') {
      const command = stringField(item, 'command') ?? ''
      const cwd = stringField(item, 'cwd')
      return {
        provider: 'codex',
        observation: observed(
          line,
          'codex',
          'tool.call.started',
          normalizeCodexToolStart(callId, 'exec_command', {
            cmd: command,
            ...(cwd !== undefined ? { workdir: cwd } : {}),
          }),
          callId
        ),
      }
    }
    const output = typeof item['aggregatedOutput'] === 'string' ? item['aggregatedOutput'] : ''
    const exitCode = finiteNumber(item['exitCode'])
    return {
      provider: 'codex',
      observation: observed(
        line,
        'codex',
        'tool.call.completed',
        { toolCallId: callId, result: normalizeToolResult(output, exitCode) },
        callId
      ),
    }
  }

  if (record['type'] !== 'response_item') return undefined
  const payload = record['payload']
  if (!isRecord(payload)) {
    return {
      provider: 'codex',
      disposition: 'unknown',
      warning: `line ${line}: Codex response_item has non-object payload`,
    }
  }
  if (payload['type'] === 'message') {
    const text = compactText(textFromContent(payload['content']))
    if (payload['role'] === 'user') return { provider: 'codex', disposition: 'ignored' }
    if (payload['role'] === 'assistant' && text !== undefined) {
      return {
        provider: 'codex',
        observation: observed(
          line,
          'codex',
          'assistant.message.completed',
          { content: text },
          undefined,
          text
        ),
      }
    }
    return {
      provider: 'codex',
      disposition: 'unknown',
      warning: `line ${line}: Codex message response_item has no capture-relevant text`,
    }
  }
  if (payload['type'] === 'function_call') {
    const callId = stringField(payload, 'call_id') ?? stringField(payload, 'id')
    const name = stringField(payload, 'name') ?? 'unknown'
    if (name !== 'exec_command') {
      if (callId !== undefined) ignoredCallIds.add(callId)
      return {
        provider: 'codex',
        disposition: 'unsupported',
        warning: `line ${line}: Codex function_call ${name} is outside broker JSONL v1 scope`,
      }
    }
    return {
      provider: 'codex',
      observation: observed(
        line,
        'codex',
        'tool.call.started',
        normalizeCodexToolStart(callId, name, parseMaybeJson(payload['arguments'])),
        callId
      ),
    }
  }
  if (payload['type'] === 'function_call_output') {
    const callId = stringField(payload, 'call_id') ?? stringField(payload, 'id')
    if (callId !== undefined && ignoredCallIds.has(callId)) {
      return { provider: 'codex', disposition: 'ignored' }
    }
    const output = typeof payload['output'] === 'string' ? payload['output'] : ''
    if (isCodexPendingCommandOutput(output)) return { provider: 'codex', disposition: 'ignored' }
    const result = extractCodexCommandResult(output)
    return {
      provider: 'codex',
      observation: observed(
        line,
        'codex',
        'tool.call.completed',
        { toolCallId: callId, result: normalizeToolResult(result.output, result.exitCode) },
        callId
      ),
    }
  }
  return { provider: 'codex', disposition: 'ignored' }
}

function adaptClaudeRecord(
  record: Record<string, unknown>,
  line: number
): AdapterResult | undefined {
  const type = record['type']
  const message = isRecord(record['message']) ? record['message'] : record
  const role = message['role'] ?? type
  if (role !== 'user' && role !== 'assistant') return undefined
  if (role === 'user') {
    const result = firstContentBlock(message['content'], 'tool_result')
    if (result !== undefined) {
      const id = stringField(result, 'tool_use_id') ?? stringField(result, 'id')
      const rawIsError = result['is_error'] ?? result['isError']
      return {
        provider: 'claude-code',
        observation: observed(
          line,
          'claude-code',
          'tool.call.completed',
          {
            toolCallId: id,
            result: normalizeToolResult(result['content']),
            ...(typeof rawIsError === 'boolean' ? { isError: rawIsError } : {}),
          },
          id
        ),
      }
    }
    const text = compactText(textFromContent(message['content']))
    if (text !== undefined) {
      return {
        provider: 'claude-code',
        observation: observed(
          line,
          'claude-code',
          'user.message',
          { content: text },
          undefined,
          text
        ),
      }
    }
    return undefined
  }
  const toolUse = firstContentBlock(message['content'], 'tool_use')
  if (toolUse !== undefined) {
    const id = stringField(toolUse, 'id')
    return {
      provider: 'claude-code',
      observation: observed(
        line,
        'claude-code',
        'tool.call.started',
        {
          toolCallId: id,
          name: stringField(toolUse, 'name') ?? 'unknown',
          input: toolUse['input'] ?? {},
        },
        id
      ),
    }
  }
  const text = compactText(textFromContent(message['content']))
  if (text !== undefined) {
    return {
      provider: 'claude-code',
      observation: observed(
        line,
        'claude-code',
        'assistant.message.completed',
        { content: text },
        undefined,
        text
      ),
    }
  }
  return undefined
}

function observed(
  line: number,
  provider: Exclude<Provider, 'unknown'>,
  type: ProviderObservation['type'],
  normalizedPayload: ComparisonPayload,
  correlationKey?: string,
  text?: string
): ProviderObservation {
  return {
    schema: PROVIDER_OBSERVATION_SCHEMA,
    line,
    provider,
    type,
    ...(correlationKey !== undefined ? { correlationKey } : {}),
    normalizedPayload,
    payloadHash: hashPayload(normalizedPayload),
    ...(text !== undefined ? { text } : {}),
  } as ProviderObservation
}

function emptyCounts(): ProviderPageResult['counts'] {
  return {
    lines: 0,
    parsedRecords: 0,
    invalidJsonRecords: 0,
    applicableObservations: 0,
    ignoredRecords: 0,
    unsupportedRecords: 0,
    unknownRecords: 0,
    observationsByType: {
      'user.message': 0,
      'assistant.message.completed': 0,
      'tool.call.started': 0,
      'tool.call.completed': 0,
      'tool.call.failed': 0,
    },
  }
}

function hashPayload(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  )
}

function normalizeBrokerToolInput(value: unknown): unknown {
  if (!isRecord(value)) return value ?? {}
  const rawCommand =
    typeof value['command'] === 'string'
      ? value['command']
      : typeof value['cmd'] === 'string'
        ? value['cmd']
        : undefined
  const cwd =
    typeof value['cwd'] === 'string'
      ? value['cwd']
      : typeof value['workdir'] === 'string'
        ? value['workdir']
        : undefined
  if (rawCommand === undefined && cwd === undefined) return value
  return {
    ...(rawCommand !== undefined ? { cmd: unwrapZshCommand(rawCommand) } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  }
}

function normalizeCodexToolStart(
  toolCallId: string | undefined,
  name: string,
  input: unknown
): ComparisonPayload {
  if (name === 'exec_command' && isRecord(input)) {
    const cmd = typeof input['cmd'] === 'string' ? unwrapZshCommand(input['cmd']) : ''
    const cwd = typeof input['workdir'] === 'string' ? input['workdir'] : undefined
    return { toolCallId, name: 'command', input: { cmd, ...(cwd !== undefined ? { cwd } : {}) } }
  }
  return { toolCallId, name, input: input ?? {} }
}

function normalizeToolResult(value: unknown, exitCode?: number): NormalizedToolResult {
  if (Array.isArray(value)) return normalizeContentResult(value)
  if (isRecord(value) && Array.isArray(value['content']))
    return normalizeContentResult(value['content'])
  if (isRecord(value) && typeof value['output'] === 'string') {
    return {
      output: normalizeCommandOutputText(value['output']),
      ...(finiteNumber(value['exitCode']) !== undefined
        ? { exitCode: finiteNumber(value['exitCode']) }
        : {}),
    }
  }
  const output = normalizeCommandOutputText(value === undefined ? '' : String(value))
  return {
    ...(output.length > 0 ? { output } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  }
}

function normalizeContentResult(value: unknown[]): NormalizedToolResult {
  const content = value.map(normalizeContentBlock)
  const first = content[0]
  if (
    content.length === 1 &&
    isRecord(first) &&
    first['type'] === 'text' &&
    typeof first['text'] === 'string'
  ) {
    return { output: first['text'] }
  }
  return { content }
}

function normalizeContentBlock(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (value['type'] === 'text' && typeof value['text'] === 'string') {
    const parsed = safeJsonParse(value['text'])
    if (isRecord(parsed) && parsed['type'] === 'image') return normalizeContentBlock(parsed)
    if (isRecord(parsed) && parsed['type'] === 'text') {
      const file = isRecord(parsed['file']) ? parsed['file'] : undefined
      if (typeof file?.['content'] === 'string') {
        const start = finiteNumber(file['startLine'])
        return {
          type: 'text',
          text:
            start === undefined
              ? file['content']
              : file['content']
                  .split('\n')
                  .map((item, index) => `${start + index}\t${item}`)
                  .join('\n'),
        }
      }
    }
    return { type: 'text', text: normalizeCommandOutputText(value['text']) }
  }
  if (value['type'] === 'image') {
    const source = isRecord(value['source']) ? value['source'] : undefined
    const file = isRecord(value['file']) ? value['file'] : undefined
    const mediaType =
      stringField(source, 'media_type') ??
      stringField(source, 'mediaType') ??
      stringField(file, 'type') ??
      stringField(file, 'media_type')
    const base64 = stringField(source, 'data') ?? stringField(file, 'base64')
    return {
      type: 'image',
      ...(mediaType !== undefined ? { mediaType } : {}),
      ...(base64 !== undefined ? { base64 } : {}),
    }
  }
  return value
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const parts: string[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    if (
      (item['type'] === 'text' ||
        item['type'] === 'input_text' ||
        item['type'] === 'output_text') &&
      typeof item['text'] === 'string'
    )
      parts.push(item['text'])
  }
  return parts.length === 0 ? undefined : parts.join('')
}

function compactText(value: string | undefined): string | undefined {
  return value?.replace(/\s+/g, ' ').trim()
}

function unwrapZshCommand(command: string): string {
  const prefix = '/bin/zsh -lc '
  if (!command.startsWith(prefix)) return command
  const raw = command.slice(prefix.length)
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    return raw.slice(1, -1).replace(/\\"/g, '"')
  }
  return raw
}

function extractCodexCommandResult(output: string): { output: string; exitCode?: number } {
  const match = output.match(/Process exited with code (\d+)/)
  const marker = '\nOutput:\n'
  const index = output.indexOf(marker)
  return {
    output: index === -1 ? output : output.slice(index + marker.length),
    ...(match?.[1] !== undefined ? { exitCode: Number(match[1]) } : {}),
  }
}

function isCodexPendingCommandOutput(output: string): boolean {
  return (
    /Process running with session ID \d+/.test(output) &&
    /\nOutput:\n?$/.test(output) &&
    !/Process exited with code \d+/.test(output)
  )
}

function normalizeCommandOutputText(output: string): string {
  return output.replace(/^Total output lines: \d+\n\n/, '')
}

function firstContentBlock(value: unknown, type: string): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined
  return value.find(
    (item): item is Record<string, unknown> => isRecord(item) && item['type'] === type
  )
}

function recordLooksProviderRelevant(record: Record<string, unknown>): boolean {
  return (
    typeof record['type'] === 'string' ||
    typeof record['sessionId'] === 'string' ||
    typeof record['parentUuid'] === 'string'
  )
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {}
  return safeJsonParse(value) ?? value
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' && value[key].length > 0
    ? (value[key] as string)
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
