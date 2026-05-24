export type Id<Name extends string> = string & { readonly __id: Name }

export type InvocationId = Id<'invocation'>
export type InputId = Id<'input'>
export type TurnId = Id<'turn'>
export type PermissionRequestId = Id<'permissionRequest'>
export type MessageId = Id<'message'>
export type ToolCallId = Id<'toolCall'>
