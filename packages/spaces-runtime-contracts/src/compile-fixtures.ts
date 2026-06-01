import type { InvocationId } from 'spaces-harness-broker-protocol'
import { CONSERVATIVE_LIFECYCLE_CAPABILITIES } from 'spaces-harness-broker-protocol'
import type { CapabilityResolution, RuntimeCapabilities } from './capabilities'
import type {
  CompileId,
  HostSessionId,
  PlanHash,
  ProfileHash,
  ProfileId,
  RuntimeId,
  RuntimeOperationId,
  ServerInstanceId,
  SpecHash,
  StartRequestHash,
} from './ids'
import type { RuntimeRouteDecision } from './route-decision'
import type { BrokerRuntimeState } from './runtime-state'

const runtimeCapabilities = {
  input: {
    user: true,
    steer: false,
    appendContext: false,
    localImages: true,
    fileRefs: false,
    queue: false,
  },
  turns: {
    concurrency: 'single',
    interrupt: 'protocol',
  },
  continuation: {
    supported: true,
    provider: 'openai',
    keyKind: 'thread',
  },
  permissions: {
    mode: 'broker-request',
    brokerToClientRequests: true,
  },
  events: {
    assistantDeltas: true,
    toolCalls: true,
    usage: true,
    diagnostics: true,
    replay: false,
    ack: false,
  },
  control: {
    stop: true,
    dispose: true,
    interrupt: true,
    status: true,
    attach: false,
  },
  lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
} satisfies RuntimeCapabilities

const capabilityResolution = {
  selectedProfileHash: 'profile-hash' as ProfileHash,
  requirements: {
    input: {
      user: 'required',
      steer: 'optional',
      appendContext: 'optional',
      localImages: 'optional',
      fileRefs: 'optional',
      queue: 'forbidden',
    },
    turns: {
      concurrency: 'single',
      interrupt: 'optional',
    },
    continuation: 'optional',
    permissions: 'broker-request',
    events: {
      assistantDeltas: 'optional',
      toolCalls: 'optional',
      usage: 'optional',
      diagnostics: 'optional',
    },
    control: {
      stop: 'optional',
      dispose: 'optional',
      reconcile: 'optional',
      attachReplay: 'forbidden',
    },
    lifecycle: {
      runtimeRetention: ['keep-alive'],
      harnessRecovery: ['none'],
      turnRetry: ['none'],
      generationFencing: 'optional',
      permissionCancellation: 'optional',
    },
  },
  hrcPolicy: {
    allowDegrade: false,
    requireBrokerDefaultForCodexHeadless: true,
  },
  result: {
    status: 'compatible',
    effective: runtimeCapabilities,
  },
} satisfies CapabilityResolution

export const compileOnlyRuntimeRouteDecision = {
  schemaVersion: 'hrc-route-decision/v1',
  routeId: 'route-1',
  operationId: 'operation-1' as RuntimeOperationId,
  compileId: 'compile-1' as CompileId,
  planHash: 'plan-hash' as PlanHash,
  selectedProfileId: 'profile-1' as ProfileId,
  selectedProfileHash: 'profile-hash' as ProfileHash,
  selectedProfileKind: 'harness-broker',
  controller: 'harness-broker',
  admission: { decision: 'admit' },
  reuse: {
    policy: 'reuse-compatible',
    compatibilityHash: 'compatibility-hash',
    staleGeneration: 'rotate',
  },
  productPolicy: {
    permissionPolicy: {
      mode: 'deny',
      audit: true,
    },
  },
  capabilities: capabilityResolution,
  legacyTransportAlias: 'headless',
} satisfies RuntimeRouteDecision

