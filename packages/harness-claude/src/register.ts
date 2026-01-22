import type { HarnessRegistry, SessionRegistry } from 'spaces-runtime'
import { AgentSession } from './agent-sdk/agent-session.js'
import { claudeAdapter } from './adapters/claude-adapter.js'
import { claudeAgentSdkAdapter } from './adapters/claude-agent-sdk-adapter.js'

export function register(reg: { harnesses: HarnessRegistry; sessions: SessionRegistry }): void {
  reg.harnesses.register(claudeAdapter)
  reg.harnesses.register(claudeAgentSdkAdapter)

  reg.sessions.register('agent-sdk', (options) => {
    const session = new AgentSession(
      {
        ownerId: options.sessionId,
        cwd: options.cwd,
        model: options.model ?? 'opus',
        sessionId: options.sessionId,
        ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
        ...(options.plugins !== undefined ? { plugins: options.plugins } : {}),
        ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
        ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
        ...(options.resume !== undefined ? { resume: options.resume } : {}),
      },
      undefined
    )
    if (options.permissionHandler) {
      session.setPermissionHandler(options.permissionHandler)
    }
    return session
  })
}
