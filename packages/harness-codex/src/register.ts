import type { HarnessRegistry, SessionRegistry } from 'spaces-runtime'
import { codexAdapter } from './adapters/codex-adapter.js'
import { CodexSession } from './codex-session/codex-session.js'

export function register(reg: { harnesses: HarnessRegistry; sessions: SessionRegistry }): void {
  reg.harnesses.register(codexAdapter)

  reg.sessions.register('codex', (options) => {
    if (!options.codexHomeDir) {
      throw new Error('codexHomeDir is required for codex sessions')
    }

    const session = new CodexSession({
      ownerId: options.sessionId,
      cwd: options.codexCwd ?? options.cwd,
      sessionId: options.sessionId,
      homeDir: options.codexHomeDir,
      ...(options.codexAppServerCommand !== undefined
        ? { appServerCommand: options.codexAppServerCommand }
        : {}),
      ...(options.codexTemplateDir !== undefined ? { templateDir: options.codexTemplateDir } : {}),
      ...(options.codexModel !== undefined ? { model: options.codexModel } : {}),
      ...(options.codexApprovalPolicy !== undefined
        ? { approvalPolicy: options.codexApprovalPolicy }
        : {}),
      ...(options.codexSandboxMode !== undefined ? { sandboxMode: options.codexSandboxMode } : {}),
      ...(options.eventsOutputPath !== undefined
        ? { eventsOutputPath: options.eventsOutputPath }
        : {}),
      ...(options.resume !== undefined ? { resumeThreadId: options.resume } : {}),
    })

    if (options.permissionHandler) {
      session.setPermissionHandler(options.permissionHandler)
    }

    return session
  })
}
