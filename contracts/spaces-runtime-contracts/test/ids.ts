import type { InputId, InvocationId } from 'spaces-harness-broker-protocol'

// Branded-id constructors for test fixtures. The protocol ids are nominal
// strings with no runtime representation, so this is the one place tests
// brand a literal; call sites stay cast-free.
export const invocationIdFrom = (value: string): InvocationId => value as InvocationId
export const inputIdFrom = (value: string): InputId => value as InputId
