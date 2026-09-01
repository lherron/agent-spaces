import { readFile } from 'node:fs/promises'
import {
  type AgentSessionEvent,
  type ExtensionFactory,
  type ToolDefinition,
  defineTool,
  readStoredCredential,
} from '@earendil-works/pi-coding-agent'
import {
  type ApplyInputResult,
  type Driver,
  type DriverContext,
  type DriverStartResult,
  PiSdkAuthError,
  type PiSdkAuthResolution,
  buildProcessEnv,
  piSdkAgentDir,
  resolvePiSdkAuth as resolveBrokerPiSdkAuth,
  validateJsonSchemaValue,
} from 'spaces-harness-broker'
import {
  CONSERVATIVE_LIFECYCLE_CAPABILITIES,
  type HarnessInvocationSpec,
  type InputId,
  type InvocationCapabilities,
  type InvocationInput,
  type InvocationInterruptRequest,
  type InvocationInterruptResponse,
  type InvocationStopRequest,
  type InvocationStopResponse,
  type PermissionPolicy,
  type TurnId,
  isCredentialEnvKey,
} from 'spaces-harness-broker-protocol'
import { createPiAgentSession, resolvePiModelReference } from 'spaces-harness-pi-sdk/agent-session'
import { PiSdkTurnEventMapper } from './event-mapper'
import { createPiSdkPermissionBridge } from './permissions'

export type { PiSdkAuthResolution }

export const PI_SDK_DRIVER_KIND = 'pi-sdk'
const PI_SDK_DRIVER_VERSION = '0.1.0'
const STRUCTURED_TOOL_NAME = 'respond_structured'
const STRUCTURED_RETRY_PROMPT =
  'Your previous response did not satisfy the required JSON Schema. Call respond_structured exactly once with schema-valid arguments. Do not answer with prose.'

const PI_SDK_CAPABILITIES: InvocationCapabilities = {
  admission: { classes: ['steer', 'queue', 'exclusive', 'preempt'] },
  bracketMintingMode: 'delivery-asserted',
  queue: { cancelHarnessLocal: false },
  preempt: { mode: 'atomic' },
  steer: { landingEvidence: 'ack' },
  input: {
    user: true,
    steer: true,
    appendContext: false,
    localImages: false,
    fileRefs: false,
    queue: true,
    busyPolicies: ['reject', 'queue', 'steer'],
  },
  turns: { concurrency: 'single', interrupt: 'protocol' },
  continuation: { supported: true, keyKind: 'session' },
  events: {
    assistantDeltas: true,
    toolCalls: true,
    usage: true,
    diagnostics: true,
  },
  control: {
    stop: true,
    dispose: true,
    attach: true,
    liveness: 'cached',
    driverAttachExistingSurface: false,
  },
  permissions: { brokerToClientRequests: true, eventAudit: true },
  finalResponse: {
    jsonSchema: true,
    perTurn: true,
    strict: true,
    parsedResult: false,
  },
  lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
}

interface MutableTool {
  name: string
  parameters: unknown
}

export interface PiSdkSession {
  readonly sessionFile: string | undefined
  readonly isStreaming: boolean
  readonly agent: {
    readonly state: { readonly tools: MutableTool[] }
  }
  subscribe(listener: (event: AgentSessionEvent) => void): () => void
  prompt(text: string, options?: { expandPromptTemplates?: boolean | undefined }): Promise<void>
  steer(text: string): Promise<void>
  abort(): Promise<void>
  waitForIdle(): Promise<void>
  getActiveToolNames(): string[]
  setActiveToolsByName(toolNames: string[]): void
  dispose(): void | Promise<void>
}

export interface PiSdkSessionFactoryInput {
  spec: HarnessInvocationSpec
  environment: NodeJS.ProcessEnv
  auth: PiSdkAuthResolution
  permissionExtension: ExtensionFactory
  structuredTool: ToolDefinition
}

export interface PiSdkDriverOptions {
  createSession?: ((input: PiSdkSessionFactoryInput) => Promise<PiSdkSession>) | undefined
  schedule?: ((task: () => void) => void) | undefined
  driverKind?: string | undefined
}

