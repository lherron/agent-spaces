import { SUPPORTED_BROKER_PROTOCOL_VERSIONS } from 'spaces-harness-broker-protocol'
import type { CompileDiagnostic } from './compiler-plan'
import type {
  BrokerExecutionProfile,
  EmbeddedSdkExecutionProfile,
  RuntimeExecutionProfile,
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

/**
 * Typed structural reads for fields that may be absent from a given
 * `HarnessInvocationSpec.driver` variant. The unsafe `'key' in driver` probing
 * lives here (one auditable place) so the rule bodies below stay declarative.
 */
function readDriverTerminalHost(spec: BrokerInvocationSpec): unknown {
  const { driver } = spec
  return 'terminalHost' in driver ? driver['terminalHost'] : undefined
}

function readDriverHookBridge(spec: BrokerInvocationSpec): unknown {
  const { driver } = spec
  return 'hookBridge' in driver ? driver['hookBridge'] : undefined
}

type BrokerInvocationSpec = BrokerExecutionProfile['harnessInvocation']['startRequest']['spec']

/**
 * Derived facts about a broker profile, computed once so the legality rules can
 * read them declaratively instead of re-probing `spec.driver` / re-deriving the
 * driver-identity booleans in every branch.
 */
type BrokerProfileFacts = {
  specDriverKind: string
  transportKind: string
  specInteractionMode: string | undefined
  specDriverTerminalHost: unknown
  specDriverHookBridge: unknown
  isCodexAppServer: boolean
  profileClaimsClaudeCodeTmux: boolean
  isClaudeCodeTmux: boolean
  profileClaimsCodexCliTmux: boolean
  isCodexCliTmux: boolean
}

function computeBrokerProfileFacts(profile: BrokerExecutionProfile): BrokerProfileFacts {
  const spec = profile.harnessInvocation.startRequest.spec
  const specDriverKind = spec.driver.kind
  const profileClaimsClaudeCodeTmux = profile.brokerDriver === 'claude-code-tmux'
  const profileClaimsCodexCliTmux = profile.brokerDriver === 'codex-cli-tmux'
  return {
    specDriverKind,
    transportKind: spec.process.harnessTransport.kind,
    specInteractionMode: spec.interaction?.mode,
    specDriverTerminalHost: readDriverTerminalHost(spec),
    specDriverHookBridge: readDriverHookBridge(spec),
    isCodexAppServer:
      profile.brokerDriver === 'codex-app-server' || specDriverKind === 'codex-app-server',
    profileClaimsClaudeCodeTmux,
    isClaudeCodeTmux: profileClaimsClaudeCodeTmux || specDriverKind === 'claude-code-tmux',
    profileClaimsCodexCliTmux,
    isCodexCliTmux: profileClaimsCodexCliTmux || specDriverKind === 'codex-cli-tmux',
  }
}

/**
 * A single-purpose broker legality gate. Returns a diagnostic when the profile
 * violates the gate, otherwise `undefined`. Adding a new gate means appending a
 * rule (or a new driver's rule array) — never editing a sibling branch.
 */
type BrokerLegalityRule = (
  profile: BrokerExecutionProfile,
  facts: BrokerProfileFacts
) => CompileDiagnostic | undefined

const BROKER_PROTOCOL_RULES: BrokerLegalityRule[] = [
  (profile) => {
    const declared = (profile as { brokerProtocol?: unknown }).brokerProtocol
    if (
      typeof declared === 'string' &&
      !(SUPPORTED_BROKER_PROTOCOL_VERSIONS as readonly string[]).includes(declared)
    ) {
      return executionProfileDiagnostic(
        profile,
        'broker_protocol_version_unsupported',
        `Broker profiles must declare a supported brokerProtocol (got ${declared}; supported: ${SUPPORTED_BROKER_PROTOCOL_VERSIONS.join(
          ', '
        )}).`
      )
    }
    return undefined
  },
]

const CODEX_APP_SERVER_RULES: BrokerLegalityRule[] = [
  (profile, facts) =>
    facts.isCodexAppServer &&
    (profile.interactionMode !== 'headless' ||
      (facts.specInteractionMode !== undefined && facts.specInteractionMode !== 'headless'))
      ? executionProfileDiagnostic(
          profile,
          'codex_app_server_requires_headless',
          'codex-app-server broker profiles must be headless.'
        )
      : undefined,
  (profile, facts) =>
    facts.isCodexAppServer && facts.transportKind !== 'jsonrpc-stdio'
      ? executionProfileDiagnostic(
          profile,
          'codex_app_server_requires_jsonrpc_stdio',
          'codex-app-server broker profiles must use jsonrpc stdio process transport.'
        )
      : undefined,
  (profile, facts) =>
    facts.isCodexAppServer && profile.brokerTerminal !== undefined
      ? executionProfileDiagnostic(
          profile,
          'codex_app_server_forbids_tmux_terminal',
          'codex-app-server broker profiles must not declare a brokerTerminal.'
        )
      : undefined,
]

const EXPOSURE_RULES: BrokerLegalityRule[] = [
  (profile) =>
    profile.interactionMode === 'headless' && !isNoneExposurePolicy(profile.policy.exposurePolicy)
      ? executionProfileDiagnostic(
          profile,
          'headless_requires_none_exposure',
          'Headless broker profiles must use exposurePolicy mode none.'
        )
      : undefined,
]

const CLAUDE_CODE_TMUX_RULES: BrokerLegalityRule[] = [
  (profile, facts) =>
    facts.profileClaimsClaudeCodeTmux && facts.specDriverKind !== 'claude-code-tmux'
      ? executionProfileDiagnostic(
          profile,
          'claude_code_tmux_requires_driver_kind',
          'claude-code-tmux broker profiles must use claude-code-tmux in the hashed driver spec.'
        )
      : undefined,
  (profile, facts) =>
    facts.specDriverKind === 'claude-code-tmux' && facts.specDriverTerminalHost !== 'tmux'
      ? executionProfileDiagnostic(
          profile,
          'claude_code_tmux_requires_terminal_host',
          'claude-code-tmux broker profiles must declare terminalHost tmux in the hashed driver spec.'
        )
      : undefined,
  (profile, facts) =>
    facts.isClaudeCodeTmux && facts.transportKind !== 'pty'
      ? executionProfileDiagnostic(
          profile,
          'claude_code_tmux_requires_pty_transport',
          'claude-code-tmux broker profiles must use pty process transport.'
        )
      : undefined,
]

const CODEX_CLI_TMUX_RULES: BrokerLegalityRule[] = [
  (profile, facts) =>
    facts.profileClaimsCodexCliTmux && facts.specDriverKind !== 'codex-cli-tmux'
      ? executionProfileDiagnostic(
          profile,
          'codex_cli_tmux_requires_driver_kind',
          'codex-cli-tmux broker profiles must use codex-cli-tmux in the hashed driver spec.'
        )
      : undefined,
  (profile, facts) =>
    facts.specDriverKind === 'codex-cli-tmux' && facts.specDriverTerminalHost !== 'tmux'
      ? executionProfileDiagnostic(
          profile,
          'codex_cli_tmux_requires_terminal_host',
          'codex-cli-tmux broker profiles must declare terminalHost tmux in the hashed driver spec.'
        )
      : undefined,
  (profile, facts) =>
    facts.isCodexCliTmux && facts.transportKind !== 'pty'
      ? executionProfileDiagnostic(
          profile,
          'codex_cli_tmux_requires_pty_transport',
          'codex-cli-tmux broker profiles must use pty process transport.'
        )
      : undefined,
  (profile, facts) =>
    facts.specDriverKind === 'codex-cli-tmux' && facts.specDriverHookBridge !== 'codex-hooks/v1'
      ? executionProfileDiagnostic(
          profile,
          'codex_cli_tmux_requires_codex_hooks_bridge',
          'codex-cli-tmux broker profiles must declare hookBridge codex-hooks/v1.'
        )
      : undefined,
]

const INTERACTIVE_TMUX_RULES: BrokerLegalityRule[] = [
  (profile, facts) =>
    profile.interactionMode === 'interactive' && facts.specInteractionMode !== 'interactive'
      ? executionProfileDiagnostic(
          profile,
          'interactive_profile_requires_interactive_spec',
          'Interactive broker profiles must use interaction mode interactive in the hashed spec.'
        )
      : undefined,
  (profile) =>
    profile.interactionMode === 'interactive' &&
    (profile.brokerTerminal?.host !== 'tmux' ||
      profile.brokerTerminal.turnDelivery !== 'terminal-literal-input' ||
      profile.brokerTerminal.operatorAttach !== true)
      ? executionProfileDiagnostic(
          profile,
          'interactive_broker_requires_tmux_terminal',
          'Interactive broker profiles must declare an operator-attachable tmux brokerTerminal.'
        )
      : undefined,
  (profile) => {
    if (profile.interactionMode !== 'interactive' || profile.brokerTerminal === undefined) {
      return undefined
    }
    const profileExposure = profile.policy.exposurePolicy
    const terminalExposure = profile.brokerTerminal.exposurePolicy
    if (
      !isTmuxBrokerExposurePolicy(profileExposure) ||
      !isTmuxBrokerExposurePolicy(terminalExposure) ||
      !exposurePoliciesMatch(profileExposure, terminalExposure)
    ) {
      return executionProfileDiagnostic(
        profile,
        'broker_exposure_policy_mismatch',
        'brokerTerminal.exposurePolicy must match policy.exposurePolicy for tmux broker exposure.'
      )
    }
    return undefined
  },
]

// Ordered registry: diagnostics are emitted in this order, which existing tests
// assert. Each driver's gates are co-located so a new broker driver appends an
// array rather than editing a sibling branch.
const BROKER_RULES: BrokerLegalityRule[] = [
  ...BROKER_PROTOCOL_RULES,
  ...CODEX_APP_SERVER_RULES,
  ...EXPOSURE_RULES,
  ...CLAUDE_CODE_TMUX_RULES,
  ...CODEX_CLI_TMUX_RULES,
  ...INTERACTIVE_TMUX_RULES,
]

export function validateBrokerExecutionProfile(
  profile: BrokerExecutionProfile
): CompileDiagnostic[] {
  const facts = computeBrokerProfileFacts(profile)
  const diagnostics: CompileDiagnostic[] = []
  for (const rule of BROKER_RULES) {
    const diagnostic = rule(profile, facts)
    if (diagnostic !== undefined) {
      diagnostics.push(diagnostic)
    }
  }
  return diagnostics
}

const EMBEDDED_SDK_STARTUP_METHODS = new Set(['create-sdk-session', 'reuse-existing'])
const EMBEDDED_SDK_TURN_DELIVERIES = new Set(['sdk-turn', 'sdk-inflight-input'])

/**
 * Some embedded-sdk legality gates assert the ABSENCE of broker/process/
 * transport/terminal launch fields, which are not part of the
 * EmbeddedSdkExecutionProfile type. This isolates the one unsafe structural cast
 * needed to detect an illegally-shaped profile, so the gate bodies stay typed.
 */
function hasForbiddenProfileField(profile: EmbeddedSdkExecutionProfile, key: string): boolean {
  return key in (profile as unknown as Record<string, unknown>)
}

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

  if (
    hasForbiddenProfileField(profile, 'brokerProtocol') ||
    hasForbiddenProfileField(profile, 'brokerDriver') ||
    hasForbiddenProfileField(profile, 'brokerTerminal')
  ) {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'embedded_sdk_forbids_broker_fields',
        'Embedded-sdk profiles must not declare broker fields.'
      )
    )
  }

  if (hasForbiddenProfileField(profile, 'process')) {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'embedded_sdk_forbids_process_fields',
        'Embedded-sdk profiles run in-process and must not declare a launched process.'
      )
    )
  }

  if (hasForbiddenProfileField(profile, 'transport')) {
    diagnostics.push(
      executionProfileDiagnostic(
        profile,
        'embedded_sdk_forbids_transport_fields',
        'Embedded-sdk profiles must not declare a process transport.'
      )
    )
  }

  if (hasForbiddenProfileField(profile, 'terminal')) {
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

/**
 * Kind-dispatching entry point over every {@link RuntimeExecutionProfile}
 * variant. Routes to the matching per-kind validator and returns `[]` for the
 * `command-process` / `legacy-exec` kinds, which carry no legality gates today.
 *
 * The exhaustive `switch` (with a `never` default) means adding a new profile
 * kind is a compile error here until it is wired up — so a missing validator
 * can't stay silent. Behaviour for the existing kinds is identical to calling
 * the per-kind validators directly.
 */
export function validateExecutionProfile(profile: RuntimeExecutionProfile): CompileDiagnostic[] {
  switch (profile.kind) {
    case 'terminal':
      return validateTerminalExecutionProfile(profile)
    case 'harness-broker':
      return validateBrokerExecutionProfile(profile)
    case 'embedded-sdk':
      return validateEmbeddedSdkExecutionProfile(profile)
    case 'command-process':
    case 'legacy-exec':
      return []
    default: {
      const _exhaustive: never = profile
      void _exhaustive
      return []
    }
  }
}
