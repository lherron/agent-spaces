import type { CompileDiagnostic } from './compiler-plan'
import type {
  BrokerExecutionProfile,
  EmbeddedSdkExecutionProfile,
  RuntimeExecutionProfileBase,
  TerminalExecutionProfile,
} from './execution-profile'
import type { AgentchatExposurePolicy } from './exposure'

function executionProfileDiagnostic(
  profile: RuntimeExecutionProfileBase,
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

function isTmuxBrokerExposurePolicy(policy: AgentchatExposurePolicy): boolean {
  return policy.mode === 'broker-reports-target' && policy.targetKind === 'tmux-session'
}

function exposurePoliciesMatch(
  left: AgentchatExposurePolicy,
  right: AgentchatExposurePolicy
): boolean {
  if (left.mode !== right.mode) {
    return false
  }
  if (left.mode === 'none') {
    return true
  }
  return (
    left.targetKind === (right as Exclude<AgentchatExposurePolicy, { mode: 'none' }>).targetKind
  )
}

function isNoneExposurePolicy(policy: AgentchatExposurePolicy): boolean {
  return policy.mode === 'none'
}

export function validateBrokerExecutionProfile(
  profile: BrokerExecutionProfile
): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = []
  const spec = profile.harnessInvocation.startRequest.spec
  const specDriverKind = spec.driver.kind
  const transportKind = spec.process.harnessTransport.kind
  const specInteractionMode = spec.interaction?.mode
  const specDriverTerminalHost =
    'terminalHost' in spec.driver ? spec.driver['terminalHost'] : undefined
  const specDriverHookBridge = 'hookBridge' in spec.driver ? spec.driver['hookBridge'] : undefined
  const isCodexAppServer =
    profile.brokerDriver === 'codex-app-server' || specDriverKind === 'codex-app-server'
  const profileClaimsClaudeCodeTmux = profile.brokerDriver === 'claude-code-tmux'
  const isClaudeCodeTmux = profileClaimsClaudeCodeTmux || specDriverKind === 'claude-code-tmux'
  const profileClaimsCodexCliTmux = profile.brokerDriver === 'codex-cli-tmux'
  const isCodexCliTmux = profileClaimsCodexCliTmux || specDriverKind === 'codex-cli-tmux'

  if (
    isCodexAppServer &&
    (profile.interactionMode !== 'headless' ||
      (specInteractionMode !== undefined && specInteractionMode !== 'headless'))
  ) {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'codex_app_server_requires_headless',
        'codex-app-server broker profiles must be headless.'
      )
    )
  }

  if (isCodexAppServer && transportKind !== 'jsonrpc-stdio') {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'codex_app_server_requires_jsonrpc_stdio',
        'codex-app-server broker profiles must use jsonrpc stdio process transport.'
      )
    )
  }

  if (isCodexAppServer && profile.brokerTerminal !== undefined) {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'codex_app_server_forbids_tmux_terminal',
        'codex-app-server broker profiles must not declare a brokerTerminal.'
      )
    )
  }

  if (
    profile.interactionMode === 'headless' &&
    !isNoneExposurePolicy(profile.policy.exposurePolicy)
  ) {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'headless_requires_none_exposure',
        'Headless broker profiles must use exposurePolicy mode none.'
      )
    )
  }

  if (profileClaimsClaudeCodeTmux && specDriverKind !== 'claude-code-tmux') {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'claude_code_tmux_requires_driver_kind',
        'claude-code-tmux broker profiles must use claude-code-tmux in the hashed driver spec.'
      )
    )
  }

  if (specDriverKind === 'claude-code-tmux' && specDriverTerminalHost !== 'tmux') {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'claude_code_tmux_requires_terminal_host',
        'claude-code-tmux broker profiles must declare terminalHost tmux in the hashed driver spec.'
      )
    )
  }

  if (isClaudeCodeTmux && transportKind !== 'pty') {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'claude_code_tmux_requires_pty_transport',
        'claude-code-tmux broker profiles must use pty process transport.'
      )
    )
  }

  if (profileClaimsCodexCliTmux && specDriverKind !== 'codex-cli-tmux') {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'codex_cli_tmux_requires_driver_kind',
        'codex-cli-tmux broker profiles must use codex-cli-tmux in the hashed driver spec.'
      )
    )
  }

  if (specDriverKind === 'codex-cli-tmux' && specDriverTerminalHost !== 'tmux') {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'codex_cli_tmux_requires_terminal_host',
        'codex-cli-tmux broker profiles must declare terminalHost tmux in the hashed driver spec.'
      )
    )
  }

  if (isCodexCliTmux && transportKind !== 'pty') {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'codex_cli_tmux_requires_pty_transport',
        'codex-cli-tmux broker profiles must use pty process transport.'
      )
    )
  }

  if (specDriverKind === 'codex-cli-tmux' && specDriverHookBridge !== 'codex-hooks/v1') {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'codex_cli_tmux_requires_codex_hooks_bridge',
        'codex-cli-tmux broker profiles must declare hookBridge codex-hooks/v1.'
      )
    )
  }

  if (profile.interactionMode === 'interactive' && specInteractionMode !== 'interactive') {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'interactive_profile_requires_interactive_spec',
        'Interactive broker profiles must use interaction mode interactive in the hashed spec.'
      )
    )
  }

  if (
    profile.interactionMode === 'interactive' &&
    (profile.brokerTerminal?.host !== 'tmux' ||
      profile.brokerTerminal.turnDelivery !== 'terminal-literal-input' ||
      profile.brokerTerminal.operatorAttach !== true)
  ) {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'interactive_broker_requires_tmux_terminal',
        'Interactive broker profiles must declare an operator-attachable tmux brokerTerminal.'
      )
    )
  }

  if (profile.interactionMode === 'interactive' && profile.brokerTerminal !== undefined) {
    const profileExposure = profile.policy.exposurePolicy
    const terminalExposure = profile.brokerTerminal.exposurePolicy
    if (
      !isTmuxBrokerExposurePolicy(profileExposure) ||
      !isTmuxBrokerExposurePolicy(terminalExposure) ||
      !exposurePoliciesMatch(profileExposure, terminalExposure)
    ) {
      diagnostics.push(
        executionProfileDiagnostic(
          profile,
          'broker_exposure_policy_mismatch',
          'brokerTerminal.exposurePolicy must match policy.exposurePolicy for tmux broker exposure.'
        )
      )
    }
  }

  return diagnostics
}