export function createPiSdkDriver(options: PiSdkDriverOptions = {}): Driver {
  const createSession = options.createSession ?? createDefaultPiSdkSession
  const schedule = options.schedule ?? ((task: () => void) => setImmediate(task))
  const driverKind = options.driverKind ?? PI_SDK_DRIVER_KIND

  let ctx: DriverContext | undefined
  let spec: HarnessInvocationSpec | undefined
  let session: PiSdkSession | undefined
  let mapper: PiSdkTurnEventMapper | undefined
  let unsubscribe: (() => void) | undefined
  let turnCounter = 0
  let activeSchema: Record<string, unknown> | undefined
  let disposed = false
  let exited = false

  const requireCtx = (): DriverContext => {
    if (ctx === undefined) throw new Error('pi-sdk driver has not started')
    return ctx
  }
  const requireSpec = (): HarnessInvocationSpec => {
    if (spec === undefined) throw new Error('pi-sdk driver has not started')
    return spec
  }
  const requireSession = (): PiSdkSession => {
    if (session === undefined) throw new Error('pi-sdk session is unavailable')
    return session
  }
  const requireMapper = (): PiSdkTurnEventMapper => {
    if (mapper === undefined) throw new Error('pi-sdk event mapper is unavailable')
    return mapper
  }

  const allocateTurnId = (): TurnId => {
    turnCounter += 1
    return `turn_${requireCtx().invocationId}_${turnCounter}` as TurnId
  }

  const structuredTool = defineTool({
    name: STRUCTURED_TOOL_NAME,
    label: 'Structured response',
    description:
      'Return the final response using the required JSON Schema. This tool terminates the turn.',
    parameters: { type: 'object', additionalProperties: true },
    async execute(_toolCallId: string, params: unknown) {
      const schema = activeSchema
      if (schema === undefined) {
        requireMapper().recordStructuredMiss('respond_structured called without an active schema')
        return {
          content: [{ type: 'text' as const, text: 'No structured response schema is active.' }],
          details: {},
          terminate: true,
        }
      }
      const validation = validateJsonSchemaValue(schema, params)
      if (!validation.valid) {
        const message = `respond_structured arguments failed schema validation: ${JSON.stringify(validation.errors ?? [])}`
        requireMapper().recordStructuredMiss(message)
        return {
          content: [{ type: 'text' as const, text: message }],
          details: {},
          terminate: true,
        }
      }
      const canonical = canonicalJsonStringify(params)
      requireMapper().recordStructuredResult(canonical)
      return {
        content: [{ type: 'text' as const, text: canonical }],
        details: {},
        terminate: true,
      }
    },
  }) as unknown as ToolDefinition

  async function driveTurn(input: InvocationInput, turnId: TurnId): Promise<void> {
    const currentSession = requireSession()
    const currentMapper = requireMapper()
    const currentSpec = requireSpec()
    let timeout: ReturnType<typeof setTimeout> | undefined

    try {
      const timeoutMs = currentSpec.process.limits?.turnTimeoutMs
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timeout = setTimeout(() => {
          if (currentMapper.activeTurnId !== turnId) return
          currentMapper.requestFailure('turn_timeout', `Turn timed out after ${timeoutMs}ms`)
          void currentSession.abort().then(
            () => currentMapper.settleRequestedTerminal(),
            () => currentMapper.settleRequestedTerminal()
          )
        }, timeoutMs)
      }

      await currentSession.prompt(extractText(input), { expandPromptTemplates: false })
      let action = currentMapper.consumeSettlementAction()
      if (action === 'retry') {
        currentMapper.beginStructuredRetry()
        await currentSession.prompt(STRUCTURED_RETRY_PROMPT, { expandPromptTemplates: false })
        action = currentMapper.consumeSettlementAction()
      }
      if (action === undefined && !currentMapper.isTerminal) {
        currentMapper.requestFailure('turn_failed', 'pi SDK prompt ended without agent_settled')
        currentMapper.settleRequestedTerminal()
      }
    } catch (error) {
      if (!currentMapper.isTerminal) {
        currentMapper.requestFailure(
          'turn_failed',
          error instanceof Error ? error.message : String(error)
        )
        currentMapper.settleRequestedTerminal()
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      activeSchema = undefined
    }
  }

  return {
    kind: driverKind,
    version: PI_SDK_DRIVER_VERSION,
    bracketMintingMode: 'delivery-asserted',
    preemptMode: 'atomic',
    steerLandingEvidence: 'ack',

    capabilities(): InvocationCapabilities {
      return PI_SDK_CAPABILITIES
    },

    async start(
      nextSpec: HarnessInvocationSpec,
      driverCtx: DriverContext
    ): Promise<DriverStartResult> {
      assertPiSdkSpec(nextSpec, driverKind)
      ctx = driverCtx
      spec = nextSpec
      disposed = false
      exited = false

      driverCtx.emit(
        'invocation.started',
        {
          command: nextSpec.process.command,
          args: nextSpec.process.args,
          cwd: nextSpec.process.cwd,
        },
        { driver: { kind: driverKind } }
      )

      let auth: PiSdkAuthResolution
      try {
        auth = await resolvePiSdkAuth(nextSpec, driverCtx)
      } catch (error) {
        if (error instanceof PiSdkAuthError) {
          driverCtx.emit(
            'invocation.failed',
            { message: error.message, code: error.code },
            { driver: { kind: driverKind } }
          )
        }
        throw error
      }

      const environment = composePiSdkEnvironment(nextSpec, driverCtx)
      mapper = new PiSdkTurnEventMapper({
        ctx: driverCtx,
        provider: auth.providerId,
        sessionFile: () => session?.sessionFile,
        driverKind,
      })
      const permissionPolicy = readPermissionPolicy(nextSpec)
      const permissionBridge = createPiSdkPermissionBridge({
        ctx: driverCtx,
        policy: permissionPolicy,
        activeTurnId: () => mapper?.activeTurnId,
        exemptToolNames: new Set([STRUCTURED_TOOL_NAME]),
        driverKind,
      })
      const permissionExtension: ExtensionFactory = (pi) => {
        pi.on('tool_call', (event) => permissionBridge.handle(event))
      }

      session = await createSession({
        spec: nextSpec,
        environment,
        auth,
        permissionExtension,
        structuredTool,
      })
      unsubscribe = session.subscribe((event) => mapper?.handle(event))
      session.setActiveToolsByName(
        session.getActiveToolNames().filter((name) => name !== STRUCTURED_TOOL_NAME)
      )
      const authNotice = {
        message: `Resolved pi SDK authentication for ${auth.providerId}`,
        code: 'auth-resolved',
        kind: 'auth-resolved',
        providerId: auth.providerId,
        credentialType: auth.credentialType,
        storeBound: auth.storeBound,
      }
      driverCtx.emit('driver.notice', authNotice, {
        driver: { kind: driverKind },
      })
      driverCtx.emit('invocation.ready', { state: 'ready' }, { driver: { kind: driverKind } })
      return { ok: true }
    },

    async applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
      const currentSession = requireSession()
      const currentMapper = requireMapper()
      const turnId = allocateTurnId()
      const schema =
        input.responseFormat?.kind === 'json_schema' ? input.responseFormat.schema : undefined
      activeSchema = schema
      configureStructuredTool(currentSession, schema)
      currentMapper.beginTurn({
        turnId,
        ...(input.inputId !== undefined ? { inputId: input.inputId as InputId } : {}),
        structured: schema !== undefined,
      })
      // Defer the pi prompt so the broker can synthesize turn.started from the
      // returned id before any SDK events are emitted.
      schedule(() => {
        void driveTurn(input, turnId)
      })
      return { turnId }
    },

    async applySteerNow(input: InvocationInput): Promise<void> {
      await requireSession().steer(extractText(input))
    },

    async interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      const currentMapper = requireMapper()
      if (currentMapper.activeTurnId === undefined) {
        return { accepted: false, effect: 'no_active_turn' }
      }
      currentMapper.requestInterruption(req.reason ?? 'operator-interrupt')
      await requireSession().abort()
      currentMapper.settleRequestedTerminal()
      return { accepted: true, effect: 'turn_interrupted' }
    },

    async stop(req: InvocationStopRequest): Promise<InvocationStopResponse> {
      const currentSession = requireSession()
      const currentMapper = requireMapper()
      if (currentSession.isStreaming) {
        currentMapper.requestInterruption(req.reason ?? 'operator-stop')
        void currentSession.abort().catch(() => undefined)
      }
      await waitBounded(
        currentSession.waitForIdle(),
        req.graceMs ?? requireSpec().process.limits?.stopGraceMs ?? 5_000
      )
      currentMapper.settleRequestedTerminal()
      await disposeSession()
      if (!exited) {
        exited = true
        requireCtx().emit(
          'invocation.exited',
          { exitCode: 0, reason: 'operator-stop' },
          { driver: { kind: driverKind } }
        )
      }
      return { accepted: true, state: 'exited' }
    },

    async dispose(): Promise<void> {
      await disposeSession()
      ctx = undefined
      spec = undefined
      mapper = undefined
      activeSchema = undefined
    },
  }

  async function disposeSession(): Promise<void> {
    if (disposed) return
    disposed = true
    unsubscribe?.()
    unsubscribe = undefined
    await session?.dispose()
    session = undefined
  }
}

