import type { CodexAppServerDriverSpec, InvocationInput } from 'spaces-harness-broker-protocol'

export function buildTurnStartParams(options: {
  threadId: string
  cwd: string
  input: InvocationInput
  driver: CodexAppServerDriverSpec
}): Record<string, unknown> {
  return {
    threadId: options.threadId,
    input: buildCodexInput(options.input, options.driver.defaultImageAttachments),
    cwd: options.cwd,
    approvalPolicy: options.driver.approvalPolicy ?? 'never',
    sandboxPolicy: encodeSandboxPolicy(options.driver.sandboxMode),
    model: options.driver.model ?? null,
    effort: options.driver.modelReasoningEffort ?? null,
    summary: null,
    outputSchema: null,
  }
}

function buildCodexInput(
  input: InvocationInput,
  defaultImageAttachments: string[] | undefined
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = []
  const text = input.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
  if (text.length > 0) {
    items.push({ type: 'text', text, text_elements: [] })
  }

  for (const part of input.content) {
    if (part.type === 'local_image') {
      items.push({ type: 'localImage', path: part.path })
    }
  }
  for (const path of defaultImageAttachments ?? []) {
    items.push({ type: 'localImage', path })
  }

  return items
}

function encodeSandboxPolicy(sandboxMode: string | undefined): { type: string } | null {
  if (!sandboxMode) return null
  switch (sandboxMode) {
    case 'danger-full-access':
      return { type: 'dangerFullAccess' }
    case 'read-only':
      return { type: 'readOnly' }
    case 'workspace-write':
      return { type: 'workspaceWrite' }
    default:
      return { type: sandboxMode }
  }
}