const EMBEDDED_SDK_STARTUP_METHODS = new Set(['create-sdk-session', 'reuse-existing'])
const EMBEDDED_SDK_TURN_DELIVERIES = new Set(['sdk-turn', 'sdk-inflight-input'])

/**
 * Validate an embedded-sdk execution profile against the §7.3.2 / FINAL_CONTRACTS
 * §7.8 legality gates: the SDK session runs IN-PROCESS (no broker/process/transport/
 * terminal launch fields), is nonInteractive (NOT headless), pi-sdk requires the
 * openai provider, PATH is carried only as the typed session.pathPrepend channel
 * (never in session.lockedEnv), and startup/turn-delivery values stay inside the
 * SDK contract.
 */
export function validateEmbeddedSdkExecutionProfile(
  profile: EmbeddedSdkExecutionProfile
): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = []
  // Some legality gates assert the ABSENCE of broker/process launch fields, which
  // are not part of the EmbeddedSdkExecutionProfile type — read them through a
  // structural record view so an illegally-shaped profile is still caught.
  const fields = profile as unknown as Record<string, unknown>

  if (profile.interactionMode !== 'nonInteractive') {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'embedded_sdk_requires_non_interactive',
        'Embedded-sdk profiles must use interactionMode nonInteractive (not headless).'
      )
    )
  }

  if (profile.sdk.runtime === 'pi-sdk' && profile.session.provider !== 'openai') {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'pi_sdk_requires_openai_provider',
        'pi-sdk embedded profiles must use the openai provider.'
      )
    )
  }

  if (Object.prototype.hasOwnProperty.call(profile.session.lockedEnv, 'PATH')) {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'embedded_sdk_forbids_path_locked_env',
        'Embedded-sdk profiles must carry PATH via the typed session.pathPrepend channel, never in session.lockedEnv.'
      )
    )
  }

  if ('brokerProtocol' in fields || 'brokerDriver' in fields || 'brokerTerminal' in fields) {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'embedded_sdk_forbids_broker_fields',
        'Embedded-sdk profiles must not declare broker fields.'
      )
    )
  }

  if ('process' in fields) {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'embedded_sdk_forbids_process_fields',
        'Embedded-sdk profiles run in-process and must not declare a launched process.'
      )
    )
  }

  if ('transport' in fields) {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'embedded_sdk_forbids_transport_fields',
        'Embedded-sdk profiles must not declare a process transport.'
      )
    )
  }

  if ('terminal' in fields) {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'embedded_sdk_forbids_terminal_fields',
        'Embedded-sdk profiles must not declare a terminal surface.'
      )
    )
  }

  if (!EMBEDDED_SDK_STARTUP_METHODS.has(profile.sdk.startupMethod)) {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'embedded_sdk_invalid_startup_method',
        'Embedded-sdk startupMethod must be create-sdk-session or reuse-existing.'
      )
    )
  }

  if (!EMBEDDED_SDK_TURN_DELIVERIES.has(profile.sdk.turnDelivery)) {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'embedded_sdk_invalid_turn_delivery',
        'Embedded-sdk turnDelivery must be sdk-turn or sdk-inflight-input.'
      )
    )
  }

  return diagnostics
}
