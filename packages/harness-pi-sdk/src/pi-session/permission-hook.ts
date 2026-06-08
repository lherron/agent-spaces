import type { ExtensionFactory } from '@mariozechner/pi-coding-agent'
import type { PermissionHandler } from 'spaces-runtime'
import type { PiHookEventBusAdapter } from './types.js'

export interface PermissionHookOptions {
  ownerId: string
  hookEventBus?: PiHookEventBusAdapter
  permissionHandler?: PermissionHandler
  sessionId?: string
  cwd?: string
}

const DENIED_REASON = 'Permission denied'

/** Outcome of resolving a tool-call permission: allow (undefined) or block. */
type PermissionResolution = { block: true; reason: string } | undefined

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
        return resolveViaPermissionHandler(options, permissionHandler, event, hook)
      }

      if (!hookEventBus) return

      return resolveViaHookEventBus(options, hookEventBus, event, hook)
    })
  }
}

/**
 * Resolve permission through an explicit PermissionHandler. The hook is always
 * emitted (both on auto-allow and on a requested decision) before the handler
 * decides.
 */
async function resolveViaPermissionHandler(
  options: PermissionHookOptions,
  permissionHandler: PermissionHandler,
  event: { toolName: string; toolCallId?: string; input: unknown },
  hook: Record<string, unknown>
): Promise<PermissionResolution> {
  options.hookEventBus?.emitHook(options.ownerId, hook)

  if (permissionHandler.isAutoAllowed(event.toolName)) {
    return undefined
  }

  const decision = await permissionHandler.requestPermission({
    toolName: event.toolName,
    toolUseId: event.toolCallId ?? '',
    input: event.input,
  })

  if (decision.allowed) {
    return undefined
  }
  return { block: true, reason: decision.reason ?? DENIED_REASON }
}

/**
 * Resolve permission through the hook event bus. On auto-allow the hook is
 * emitted; otherwise the decision is requested directly from the bus (which
 * carries the hook payload itself).
 */
async function resolveViaHookEventBus(
  options: PermissionHookOptions,
  hookEventBus: NonNullable<PermissionHookOptions['hookEventBus']>,
  event: { toolName: string },
  hook: Record<string, unknown>
): Promise<PermissionResolution> {
  if (hookEventBus.isToolAutoAllowed(options.ownerId, event.toolName)) {
    hookEventBus.emitHook(options.ownerId, hook)
    return undefined
  }

  const decision = await hookEventBus.requestPermission(options.ownerId, hook)

  if (decision.decision === 'allow') {
    return undefined
  }
  return { block: true, reason: decision.message ?? DENIED_REASON }
}
