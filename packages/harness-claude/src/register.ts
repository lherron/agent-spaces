import type { HarnessRegistry, SessionRegistry } from 'spaces-runtime'
import { claudeAdapter } from './adapters/claude-adapter.js'
import { claudeAgentSdkAdapter } from './adapters/claude-agent-sdk-adapter.js'
import { AgentSession } from './agent-sdk/agent-session.js'

export function register(reg: { harnesses: HarnessRegistry; sessions: SessionRegistry }): void {
  reg.harnesses.register(claudeAdapter)
  reg.harnesses.register(claudeAgentSdkAdapter)

  reg.sessions.register('agent-sdk', (options) => {
    // The registry-created session deliberately runs without a HookEventBusAdapter:
    // `CreateSessionOptions` carries no hook-bus or sdk-session-id seam, so the
    // bus-driven permission/auto-allow branch in HooksBridge is unused here and
    // every permission decision flows through `options.permissionHandler` below.
    // (Hosts that need the bus construct an AgentSession directly.)
    const session = new AgentSession({
      ownerId: options.sessionId,
      cwd: options.cwd,
      model: options.model ?? 'opus',
      sessionId: options.sessionId,
      ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
      ...(options.plugins !== undefined ? { plugins: options.plugins } : {}),
      ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.systemPromptMode !== undefined
        ? { systemPromptMode: options.systemPromptMode }
        : {}),
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      ...(options.continuationKey !== undefined
        ? { continuationKey: options.continuationKey }
        : {}),
    })
    if (options.permissionHandler) {
      session.setPermissionHandler(options.permissionHandler)
    }
    return session
  })
}