export function composePiSdkEnvironment(
  spec: HarnessInvocationSpec,
  ctx: Pick<DriverContext, 'dispatchEnv'>
): NodeJS.ProcessEnv {
  const credentials: Record<string, string> = {}
  if (spec.sdk?.authMode === 'api-key') {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && isCredentialEnvKey(key)) credentials[key] = value
    }
  }
  return buildProcessEnv({
    credentials,
    lockedEnv: spec.process.lockedEnv,
    dispatchEnv: ctx.dispatchEnv,
    pathPrepend: spec.process.pathPrepend,
  })
}

/**
 * Bind the shared broker resolution to this package's credential reader. The
 * resolution itself lives in `spaces-harness-broker` so the `agent-harness-tmux`
 * driver projects the SAME value into its `session.config` frame.
 */
function resolvePiSdkAuth(
  spec: HarnessInvocationSpec,
  ctx: Pick<DriverContext, 'dispatchEnv'>
): Promise<PiSdkAuthResolution> {
  return resolveBrokerPiSdkAuth(spec, ctx, { readStoredCredential })
}

async function createDefaultPiSdkSession(input: PiSdkSessionFactoryInput): Promise<PiSdkSession> {
  const sdk = input.spec.sdk
  if (sdk === undefined) throw new Error('pi-sdk invocation requires spec.sdk')

  const agentDir = piSdkAgentDir(input.spec)
  const systemPrompt =
    input.spec.launch?.systemPromptFile !== undefined
      ? await readFile(input.spec.launch.systemPromptFile, 'utf8')
      : undefined
  return (await createPiAgentSession({
    cwd: input.spec.process.cwd,
    agentDir,
    model: {
      provider: sdk.provider,
      modelId: sdk.modelId,
      ...(sdk.thinkingLevel !== undefined ? { thinkingLevel: sdk.thinkingLevel } : {}),
    },
    auth: input.auth,
    environment: input.environment,
    extensionFactories: [input.permissionExtension],
    customTools: [input.structuredTool],
    ...(systemPrompt !== undefined
      ? {
          systemPrompt: {
            content: systemPrompt,
            mode: input.spec.launch?.systemPromptMode ?? 'replace',
          },
        }
      : {}),
    ...(input.spec.continuation?.key !== undefined
      ? { continuationKey: input.spec.continuation.key }
      : {}),
  })) as PiSdkSession
}

