import type { ExtensionFactory } from '@mariozechner/pi-coding-agent'
import type { PiHookEventBusAdapter } from './types.js'

export interface PermissionHookOptions {
  ownerId: string
  hookEventBus: PiHookEventBusAdapter
  sessionId?: string
  cwd?: string
}

export function createPermissionHook(options: PermissionHookOptions): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event, ctx) => {
      const hook: Record<string, unknown> = {
        hook_event_name: 'PreToolUse',
        tool_name: event.toolName,
        tool_input: event.input,
        tool_use_id: event.toolCallId,
        cwd: options.cwd ?? ctx.cwd,
        ...(options.sessionId ? { session_id: options.sessionId } : {}),
      }

      if (options.hookEventBus.isToolAutoAllowed(options.ownerId, event.toolName)) {
        options.hookEventBus.emitHook(options.ownerId, hook)
        return
      }

      const decision = await options.hookEventBus.requestPermission(options.ownerId, hook)

      if (decision.decision === 'allow') {
        return
      }

      return {
        block: true,
        reason: decision.message ?? 'Permission denied',
      }
    })
  }
}
