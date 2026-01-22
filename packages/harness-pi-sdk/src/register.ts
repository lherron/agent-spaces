import type { ExtensionFactory, Skill } from '@mariozechner/pi-coding-agent'
import type { HarnessRegistry, SessionRegistry } from 'spaces-runtime'
import { piSdkAdapter } from './adapters/pi-sdk-adapter.js'
import { PiSession } from './pi-session/pi-session.js'

export function register(reg: { harnesses: HarnessRegistry; sessions: SessionRegistry }): void {
  reg.harnesses.register(piSdkAdapter)

  reg.sessions.register('pi', (options) => {
    const session = new PiSession({
      ownerId: options.sessionId,
      cwd: options.cwd,
      sessionId: options.sessionId,
      ...(options.providerModel !== undefined ? { model: options.providerModel } : {}),
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
      ...(options.agentDir !== undefined ? { agentDir: options.agentDir } : {}),
      ...(options.globalAgentDir !== undefined ? { globalAgentDir: options.globalAgentDir } : {}),
      ...(options.extensions !== undefined
        ? { extensions: options.extensions as ExtensionFactory[] }
        : {}),
      ...(options.skills !== undefined ? { skills: options.skills as Skill[] } : {}),
      ...(options.contextFiles !== undefined ? { contextFiles: options.contextFiles } : {}),
    })
    if (options.permissionHandler) {
      session.setPermissionHandler(options.permissionHandler)
    }
    return session
  })
}
