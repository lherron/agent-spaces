import type { InputId, InvocationId, MessageId, TurnId } from 'spaces-harness-broker-protocol'

// Branded-id constructors for test fixtures. The protocol ids are nominal
// strings with no runtime representation, so this is the one place tests
// brand a literal; call sites stay cast-free.
export const invocationIdFrom = (value: string): InvocationId => value as InvocationId
export const inputIdFrom = (value: string): InputId => value as InputId
export const messageIdFrom = (value: string): MessageId => value as MessageId
export const turnIdFrom = (value: string): TurnId => value as TurnId
