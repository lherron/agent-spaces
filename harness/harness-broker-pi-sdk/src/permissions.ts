import type { ToolCallEvent, ToolCallEventResult } from '@earendil-works/pi-coding-agent'
import type { DriverContext } from 'spaces-harness-broker'
import type { PermissionPolicy, PermissionRequestId, TurnId } from 'spaces-harness-broker-protocol'

export interface PiSdkPermissionBridgeOptions {
  ctx: DriverContext
  policy: PermissionPolicy
  activeTurnId: () => TurnId | undefined
  exemptToolNames?: ReadonlySet<string> | undefined
  driverKind?: string | undefined
}

export interface PiSdkPermissionBridge {
  handle(event: ToolCallEvent): Promise<ToolCallEventResult | undefined>
}

export function createPiSdkPermissionBridge(
  options: PiSdkPermissionBridgeOptions
): PiSdkPermissionBridge {
  let counter = 0

  return {
    async handle(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
      if (options.exemptToolNames?.has(event.toolName) === true) return undefined
      const defaultDecision = options.policy.defaultDecision ?? 'deny'

      // Explicit invocation policy is authoritative. A broker client may own
      // ask-client request lifecycles, but it must not turn a profile-level
      // allow/deny decision into an operator prompt.
      if (options.policy.mode === 'allow') return undefined
      if (options.policy.mode === 'deny') {
        return { block: true, reason: 'Denied by invocation permission policy' }
      }

      if (options.ctx.brokerOwnsPermissionLifecycle === true) {
        if (options.ctx.requestPermission === undefined) {
          return { block: true, reason: 'Broker permission request transport is unavailable' }
        }
        counter += 1
        const permissionRequestId =
          `permission_${options.ctx.invocationId}_${counter}` as PermissionRequestId
        const turnId = options.activeTurnId()
        const kind = event.toolName === 'bash' ? 'command' : 'tool'
        const subject = {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          input: event.input,
        }

        options.ctx.emit(
          'permission.requested',
          {
            permissionRequestId,
            kind,
            subjectDisplay: subject,
            defaultDecision,
            ...(options.policy.timeoutMs !== undefined
              ? { deadlineMs: options.policy.timeoutMs }
              : {}),
          },
          {
            ...(turnId !== undefined ? { turnId } : {}),
            driver: { kind: options.driverKind ?? 'pi-sdk', rawType: 'tool_call' },
          }
        )
        // The broker owns the deadline and resolution event. This await is for
        // its FINAL decision and intentionally has no driver-side timeout.
        const decision = await options.ctx.requestPermission({
          invocationId: options.ctx.invocationId,
          ...(turnId !== undefined ? { turnId } : {}),
          permissionRequestId,
          kind,
          subject,
          defaultDecision,
          ...(options.policy.timeoutMs !== undefined
            ? { deadlineMs: options.policy.timeoutMs }
            : {}),
        })
        return decision.decision === 'deny'
          ? { block: true, reason: decision.message ?? 'Denied by broker permission policy' }
          : undefined
      }

      return decideLocallyWithClient(options, event, ++counter)
    },
  }
}

async function decideLocallyWithClient(
  options: PiSdkPermissionBridgeOptions,
  event: ToolCallEvent,
  counter: number
): Promise<ToolCallEventResult | undefined> {
  const defaultDecision = options.policy.defaultDecision ?? 'deny'
  const permissionRequestId =
    `permission_${options.ctx.invocationId}_${counter}` as PermissionRequestId
  const turnId = options.activeTurnId()
  const kind = event.toolName === 'bash' ? 'command' : 'tool'
  const subject = {
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    input: event.input,
  }
  const deadlineMs = options.policy.timeoutMs ?? 30_000

  options.ctx.emit(
    'permission.requested',
    { permissionRequestId, kind, subjectDisplay: subject, defaultDecision, deadlineMs },
    {
      ...(turnId !== undefined ? { turnId } : {}),
      driver: { kind: options.driverKind ?? 'pi-sdk', rawType: 'tool_call' },
    }
  )

  let timer: ReturnType<typeof setTimeout> | undefined
  let decidedBy: 'api' | 'timeout' = 'api'
  const response =
    options.ctx.requestPermission === undefined
      ? { decision: defaultDecision as 'allow' | 'deny' }
      : await Promise.race([
          options.ctx.requestPermission({
            invocationId: options.ctx.invocationId,
            ...(turnId !== undefined ? { turnId } : {}),
            permissionRequestId,
            kind,
            subject,
            defaultDecision,
            deadlineMs,
          }),
          new Promise<{ decision: 'allow' | 'deny' }>((resolve) => {
            timer = setTimeout(() => {
              decidedBy = 'timeout'
              resolve({ decision: defaultDecision })
            }, deadlineMs)
          }),
        ])
  if (timer !== undefined) clearTimeout(timer)

  options.ctx.emit(
    'permission.resolved',
    {
      permissionRequestId,
      decision: response.decision,
      decidedBy,
      ...('message' in response && response.message !== undefined
        ? { message: response.message }
        : {}),
    },
    {
      ...(turnId !== undefined ? { turnId } : {}),
      driver: { kind: options.driverKind ?? 'pi-sdk', rawType: 'tool_call' },
    }
  )
  return response.decision === 'deny'
    ? {
        block: true,
        reason:
          'message' in response && typeof response.message === 'string'
            ? response.message
            : 'Denied by client permission decision',
      }
    : undefined
}
