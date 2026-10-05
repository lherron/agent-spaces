/** Builders for native Codex desktop rollout JSONL records. */

function ordinalTime(ordinal: number): string {
  return new Date(ordinal * 1000).toISOString()
}

function record(
  type: string,
  payload: Record<string, unknown>,
  ordinal: number,
  timestamp: string
) {
  return `${JSON.stringify({ timestamp, ordinal, type, payload })}\n`
}

export function row(
  payload: Record<string, unknown>,
  ordinal: number,
  timestamp = ordinalTime(ordinal)
): string {
  return record('event_msg', payload, ordinal, timestamp)
}

export function itemRow(
  threadId: string,
  turnId: string,
  item: Record<string, unknown>,
  ordinal: number,
  timestamp = ordinalTime(ordinal)
): string {
  return row(
    { type: 'item_completed', thread_id: threadId, turn_id: turnId, item },
    ordinal,
    timestamp
  )
}

export function responseItemRow(
  payload: Record<string, unknown>,
  ordinal: number,
  timestamp = ordinalTime(ordinal)
): string {
  return record('response_item', payload, ordinal, timestamp)
}

export function customToolStartRow(
  turnId: string,
  callId: string,
  input: string,
  ordinal: number,
  timestamp = ordinalTime(ordinal),
  id = `ctc-${callId}`
): string {
  return responseItemRow(
    {
      type: 'custom_tool_call',
      id,
      status: 'completed',
      call_id: callId,
      name: 'exec',
      input,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
    ordinal,
    timestamp
  )
}

export function customToolOutputRow(
  turnId: string,
  callId: string,
  output: unknown,
  ordinal: number,
  timestamp = ordinalTime(ordinal),
  id = `ctco-${callId}`
): string {
  return responseItemRow(
    {
      type: 'custom_tool_call_output',
      id,
      call_id: callId,
      output,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
    ordinal,
    timestamp
  )
}

export function commandExecution(
  id: string,
  command: string[],
  stdout: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: 'CommandExecution',
    id,
    command,
    status: 'completed',
    stdout,
    stderr: '',
    ...extra,
    exit_code: 0,
  }
}

export function userMessage(id: string, clientId: string, text: string): Record<string, unknown> {
  return { type: 'UserMessage', id, client_id: clientId, content: [{ type: 'text', text }] }
}

export function agentMessage(id: string, phase: string, text: string): Record<string, unknown> {
  return { type: 'AgentMessage', id, phase, content: [{ type: 'text', text }] }
}

/** A complete turn whose one orchestration call runs one child command. */
export function toolTurnRows(threadId: string, turnId: string, ordinal: number): string {
  return (
    row({ type: 'task_started', turn_id: turnId }, ordinal) +
    customToolStartRow(
      turnId,
      `call-${turnId}`,
      `text(await tools.exec_command({cmd:"echo ${turnId}"}));\n`,
      ordinal + 1
    ) +
    itemRow(
      threadId,
      turnId,
      commandExecution(`exec-${turnId}`, ['echo', turnId], `${turnId}\n`),
      ordinal + 2
    ) +
    customToolOutputRow(
      turnId,
      `call-${turnId}`,
      [{ type: 'input_text', text: `${turnId}\n` }],
      ordinal + 3
    ) +
    row({ type: 'task_complete', turn_id: turnId }, ordinal + 4)
  )
}

/** A complete turn whose user message carries the broker's client id. */
export function ownTurnRows(
  threadId: string,
  turnId: string,
  inputId: string,
  ordinal = 10
): string {
  return [
    row({ type: 'task_started', turn_id: turnId }, ordinal),
    itemRow(
      threadId,
      turnId,
      userMessage(`user-${turnId}`, inputId, 'broker delivery'),
      ordinal + 1
    ),
    row({ type: 'task_complete', turn_id: turnId }, ordinal + 2),
  ].join('')
}
