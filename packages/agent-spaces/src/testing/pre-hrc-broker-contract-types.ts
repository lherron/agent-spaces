import type {
  InvocationEventEnvelope,
  InvocationStartResponse,
} from 'spaces-harness-broker-protocol'
import type {
  AgentchatExposurePolicy,
  BrokerExecutionProfile,
  BrokerInputPolicy,
  BrokerPermissionPolicy,
  CompatibilityHash,
  CompileDiagnostic,
  CompileId,
  CompiledRuntimePlan,
  PlanHash,
  ProfileHash,
  ProfileId,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
  RuntimeIdentityAllocation,
  RuntimeOperationId,
  RuntimeResourceLimits,
} from 'spaces-runtime-contracts'

export type PreHrcRouteDecision = {
  schemaVersion: 'pre-hrc-route-decision/v1'
  routeId: string
  operationId: RuntimeOperationId
  compileId: CompileId
  planHash: PlanHash

  selectedProfileId: ProfileId
  selectedProfileHash: ProfileHash
  selectedProfileKind: 'harness-broker'
  controller: 'harness-broker'
  startupMethod: 'create-broker-invocation'
  turnDelivery: 'broker-input'

  identity: RuntimeIdentityAllocation
  admission: { decision: 'admit' } | { decision: 'reject'; reason: string; code: string }
  reuse: {
    policy: 'always-new'
    compatibilityHash: CompatibilityHash
    staleGeneration: 'rotate'
  }
  productPolicy: {
    permissionPolicy: BrokerPermissionPolicy
    inputPolicy: BrokerInputPolicy
    exposurePolicy: AgentchatExposurePolicy
    resourceLimits?: RuntimeResourceLimits | undefined
  }
  diagnostics?:
    | Array<{ level: 'info' | 'warning' | 'error'; code: string; message: string }>
    | undefined
}

export type ContractHarnessFailureCode =
  | 'compile_failed'
  | 'compiled_plan_missing'
  | 'broker_profile_missing'
  | 'broker_profile_ambiguous'
  | 'broker_profile_invalid'
  | 'broker_protocol_invalid'
  | 'broker_driver_missing'
  | 'start_request_missing'
  | 'start_request_identity_mismatch'
  | 'start_request_reference_changed'
  | 'initial_input_identity_mismatch'
  | 'spec_hash_mismatch'
  | 'start_request_hash_mismatch'
  | 'broker_start_contract_unverifiable'
  | 'route_decision_invalid'
  | 'artifact_dir_required'
  | 'raw_start_request_requires_temp_dir'
  | 'artifact_write_failed'
  | 'broker_start_not_implemented'
  | 'broker_start_failed'
  | 'broker_event_timeout'
  | 'broker_event_seq_non_monotonic'
  | 'broker_event_duplicate_conflict'
  | 'broker_event_type_not_normalized'
  | 'broker_event_legacy_permission'
  | 'broker_event_baseline_missing'
  | 'broker_terminal_turn_count_invalid'
  | 'real_codex_tool_call_missing'
  | 'real_codex_tool_call_invalid'
  | 'real_codex_assistant_marker_missing'
  | 'broker_terminal_turn_missing'
  | 'broker_capability_missing'
  | 'interactive_tmux_mode_invalid'
  | 'interactive_tmux_runtime_socket_missing'
  | 'interactive_tmux_surface_invalid'
  | 'interactive_tmux_turn_correlation_invalid'
  | 'interactive_tmux_event_sequence_invalid'
  | 'interactive_tmux_tool_mapping_invalid'
  | 'interactive_tmux_clean_exit_invalid'

export type ContractHarnessFailure = {
  code: ContractHarnessFailureCode
  message: string
  path?: string | undefined
  redactedDetails?: unknown
}

