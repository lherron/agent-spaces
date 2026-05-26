import type { CompileDiagnostic } from './compiler-plan'
import type { TerminalExecutionProfile } from './execution-profile'

function executionProfileDiagnostic(
  profile: TerminalExecutionProfile,
  code: string,
  message: string
): CompileDiagnostic {
  return {
    level: 'error',
    code,
    message,
    plane: 'asp-compiler',
    profileId: profile.profileId,
  }
}

export function validateTerminalExecutionProfile(
  profile: TerminalExecutionProfile
): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = []

  if (profile.terminal.host === 'foreground') {
    if (profile.process.io.kind !== 'inherit') {
      diagnostics.push(
        executionProfileDiagnostic(
          profile,
          'foreground_requires_inherit_io',
          'Foreground terminal profiles must inherit terminal IO.'
        )
      )
    }

    if (profile.terminal.turnDelivery === 'terminal-literal-input') {
      diagnostics.push(
        executionProfileDiagnostic(
          profile,
          'foreground_forbids_literal_input',
          'Foreground terminal profiles cannot use literal terminal input delivery.'
        )
      )
    }

    if (profile.terminal.startupMethod === 'adopt-terminal') {
      diagnostics.push(
        executionProfileDiagnostic(
          profile,
          'adopt_method_requires_pty_host',
          'Adopting an existing terminal requires a controller-owned terminal host.'
        )
      )
    }
  } else if (profile.process.io.kind !== 'pty') {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'pty_host_requires_pty_io',
        'Controller-owned terminal hosts must use pty IO.'
      )
    )
  }

  if (
    profile.terminal.startupMethod === 'inherit-current-terminal' &&
    profile.terminal.host !== 'foreground'
  ) {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'inherit_method_requires_foreground',
        'Inheriting the current terminal is only valid for foreground terminal profiles.'
      )
    )
  }

  return diagnostics
}
