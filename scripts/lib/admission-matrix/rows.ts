import { spawn } from 'node:child_process'
/**
 * Admission conformance matrix — ROWS (T-07860, contract hcs T-07843 §9).
 *
 * Rows are REGISTRY-DRIVEN: the runner enumerates
 * `createDriverRegistry(buildMatrixDrivers(...)).summaries()` and drops only
 * `noop-driver`. A driver kind that appears in the registry with no recipe here
 * is a row FAILURE (`no_recipe`), never a silent omission — that is how a new
 * driver becomes a row automatically instead of quietly not being tested.
 *
 * A missing real dependency (binary / auth / tmux) is likewise a row FAILURE,
 * never a skip (standing pre-HRC rule).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { readStoredCredential } from '@earendil-works/pi-coding-agent'
import {
  detectAgentLocalComponents,
  harnessRegistry,
  planPlacementRuntime,
  prepareAgentToolRuntime,
  prepareCodexRuntimeHome,
} from 'spaces-execution'
import type {
  HarnessInvocationSpec,
  InvocationRuntimeContext,
  InvocationStartRequest,
} from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  BrokerPermissionPolicy,
  RuntimeCompileRequest,
} from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'

import { createAgentSpacesClient } from '../../../compiler/agent-spaces/src/index.js'
import {
  allocatePreHrcRuntimeIdentity,
  buildPlacementFromScopeRef,
} from '../../../compiler/agent-spaces/src/testing/pre-hrc-broker-helpers.js'
import { allocatePreHrcTmuxPane } from '../../../compiler/agent-spaces/src/testing/pre-hrc-tmux-allocator.js'
import { createDefaultAgentHarnessTmuxDriver } from '../../../harness/harness-broker/src/drivers/agent-harness-tmux/driver'
import { createDefaultClaudeCodeTmuxDriver } from '../../../harness/harness-broker/src/drivers/claude-code-tmux/driver'
import { createCodexAppServerDriver } from '../../../harness/harness-broker/src/drivers/codex-app-server/driver'
import { createDefaultCodexCliTmuxDriver } from '../../../harness/harness-broker/src/drivers/codex-cli-tmux/driver'
import type { Driver } from '../../../harness/harness-broker/src/drivers/driver'
import { createDefaultPiTuiTmuxDriver } from '../../../harness/harness-broker/src/drivers/pi-tui-tmux/driver'

export const NOOP_DRIVER_KIND = 'noop-driver'

export type DependencyProbe = { available: boolean; reason: string }

export type PlanContext = {
  repoRoot: string
  tmuxBin: string
  marker: string
  /** Per-run IPC dir the tmux drivers bind their hook sockets under. */
  hookIpcDir: string
  timeoutMs: number
}

export type RowPlan = {
  driver: Driver
  startRequest: InvocationStartRequest
  runtime?: InvocationRuntimeContext | undefined
  dispatchEnv?: Record<string, string> | undefined
  /** Launch priming prompt the seat runs before the first matrix cell. */
  primingPrompt?: string | undefined
  compile?: Record<string, unknown> | undefined
  cleanup: () => Promise<void>
}

export type RowRecipe = {
  kind: string
  probe: () => DependencyProbe
  plan: (ctx: PlanContext) => Promise<RowPlan>
}

// ---------------------------------------------------------------------------
// Driver construction — the registry the rows are derived from
// ---------------------------------------------------------------------------

/**
 * Every driver kind the broker can register, wired exactly as
 * `createDefaultBroker` wires the production set plus the agent-harness driver
 * that ships as an `additionalDrivers` entry. `noop-driver` is deliberately
 * absent (it is not a real harness and the spec excludes it).
 */
export function buildMatrixDrivers(hookIpcDir: string, controlDir: string): Driver[] {
  return [
    createDefaultClaudeCodeTmuxDriver(hookIpcDir),
    createDefaultCodexCliTmuxDriver(hookIpcDir),
    createDefaultPiTuiTmuxDriver(hookIpcDir),
    createCodexAppServerDriver(),
    createDefaultAgentHarnessTmuxDriver(controlDir, { readStoredCredential }),
  ]
}

