import type { ExtensionFactory } from '@mariozechner/pi-coding-agent'
import type { PermissionHandler } from '../session/permissions.js'
import type { PiHookEventBusAdapter } from './types.js'

export interface PermissionHookOptions {
  ownerId: string
  hookEventBus?: PiHookEventBusAdapter
  permissionHandler?: PermissionHandler
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

      const { hookEventBus, permissionHandler } = options

      if (permissionHandler) {
        if (permissionHandler.isAutoAllowed(event.toolName)) {
          hookEventBus?.emitHook(options.ownerId, hook)
          return
        }

        hookEventBus?.emitHook(options.ownerId, hook)
        const decision = await permissionHandler.requestPermission({
          toolName: event.toolName,
          toolUseId: event.toolCallId ?? '',
          input: event.input,
        })

        if (decision.allowed) {
          return
        }

        return {
          block: true,
          reason: decision.reason ?? 'Permission denied',
        }
      }

      if (!hookEventBus) return

      if (hookEventBus.isToolAutoAllowed(options.ownerId, event.toolName)) {
        hookEventBus.emitHook(options.ownerId, hook)
        return
      }

      const decision = await hookEventBus.requestPermission(options.ownerId, hook)

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
