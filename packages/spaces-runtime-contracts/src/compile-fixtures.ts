import type { InvocationId } from 'spaces-harness-broker-protocol'
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