export type PreHrcBrokerContractHarnessInput = {
  schemaVersion?: 'pre-hrc-broker-contract-harness-input/v1' | undefined
  compileRequest: RuntimeCompileRequest
  aspHome?: string | undefined
  artifactDir?: string | undefined
  mode?: 'dry-run-compile' | 'broker-start' | 'interactive-tmux' | undefined
  dryRunCompile?: boolean | undefined
  writeRawStartRequest?: boolean | undefined
  timeoutMs?: number | undefined
  now?: string | undefined
  /**
   * STRICT MODE (default): the broker event stream must use only normalized
   * invocation event types. Native Codex event names always fail the run. The
   * legacy untyped permission event (`invocation.permission.request`) is also
   * rejected unless this temporary transition flag is explicitly set to true.
   */
  allowLegacyPermissionEvent?: boolean | undefined
  /** Narrow profile selection by id/hash (forwarded to selectBrokerProfile). */
  profileSelector?: { profileId?: string | undefined; profileHash?: string | undefined } | undefined
  brokerStartAssertions?:
    | {
        baseline?:
          | {
              expectInitialInputAccepted?: boolean | undefined
              expectedTerminalType?:
                | 'turn.completed'
                | 'turn.failed'
                | 'turn.interrupted'
                | undefined
            }
          | undefined
        realCodexHappyPath?:
          | {
              expectedCwd?: string | undefined
              expectedAssistantMarker: string
            }
          | undefined
      }
    | undefined
  interactiveTmux?:
    | {
        socketPath?: string | undefined
        tmuxBin?: string | undefined
        userInputText?: string | undefined
        secondUserInputText?: string | undefined
        includePermissionEvents?: boolean | undefined
        simulateQueuedInputLeftForTest?: boolean | undefined
      }
    | undefined
  /**
   * TEST-ONLY seam: mutate the selected profile after selection and before the
   * compiler-closure verifier runs, to exercise the pre-broker-start contract
   * gate. Production callers never set this.
   */
  mutateProfileForTest?: ((profile: BrokerExecutionProfile) => void) | undefined
}

export type PreHrcBrokerContractArtifactManifest = {
  schemaVersion: 'pre-hrc-broker-contract-artifacts/v1'
  artifactDir: string
  files: Record<string, string>
  contractFields?:
    | {
        compileId?: CompileId | undefined
        planHash?: PlanHash | undefined
        selectedProfileHash?: ProfileHash | undefined
        startRequestHash?: string | undefined
      }
    | undefined
  projectionArtifacts: true
  rawStartRequestWritten: boolean
  warnings: string[]
}

export type PreHrcBrokerContractAssertionReport = {
  schemaVersion: 'pre-hrc-broker-contract-assertion-report/v1'
  ok: boolean
  failures: ContractHarnessFailure[]
  diagnostics: CompileDiagnostic[]
}

export type PreHrcBrokerContractHarnessResult = {
  schemaVersion: 'pre-hrc-broker-contract-harness-result/v1'
  ok: boolean
  mode: 'dry-run-compile' | 'broker-start' | 'interactive-tmux'
  compileResponse: RuntimeCompileResponse
  compiledPlan?: CompiledRuntimePlan | undefined
  selectedProfile?: BrokerExecutionProfile | undefined
  routeDecision?: PreHrcRouteDecision | undefined
  artifacts?: PreHrcBrokerContractArtifactManifest | undefined
  assertionReport: PreHrcBrokerContractAssertionReport
  brokerStart?:
    | {
        attempted: false
        reason:
          | 'dry-run-compile'
          | 'not-implemented'
          | 'contract-verification-failed'
          | 'capability-missing'
          | 'broker-start-failed'
      }
    | {
        attempted: true
        response: InvocationStartResponse
        events: InvocationEventEnvelope[]
        eventTypes: string[]
        permissionAudit: Array<{ permissionRequestId: string; kind: string; decision: 'deny' }>
      }
    | undefined
  interactiveTmux?:
    | {
        attempted: true
        socketPath: string
        tmuxServerEvents: Array<{
          owner: 'harness'
          action: 'start-server' | 'kill-server'
          socketPath: string
        }>
        driverTmuxArgv: string[][]
        hookListenerClosed: boolean
        driverDisposed: boolean
        queuedInputLeft: boolean
        inputTurnId: string
        inputTurnIds?: string[] | undefined
        surface?: { socketPath: string; sessionName: string; paneId: string } | undefined
      }
    | {
        attempted: false
        reason:
          | 'not-interactive-tmux'
          | 'contract-verification-failed'
          | 'capability-missing'
          | 'interactive-tmux-failed'
      }
    | undefined
}