export const compileOnlyBrokerRuntimeState = {
  schemaVersion: 'runtime-state/v1',
  kind: 'harness-broker',
  runtimeId: 'runtime-1' as RuntimeId,
  hostSessionId: 'host-session-1' as HostSessionId,
  generation: 1,
  status: 'ready',
  createdAt: '2026-05-24T00:00:00.000Z',
  updatedAt: '2026-05-24T00:00:00.000Z',
  compile: {
    compileId: 'compile-1' as CompileId,
    planHash: 'plan-hash' as PlanHash,
    selectedProfileId: 'profile-1' as ProfileId,
    selectedProfileHash: 'profile-hash' as ProfileHash,
    specHash: 'spec-hash' as SpecHash,
    startRequestHash: 'start-request-hash' as StartRequestHash,
  },
  broker: {
    protocolVersion: 'harness-broker/0.1',
    endpoint: { kind: 'stdio-jsonrpc-ndjson' },
    multiInvocation: false,
    startedAt: '2026-05-24T00:00:00.000Z',
    ownerServerInstanceId: 'server-1' as ServerInstanceId,
  },
  invocation: {
    invocationId: 'invocation-1' as InvocationId,
    state: 'ready',
    driver: 'codex-app-server',
    harnessRuntime: 'codex-cli',
    capabilities: {
      input: {
        user: true,
        steer: false,
        appendContext: false,
        localImages: true,
        fileRefs: false,
        queue: false,
      },
      turns: {
        concurrency: 'single',
        interrupt: 'protocol',
      },
      continuation: {
        supported: true,
        provider: 'openai',
        keyKind: 'thread',
      },
      events: {
        assistantDeltas: true,
        toolCalls: true,
        usage: true,
        diagnostics: true,
        replay: false,
        ack: false,
      },
      control: {
        stop: true,
        dispose: true,
        status: true,
        attach: false,
      },
      permissions: {
        brokerToClientRequests: true,
        eventAudit: true,
      },
      lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
    },
  },
  permission: {
    policy: {
      mode: 'deny',
      audit: true,
    },
    negotiated: true,
    pending: [],
  },
  input: {
    policy: {
      readyInput: 'start-turn',
      busy: { whenBusy: 'reject' },
      supportedKinds: ['user'],
      attachmentPolicy: {
        localImages: true,
        fileRefs: false,
      },
    },
    pendingDepth: 0,
  },
} satisfies BrokerRuntimeState

export const durableUnixBrokerRuntimeState = {
  schemaVersion: 'runtime-state/v1',
  kind: 'harness-broker',
  runtimeId: 'runtime_1' as RuntimeId,
  hostSessionId: 'host_session_1' as HostSessionId,
  generation: 3,
  status: 'ready',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:01.000Z',
  compile: {
    compileId: 'compile_1' as CompileId,
    planHash: 'plan_hash_1' as PlanHash,
    selectedProfileId: 'profile_1' as ProfileId,
    selectedProfileHash: 'profile_hash_1' as ProfileHash,
    specHash: 'spec_hash_1' as SpecHash,
    startRequestHash: 'start_request_hash_1' as StartRequestHash,
  },
  broker: {
    protocolVersion: 'harness-broker/0.2',
    brokerPid: 12345,
    endpoint: {
      kind: 'unix-jsonrpc-ndjson',
      socketPath: '/tmp/praesidium/runtime/broker-ipc/runtime-1/broker.sock',
      attachTokenRef: {
        kind: 'file',
        path: '/tmp/praesidium/runtime/broker-ipc/runtime-1/attach-token',
        redacted: true,
      },
    },
    multiInvocation: false,
    startedAt: '2026-06-01T00:00:00.000Z',
    ownerServerInstanceId: 'server_instance_1' as ServerInstanceId,
    tmux: {
      socketPath: '/tmp/praesidium/runtime/btmux/claude-runtime_1.sock',
      sessionName: 'hrc-claude-runtime_1',
      windowName: 'broker',
      paneId: '%1',
    },
  },
  control: {
    mode: 'broker-ipc',
    brokerAttached: true,
    attachedAt: '2026-06-01T00:00:01.000Z',
    lastAttachError: null,
  },
  invocation: {
    invocationId: 'invocation_1' as InvocationId,
    state: 'ready',
    driver: 'claude-code-tmux',
    harnessRuntime: 'claude-code',
    lastEventSeq: 123,
    capabilities: {
      input: {
        user: true,
        steer: false,
        appendContext: false,
        localImages: true,
        fileRefs: false,
        queue: false,
      },
      turns: {
        concurrency: 'single',
        interrupt: 'protocol',
      },
      continuation: {
        supported: true,
        provider: 'openai',
        keyKind: 'thread',
      },
      events: {
        assistantDeltas: true,
        toolCalls: true,
        usage: true,
        diagnostics: true,
        replay: true,
        ack: true,
      },
      control: {
        stop: true,
        dispose: true,
        status: true,
        attach: true,
      },
      permissions: {
        brokerToClientRequests: true,
        eventAudit: true,
      },
      lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
    },
  },
  tui: {
    host: 'tmux',
    socketPath: '/tmp/praesidium/runtime/btmux/claude-runtime_1.sock',
    sessionName: 'hrc-claude-runtime_1',
    windowName: 'tui',
    paneId: '%2',
    operatorAttachTarget: true,
  },
  eventHighWater: 123,
  permission: {
    policy: {
      mode: 'deny',
      audit: true,
    },
    negotiated: true,
    pending: [],
  },
  input: {
    policy: {
      readyInput: 'start-turn',
      busy: { whenBusy: 'reject' },
      supportedKinds: ['user'],
      attachmentPolicy: {
        localImages: true,
        fileRefs: false,
      },
    },
    pendingDepth: 0,
  },
} satisfies BrokerRuntimeState
