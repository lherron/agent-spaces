import type {
  InputId,
  InvocationId,
  MessageId,
  PermissionRequestId,
  ToolCallId,
  TurnId,
} from '../src/ids'

// Branded-id constructors for test fixtures. The protocol ids are nominal
// strings with no runtime representation, so this is the one place tests
// brand a literal; call sites stay cast-free.
export const invocationIdFrom = (value: string): InvocationId => value as InvocationId
export const inputIdFrom = (value: string): InputId => value as InputId
export const turnIdFrom = (value: string): TurnId => value as TurnId
export const messageIdFrom = (value: string): MessageId => value as MessageId
export const toolCallIdFrom = (value: string): ToolCallId => value as ToolCallId
export const permissionRequestIdFrom = (value: string): PermissionRequestId =>
  value as PermissionRequestId