// ---------------------------------------------------------------------------
// Dependency probes — a miss is a row FAILURE, never a skip
// ---------------------------------------------------------------------------

function firstExisting(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.length > 0 && existsSync(candidate)) return candidate
  }
  return undefined
}

function onPath(bin: string): string | undefined {
  const found = Bun.which(bin)
  return found !== null && found.length > 0 && existsSync(found) ? found : undefined
}

export function resolveTmuxBin(): string {
  return (
    firstExisting([
      process.env['TMUX_BIN'],
      '/opt/homebrew/bin/tmux',
      '/usr/local/bin/tmux',
      '/usr/bin/tmux',
    ]) ?? 'tmux'
  )
}

export function resolveClaudeBin(): string | undefined {
  return (
    firstExisting([
      process.env['ASP_CLAUDE_PATH'],
      join(homedir(), '.local/bin/claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    ]) ?? onPath('claude')
  )
}

function nvmCandidates(bin: string): string[] {
  const versionsDir = join(homedir(), '.nvm/versions/node')
  if (!existsSync(versionsDir)) return []
  try {
    return readdirSync(versionsDir)
      .sort()
      .reverse()
      .map((v) => join(versionsDir, v, 'bin', bin))
  } catch {
    return []
  }
}

export function resolveCodexBin(): string | undefined {
  return (
    firstExisting([
      process.env['ASP_CODEX_PATH'],
      join(homedir(), '.local/bin/codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      ...nvmCandidates('codex'),
      join(homedir(), '.volta/bin/codex'),
      join(homedir(), '.asdf/shims/codex'),
    ]) ?? onPath('codex')
  )
}

export function resolvePiBin(): string | undefined {
  return (
    firstExisting([
      process.env['ASP_PI_PATH'],
      process.env['PI_PATH'],
      join(homedir(), '.local/bin/pi'),
      '/opt/homebrew/bin/pi',
      '/usr/local/bin/pi',
    ]) ?? onPath('pi')
  )
}

function tmuxProbe(): DependencyProbe | undefined {
  const tmux = resolveTmuxBin()
  if (tmux === 'tmux' && onPath('tmux') === undefined) {
    return { available: false, reason: 'tmux binary not found (set TMUX_BIN)' }
  }
  return undefined
}

function authProbe(path: string, label: string): DependencyProbe | undefined {
  return existsSync(path)
    ? undefined
    : { available: false, reason: `${label} auth not present at ${path}` }
}

// ---------------------------------------------------------------------------
// Hermetic fixture agent — one shape for every compiled row
// ---------------------------------------------------------------------------

type Fixture = { agentRoot: string; projectRoot: string; aspHome: string; cleanup: () => void }

function localRegistryRepo(projectRoot: string): string | undefined {
  return [
    process.env['ASP_REGISTRY'],
    process.env['ASP_HOME'] !== undefined ? join(process.env['ASP_HOME'], 'repo') : undefined,
    join(resolve(projectRoot, '..'), 'var', 'spaces-repo', 'repo'),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .find((candidate) => existsSync(join(candidate, 'spaces', 'defaults', 'space.toml')))
}

function createFixture(kind: string, agentName: string, repoRoot: string): Fixture {
  // realpath the tmp base: on macOS the per-user tmpdir lives under the `/var`
  // -> `/private/var` symlink, and a harness that canonicalizes its cwd (codex
  // does) then fails to match the compiler-written
  // `[projects."<non-canonical path>"] trust_level = "trusted"` key and blocks
  // on an interactive directory-trust prompt. Canonicalizing here keeps the row
  // testing the DRIVER rather than macOS symlink resolution.
  const base = realpathSync(mkdtempSync(join(tmpdir(), `admission-matrix-${kind}-`)))
  const agentRoot = join(base, 'agents', agentName)
  const projectRoot = join(base, 'project')
  const aspHome = join(base, 'asp-home')
  const skillDir = join(agentRoot, 'skills', 'admission-matrix-skill')
  mkdirSync(skillDir, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    'version = 3\n\n[spaces]\nbase = []\n',
    'utf8'
  )
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: admission-matrix-skill\ndescription: Admission conformance matrix fixture skill.\n---\n\nAdmission matrix skill loaded.\n',
    'utf8'
  )
  const repoLink = join(aspHome, 'repo')
  const source = localRegistryRepo(repoRoot)
  if (source !== undefined && !existsSync(repoLink)) symlinkSync(source, repoLink, 'dir')
  return {
    agentRoot,
    projectRoot,
    aspHome,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

// ---------------------------------------------------------------------------
// Compile requests — one parameterized builder, one `requested` block per row
// ---------------------------------------------------------------------------

const REQUESTED: Record<string, RuntimeCompileRequest['requested']> = {
  'claude-code-tmux': {
    modelProvider: 'anthropic',
    model: 'sonnet',
    harnessFamily: 'claude-code',
    preferredHarnessRuntime: 'claude-code-cli',
    interactionMode: 'interactive',
  },
  'codex-cli-tmux': {
    modelProvider: 'openai',
    reasoningEffort: 'medium',
    harnessFamily: 'codex',
    preferredHarnessRuntime: 'codex-cli',
    interactionMode: 'interactive',
  },
  'pi-tui-tmux': {
    modelProvider: 'openai',
    model: 'gpt-5.5',
    reasoningEffort: 'medium',
    harnessFamily: 'pi',
    preferredHarnessRuntime: 'pi-cli',
    interactionMode: 'interactive',
  },
  'codex-app-server': {
    modelProvider: 'openai',
    reasoningEffort: 'medium',
    harnessFamily: 'codex',
    preferredHarnessRuntime: 'codex-cli',
    interactionMode: 'headless',
  },
}

function allowPermissionPolicy(): BrokerPermissionPolicy {
  return {
    mode: 'allow',
    audit: true,
    provenance: {
      source: 'test',
      requestId: 'request_admission_matrix',
      createdAt: new Date().toISOString(),
    },
  } as BrokerPermissionPolicy
}

function compileRequest(input: {
  kind: string
  fixture: Fixture
  agentName: string
  marker: string
  prompt: string
  timeoutMs: number
}): RuntimeCompileRequest {
  const ns = `admission_matrix_${input.kind.replace(/-/g, '_')}`
  const identity = allocatePreHrcRuntimeIdentity({
    namespace: ns,
    invocationId: `inv_${ns}_${input.marker}`,
    initialInputId: `input_${ns}_${input.marker}`,
    idempotencyKey: `${ns}-${input.marker}`,
  })
  const requested = REQUESTED[input.kind]
  if (requested === undefined) throw new Error(`no compile recipe for driver kind ${input.kind}`)
  const headless = requested.interactionMode === 'headless'
  const scopeRef = `agent:${input.agentName}:project:agent-spaces:task:T-07860`
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity,
    placement: buildPlacementFromScopeRef({
      scopeRef,
      agentName: input.agentName,
      agentRoot: input.fixture.agentRoot,
      projectRoot: input.fixture.projectRoot,
      cwd: input.fixture.projectRoot,
      hostSessionId: identity.hostSessionId,
    }),
    requested,
    materialization: {
      initialPrompt: input.prompt,
      attachments: [],
      taskContext: {
        taskId: 'T-07860',
        phase: 'admission-matrix',
        role: 'conformance',
        requiredEvidenceKinds: ['contract-artifacts'],
        hintsText: `admission conformance matrix ${input.kind} row`,
      },
    },
    hrcPolicy: {
      permissionPolicy: allowPermissionPolicy(),
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: headless
        ? { mode: 'none' }
        : { mode: 'broker-reports-target', targetKind: 'tmux-session' },
      resourceLimits: { startupTimeoutMs: input.timeoutMs, turnTimeoutMs: input.timeoutMs },
      observability: { traceId: identity.traceId },
      capabilityPolicy: { allowDegrade: false, requireBrokerDefaultForCodexHeadless: true },
    },
    correlation: {
      requestId: identity.requestId,
      operationId: identity.operationId,
      hostSessionId: identity.hostSessionId,
      generation: identity.generation,
      runtimeId: identity.runtimeId,
      runId: identity.runId,
      invocationId: identity.invocationId,
      traceId: identity.traceId,
      appId: 'agent-spaces',
      appSessionKey: `${ns}-${input.marker}`,
      scopeRef,
      laneRef: 'main',
    },
  } as RuntimeCompileRequest
}

const compilerRuntime = {
  getHarnessAdapter: (harnessId: string) =>
    harnessRegistry.getOrThrow(harnessId as Parameters<typeof harnessRegistry.getOrThrow>[0]),
  detectAgentLocalComponents,
  planPlacementRuntime,
  prepareAgentToolRuntime,
  prepareCodexRuntimeHome,
}

async function compileProfile(
  kind: string,
  fixture: Fixture,
  request: RuntimeCompileRequest
): Promise<BrokerExecutionProfile> {
  const client = createAgentSpacesClient({ aspHome: fixture.aspHome, runtime: compilerRuntime })
  const response = await client.compileRuntimePlan(request)
  if (!response.ok) {
    throw new Error(
      `compileRuntimePlan failed for ${kind}: ${JSON.stringify(response.diagnostics)}`
    )
  }
  const profile = response.plan.executionProfiles.find(
    (candidate): candidate is BrokerExecutionProfile =>
      candidate.kind === 'harness-broker' && candidate.brokerDriver === kind
  )
  if (profile === undefined) throw new Error(`compile emitted no ${kind} broker profile`)
  return profile
}

// ---------------------------------------------------------------------------
// tmux pane allocation
// ---------------------------------------------------------------------------

function runTmux(bin: string, argv: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    proc.on('error', reject)
    proc.on('close', (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`tmux ${argv.join(' ')} exited ${code}: ${stderr}`))
    )
  })
}

let paneCounter = 0

async function allocatePane(
  ctx: PlanContext,
  kind: string
): Promise<{ runtime: InvocationRuntimeContext; cleanup: () => Promise<void> }> {
  // Short by construction: a tmux server socket and its derived pane/launch
  // artifact paths must fit the ~104-byte sockaddr_un budget, which the macOS
  // per-user tmpdir alone already eats most of.
  paneCounter += 1
  const socketPath = join('/tmp', `amt-${process.pid}-${paneCounter}.sock`)
  await runTmux(ctx.tmuxBin, ['-S', socketPath, 'start-server'])
  const allocated = await allocatePreHrcTmuxPane({
    tmuxBin: ctx.tmuxBin,
    socketPath,
    sessionName: `am-${kind}-${ctx.marker}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60),
  })
  // Only meaningful once a session exists: `start-server` on an empty server
  // exits immediately, so these must follow pane allocation.
  await runTmux(ctx.tmuxBin, ['-S', socketPath, 'set-option', '-g', 'exit-empty', 'off'])
  await runTmux(ctx.tmuxBin, ['-S', socketPath, 'set-option', '-g', 'remain-on-exit', 'on'])
  return {
    runtime: { terminalSurface: allocated.lease },
    cleanup: async () => {
      await runTmux(ctx.tmuxBin, ['-S', socketPath, 'kill-server']).catch(() => undefined)
    },
  }
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

function exportCodexPath(): void {
  const codex = resolveCodexBin()
  if (codex === undefined) return
  process.env['ASP_CODEX_PATH'] = codex
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
}

function exportPiPath(): void {
  const pi = resolvePiBin()
  if (pi === undefined) return
  process.env['ASP_PI_PATH'] = pi
}

/** Priming prompt every seat runs at launch: cheap, deterministic, tool-free. */
export const PRIMING_PROMPT = 'Reply with exactly READY and nothing else. Do not use any tools.'

function compiledRecipe(input: {
  kind: string
  agentName: string
  needsPane: boolean
  probe: () => DependencyProbe
  driver: (hookIpcDir: string, controlDir: string) => Driver
  /**
   * Point the compiler at the binary the probe resolved. `codex` / `pi` are
   * frequently absent from a headless agent's PATH (version-manager installs),
   * and the compiler reads these env keys — so a row that probed a real binary
   * must hand that same path to the compile, or the compiled launch is a
   * different binary than the one the row claims to be testing.
   */
  prepareEnv?: () => void
}): RowRecipe {
  return {
    kind: input.kind,
    probe: input.probe,
    plan: async (ctx) => {
      input.prepareEnv?.()
      const fixture = createFixture(input.kind, input.agentName, ctx.repoRoot)
      const cleanups: Array<() => Promise<void> | void> = [fixture.cleanup]
      try {
        const profile = await compileProfile(
          input.kind,
          fixture,
          compileRequest({
            kind: input.kind,
            fixture,
            agentName: input.agentName,
            marker: ctx.marker,
            prompt: PRIMING_PROMPT,
            timeoutMs: ctx.timeoutMs,
          })
        )
        let runtime: InvocationRuntimeContext | undefined
        if (input.needsPane) {
          const pane = await allocatePane(ctx, input.kind)
          runtime = pane.runtime
          cleanups.push(pane.cleanup)
        }
        return {
          driver: input.driver(ctx.hookIpcDir, join(ctx.hookIpcDir, 'control')),
          startRequest: profile.harnessInvocation.startRequest,
          runtime,
          primingPrompt: PRIMING_PROMPT,
          compile: {
            profileHash: profile.profileHash,
            startRequestHash: profile.harnessInvocation.startRequestHash,
          },
          cleanup: async () => {
            for (const fn of cleanups.reverse()) await fn()
          },
        }
      } catch (error) {
        for (const fn of cleanups.reverse()) await fn()
        throw error
      }
    },
  }
}

/**
 * agent-harness-tmux has no compiler route (`compiler/agent-spaces/src/types.ts`
 * knows four broker drivers), so its spec is built directly — the same shape
 * `direct-agent-harness.ts` builds for the headless surface.
 */
function agentHarnessRecipe(): RowRecipe {
  const authStore = join(homedir(), '.pi', 'agent', 'auth.json')
  return {
    kind: 'agent-harness-tmux',
    probe: () => {
      const bin = onPath('agent-harness')
      if (bin === undefined) return { available: false, reason: 'agent-harness binary not on PATH' }
      const tmux = tmuxProbe()
      if (tmux !== undefined) return tmux
      const auth = authProbe(authStore, 'pi')
      if (auth !== undefined) return auth
      return { available: true, reason: `agent-harness at ${bin}, pi auth at ${authStore}` }
    },
    plan: async (ctx) => {
      const pane = await allocatePane(ctx, 'agent-harness-tmux')
      const invocationId = `inv_admission_matrix_agent_harness_${ctx.marker}`
      const spec = {
        specVersion: 'harness-broker.invocation/v1',
        invocationId,
        harness: { frontend: 'agent-harness', provider: 'openai', driver: 'agent-harness-tmux' },
        process: {
          command: join(ctx.repoRoot, 'harness/agent-harness/bin/agent-harness.js'),
          args: ['tui'],
          cwd: ctx.repoRoot,
          lockedEnv: {
            ASP_HOME: process.env['ASP_HOME'] ?? join(homedir(), 'praesidium/var/spaces-repo'),
          },
          harnessTransport: { kind: 'pty' },
        },
        interaction: { mode: 'interactive', turnConcurrency: 'single', inputQueue: 'fifo' },
        driver: {
          kind: 'agent-harness-tmux',
          terminalHost: 'tmux',
          permissionPolicy: { mode: 'allow' },
        },
        sdk: {
          runtime: 'pi-sdk',
          provider: 'openai-codex',
          modelId: 'gpt-5.6-terra',
          authMode: 'oauth',
        },
        agent: {
          agentId: 'sparky',
          projectId: 'agent-spaces',
          aspHome: process.env['ASP_HOME'] ?? join(homedir(), 'praesidium/var/spaces-repo'),
          runMode: 'task',
          scopeRef: 'agent:sparky:project:agent-spaces:task:T-07860',
          runId: `run-${ctx.marker}`,
        },
        correlation: { runtimeId: `runtime-${ctx.marker}` },
      } as unknown as HarnessInvocationSpec
      return {
        driver: createDefaultAgentHarnessTmuxDriver(join(ctx.hookIpcDir, 'control'), {
          readStoredCredential,
        }),
        startRequest: { spec },
        runtime: pane.runtime,
        dispatchEnv: { HARNESS_PI_AUTH_STORE: authStore },
        cleanup: pane.cleanup,
      }
    },
  }
}

export const ROW_RECIPES: Record<string, RowRecipe> = {
  'claude-code-tmux': compiledRecipe({
    kind: 'claude-code-tmux',
    agentName: 'curly',
    needsPane: true,
    driver: (hookIpcDir) => createDefaultClaudeCodeTmuxDriver(hookIpcDir),
    probe: () => {
      const claude = resolveClaudeBin()
      if (claude === undefined)
        return { available: false, reason: 'claude binary not found (set ASP_CLAUDE_PATH)' }
      const tmux = tmuxProbe()
      if (tmux !== undefined) return tmux
      return { available: true, reason: `real claude at ${claude}` }
    },
  }),
  'codex-cli-tmux': compiledRecipe({
    kind: 'codex-cli-tmux',
    agentName: 'curly',
    needsPane: true,
    prepareEnv: exportCodexPath,
    driver: (hookIpcDir) => createDefaultCodexCliTmuxDriver(hookIpcDir),
    probe: () => {
      const codex = resolveCodexBin()
      if (codex === undefined)
        return { available: false, reason: 'codex binary not found (set ASP_CODEX_PATH)' }
      const tmux = tmuxProbe()
      if (tmux !== undefined) return tmux
      const auth = authProbe(join(homedir(), '.codex', 'auth.json'), 'codex')
      if (auth !== undefined) return auth
      return { available: true, reason: `real codex at ${codex}` }
    },
  }),
  'pi-tui-tmux': compiledRecipe({
    kind: 'pi-tui-tmux',
    agentName: 'curly',
    needsPane: true,
    prepareEnv: exportPiPath,
    driver: (hookIpcDir) => createDefaultPiTuiTmuxDriver(hookIpcDir),
    probe: () => {
      const pi = resolvePiBin()
      if (pi === undefined)
        return { available: false, reason: 'pi binary not found (set ASP_PI_PATH)' }
      const tmux = tmuxProbe()
      if (tmux !== undefined) return tmux
      const auth = authProbe(join(homedir(), '.pi', 'agent', 'auth.json'), 'pi')
      if (auth !== undefined) return auth
      return { available: true, reason: `real pi at ${pi}` }
    },
  }),
  'codex-app-server': compiledRecipe({
    kind: 'codex-app-server',
    agentName: 'curly',
    needsPane: false,
    prepareEnv: exportCodexPath,
    driver: () => createCodexAppServerDriver(),
    probe: () => {
      const codex = resolveCodexBin()
      if (codex === undefined)
        return { available: false, reason: 'codex binary not found (set ASP_CODEX_PATH)' }
      const auth = authProbe(join(homedir(), '.codex', 'auth.json'), 'codex')
      if (auth !== undefined) return auth
      return { available: true, reason: `real codex at ${codex}` }
    },
  }),
  'agent-harness-tmux': agentHarnessRecipe(),
}