interface PiSdkApiKeyRuntime {
  setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>
}

export async function applyPiSdkAuthentication(
  modelRuntime: PiSdkApiKeyRuntime,
  auth: PiSdkAuthResolution,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  if (auth.authMode === 'oauth') return
  const credential = providerCredential(auth.providerId, environment)
  if (credential !== undefined) {
    await modelRuntime.setRuntimeApiKey(auth.providerId, credential)
  }
}

function configureStructuredTool(
  session: PiSdkSession,
  schema: Record<string, unknown> | undefined
): void {
  const names = session.getActiveToolNames().filter((name) => name !== STRUCTURED_TOOL_NAME)
  if (schema !== undefined) names.push(STRUCTURED_TOOL_NAME)
  session.setActiveToolsByName(names)
  if (schema === undefined) return
  const tool = session.agent.state.tools.find(
    (candidate) => candidate.name === STRUCTURED_TOOL_NAME
  )
  if (tool === undefined) throw new Error('respond_structured tool was not registered')
  tool.parameters = schema
}

function assertPiSdkSpec(spec: HarnessInvocationSpec, driverKind: string): void {
  if (spec.driver.kind !== driverKind) {
    throw new Error(`pi-sdk driver cannot start spec for ${spec.driver.kind}`)
  }
  if (spec.process.harnessTransport.kind !== 'in-process') {
    throw new Error('pi-sdk driver requires in-process harness transport')
  }
  if (spec.sdk?.runtime !== 'pi-sdk') {
    throw new Error('pi-sdk driver requires spec.sdk.runtime=pi-sdk')
  }
  if (spec.sdk.authMode !== 'api-key' && spec.sdk.authMode !== 'oauth') {
    throw new Error('pi-sdk driver requires spec.sdk.authMode=api-key|oauth')
  }
}

function readPermissionPolicy(spec: HarnessInvocationSpec): PermissionPolicy {
  const policy = (spec.driver as { permissionPolicy?: PermissionPolicy | undefined })
    .permissionPolicy
  return policy ?? { mode: 'deny' }
}

function providerCredential(provider: string, environment: NodeJS.ProcessEnv): string | undefined {
  if (provider === 'anthropic') return environment['ANTHROPIC_API_KEY']
  if (provider === 'openai' || provider === 'openai-codex') return environment['OPENAI_API_KEY']
  const generic = `${provider.replaceAll('-', '_').toUpperCase()}_API_KEY`
  return environment[generic]
}

interface PiSdkProviderRegistry {
  getProvider(providerId: string): unknown | undefined
}

export interface PiSdkModelReference {
  providerId: string
  modelId: string
}

export function resolvePiSdkModelReference(
  registry: PiSdkProviderRegistry,
  provider: string,
  modelId: string
): PiSdkModelReference {
  return resolvePiModelReference(registry, provider, modelId)
}

function extractText(input: InvocationInput): string {
  return input.content
    .filter((content): content is { type: 'text'; text: string } => content.type === 'text')
    .map((content) => content.text)
    .join('\n')
}

function canonicalJsonStringify(value: unknown): string {
  const normalized = canonicalize(value)
  const serialized = JSON.stringify(normalized)
  if (serialized === undefined) throw new Error('Structured response is not JSON-serializable')
  return serialized
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalize(nested)])
    )
  }
  return value
}

async function waitBounded(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
