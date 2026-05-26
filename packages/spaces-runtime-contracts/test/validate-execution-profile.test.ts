import { describe, expect, test } from 'bun:test'
import {
  validateTerminalExecutionProfile,
  type CompileDiagnostic,
  type TerminalExecutionProfile,
} from '../src/index'

const baseProfile = {
  schemaVersion: 'agent-runtime-profile/v1',
  profileId: 'profile:test-terminal',
  profileHash: 'profile-hash',
  compatibilityHash: 'compatibility-hash',
  kind: 'terminal',
  interactionMode: 'interactive',
  terminal: {
    host: 'foreground',
    startupMethod: 'inherit-current-terminal',
    turnDelivery: 'terminal-launch-input',
  },
  process: {
    command: 'codex',
    args: [],
    cwd: '/tmp',
    lockedEnv: {},
    io: { kind: 'inherit' },
  },
  expectedCapabilities: {},
  policy: {
    exposurePolicy: {
      channel: 'agentchat',
    },
  },
} as unknown as TerminalExecutionProfile

function profile(
  override: Partial<{
    terminal: Partial<TerminalExecutionProfile['terminal']>
    process: Partial<TerminalExecutionProfile['process']>
  }> = {}
): TerminalExecutionProfile {
  return {
    ...baseProfile,
    terminal: {
      ...baseProfile.terminal,
      ...override.terminal,
    },
    process: {
      ...baseProfile.process,
      ...override.process,
    },
  } as TerminalExecutionProfile
}

function diagnosticCodes(diagnostics: CompileDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code)
}

describe('validateTerminalExecutionProfile', () => {
  test('allows a foreground profile with inherited terminal IO and launch input', () => {
    expect(validateTerminalExecutionProfile(profile())).toEqual([])
  })

  test('rejects foreground profiles that request pty IO', () => {
    const diagnostics = validateTerminalExecutionProfile(
      profile({
        process: {
          io: { kind: 'pty' },
        } as unknown as TerminalExecutionProfile['process'],
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('foreground_requires_inherit_io')
  })

  test('rejects foreground profiles that use literal terminal input', () => {
    const diagnostics = validateTerminalExecutionProfile(
      profile({
        terminal: {
          turnDelivery: 'terminal-literal-input',
        },
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('foreground_forbids_literal_input')
  })

  test('rejects tmux profiles that inherit host terminal IO', () => {
    const diagnostics = validateTerminalExecutionProfile(
      profile({
        terminal: {
          host: 'tmux',
          startupMethod: 'create-terminal',
        },
        process: {
          io: { kind: 'inherit' },
        } as unknown as TerminalExecutionProfile['process'],
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('pty_host_requires_pty_io')
  })

  test('rejects inherit-current-terminal startup outside foreground host', () => {
    const diagnostics = validateTerminalExecutionProfile(
      profile({
        terminal: {
          host: 'tmux',
          startupMethod: 'inherit-current-terminal',
        },
        process: {
          io: { kind: 'pty' },
        },
      })
    )

    expect(diagnosticCodes(diagnostics)).toContain('inherit_method_requires_foreground')
  })
})
