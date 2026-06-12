import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

export function formatBrokerEventLogLine(
  event: Pick<InvocationEventEnvelope, 'type' | 'payload'> & {
    turnId?: string | undefined
  }
): string {
  const turn = event.turnId ? ` turn=${event.turnId}` : ''
  const detail = importantEventDetail(event.type, event.payload)
  return `[event] ${event.type}${turn}${detail !== undefined ? ` ${detail}` : ''}`
}

function importantEventDetail(type: string, payload: unknown): string | undefined {
  const record = asRecord(payload)
  if (type === 'turn.started') {
    const prompt = turnStartedPromptText(record)
    return prompt.length > 0 ? `prompt=${JSON.stringify(truncate(prompt, 220))}` : undefined
  }
  if (type === 'assistant.message.completed') {
    const text = assistantMessageText(record)
    return text.length > 0 ? `message=${JSON.stringify(truncate(text, 220))}` : undefined
  }
  if (type === 'tool.call.started') {
    const name = stringValue(record?.['name']) ?? stringValue(record?.['toolName']) ?? 'tool'
    const input = asRecord(record?.['input'])
    const command =
      stringValue(input?.['command']) ??
      stringValue(input?.['cmd']) ??
      stringValue(input?.['description']) ??
      stringValue(record?.['command'])
    return command !== undefined
      ? `tool=${JSON.stringify(name)} cmd=${JSON.stringify(truncate(command, 220))}`
      : `tool=${JSON.stringify(name)}`
  }
  if (type === 'turn.completed') {
    const response = turnCompletedResponseText(record)
    return response.length > 0 ? `response=${JSON.stringify(truncate(response, 220))}` : undefined
  }
  return undefined
}

function assistantMessageText(payload: Record<string, unknown> | undefined): string {
  if (payload === undefined) return ''
  const direct =
    stringValue(payload['text']) ??
    stringValue(payload['message']) ??
    stringValue(payload['finalOutput']) ??
    stringValue(payload['lastAssistantMessage'])
  if (direct !== undefined) return direct

  const content = payload['content']
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const record = asRecord(part)
      return stringValue(record?.['text']) ?? stringValue(record?.['message']) ?? ''
    })
    .filter((part) => part.length > 0)
    .join('')
}

function turnStartedPromptText(payload: Record<string, unknown> | undefined): string {
  if (payload === undefined) return ''
  return (
    stringValue(payload['prompt']) ??
    stringValue(payload['input']) ??
    stringValue(payload['text']) ??
    stringValue(payload['userPrompt']) ??
    ''
  )
}

function turnCompletedResponseText(payload: Record<string, unknown> | undefined): string {
  if (payload === undefined) return ''
  return (
    stringValue(payload['finalOutput']) ??
    stringValue(payload['output']) ??
    stringValue(payload['response']) ??
    stringValue(payload['lastAssistantMessage']) ??
    ''
  )
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`
}
