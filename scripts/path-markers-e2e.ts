/**
 * Code-path liveness markers E2E (T-11825).
 *
 *   bun scripts/path-markers-e2e.ts tree <base> <out> <metrics-var-root>
 *     Compile one request per catalog recipe in-process under the fixed scratch
 *     root <base>, then copy the compiled plans and the materialized ASP_HOME
 *     tree to <out>. Run once before and once after a change with the same
 *     <base> and diff the two <out> dirs: markers must leave both identical.
 *     Marker rows go to <metrics-var-root>/state/agent-spaces/metrics.
 *
 *   bun scripts/path-markers-e2e.ts e2e <base> <out>
 *     Start a scratch aspd from source on <base>/aspd.sock, drive every aspc
 *     op and one compile per catalog recipe through it as a named client, run
 *     the scratch asp CLI (agent, run, install, build, describe), then read
 *     back paths-<day>.ndjson and write <out>/coverage.json: every approved
 *     marker fired, or is named as unreachable from this drive and why.
 *
 * The fixture is hermetic: the agents root holds one @dev space (mutable
 * staging branch) and one claude+agent-harness space (harness-skip branch on
 * codex and muse); a seeded immutable mirror (fixed commit dates, so the
 * pinned sha is stable) holds one git-pinned space (immutable cache/snapshot
 * branch).
 */
import { mock, setSystemTime } from 'bun:test'
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import * as nodeCrypto from 'node:crypto'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

import type { RuntimeCompileRequest } from 'spaces-runtime-contracts'

// ASP modules load lazily (see loadAsp) so `tree` can pin node:crypto and the
// clock before any of them binds randomUUID.
export async function loadAsp() {
  const [config, execution, contracts, compiler] = await Promise.all([
    import('spaces-config'),
    import('spaces-execution'),
    import('spaces-runtime-contracts'),
    import('../compiler/agent-spaces/src/index.js'),
  ])
  return { config, execution, contracts, compiler }
}
export type Asp = Awaited<ReturnType<typeof loadAsp>>

const NOW_ISO = '2026-10-26T00:00:00.000Z'
const AGENT = 'pathmark'
/**
 * Codex rows use a second agent without the git-pinned space: the codex model
 * probe (drivers/execution/src/run/space-codex-model.ts) computes its closure
 * without the immutable mirror, so a pinned space makes every codex compile
 * throw. That is a pre-existing defect, reported rather than fixed here.
 */
const DEV_AGENT = 'pathmark-dev'

export type Row = {
  id: string
  requested: RuntimeCompileRequest['requested']
  resume?: boolean
  agent?: string
}

export const ROWS: Row[] = [
  { id: 'agent-harness-headless', requested: { harness: 'agent-harness', presentation: false } },
  { id: 'agent-harness-tui', requested: { harness: 'agent-harness', presentation: true } },
  { id: 'claude-code', requested: { harness: 'claude', presentation: true } },
  { id: 'claude-code-resume', requested: { harness: 'claude', presentation: true }, resume: true },
  {
    id: 'codex-app-server',
    requested: { harness: 'codex', presentation: false },
    agent: DEV_AGENT,
  },
  { id: 'codex-tui', requested: { harness: 'codex', presentation: true }, agent: DEV_AGENT },
  { id: 'muse-serve', requested: { harness: 'muse', presentation: false } },
  { id: 'muse-tui', requested: { harness: 'muse', presentation: true } },
]

export type Fixture = {
  base: string
  agentsRoot: string
  projectRoot: string
  aspHome: string
}

export function writeSpace(root: string, id: string, supports?: string[]): void {
  const dir = join(root, 'spaces', id)
  mkdirSync(join(dir, 'skills', `${id}-skill`), { recursive: true })
  writeFileSync(
    join(dir, 'space.toml'),
    `schema = 1\nid = "${id}"\nversion = "1.0.0"\ndescription = "path marker fixture"\n\n[plugin]\nname = "${id}"\n${
      supports === undefined ? '' : `\n[harness]\nsupports = ${JSON.stringify(supports)}\n`
    }`
  )
  writeFileSync(
    join(dir, 'skills', `${id}-skill`, 'SKILL.md'),
    `---\nname: ${id}-skill\ndescription: ${id} fixture skill.\n---\n\nLoaded.\n`
  )
}

/**
 * Seed the node-local immutable mirror in place of a network clone: a git repo
 * at the portable registry's mirror path whose origin names the canonical
 * remote. Compiles never fetch it (deferImmutableRegistry uses fetch:false).
 */
function seedImmutableMirror(asp: Asp, aspHome: string): string {
  const { PORTABLE_SPACES_REGISTRY, PathResolver } = asp.config
  const mirror = new PathResolver({ aspHome }).immutableRepository(
    PORTABLE_SPACES_REGISTRY.repository
  )
  writeSpace(mirror, 'pm-pinned')
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'pathmark',
    GIT_AUTHOR_EMAIL: 'pathmark@example.invalid',
    GIT_COMMITTER_NAME: 'pathmark',
    GIT_COMMITTER_EMAIL: 'pathmark@example.invalid',
    GIT_AUTHOR_DATE: '2026-10-26T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-10-26T00:00:00Z',
  }
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: mirror, env, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('remote', 'add', 'origin', PORTABLE_SPACES_REGISTRY.canonicalRemote)
  git('add', '.')
  git('commit', '-q', '-m', 'pathmark registry')
  return git('rev-parse', 'HEAD')
}

export function writeAgent(agentsRoot: string, agent: string, spaces: string[]): void {
  const agentRoot = join(agentsRoot, agent)
  mkdirSync(join(agentRoot, 'skills', 'pathmark-skill'), { recursive: true })
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    `version = 4\npriming = "pathmark priming for {{agentId}}"\n\n[spaces]\nbase = ${JSON.stringify(spaces)}\n`
  )
  writeFileSync(join(agentRoot, 'SOUL.md'), '# Pathmark\n\nFixture agent for path markers.\n')
  writeFileSync(
    join(agentRoot, 'skills', 'pathmark-skill', 'SKILL.md'),
    '---\nname: pathmark-skill\ndescription: Path marker fixture skill.\n---\n\nLoaded.\n'
  )
}

/**
 * <base>/agents is the agents root (ASP_AGENTS_ROOT): it holds the fixture
 * agents and the mutable registry (spaces/pm-dev, spaces/pm-claude-only).
 */
export function createFixture(asp: Asp, base: string): Fixture {
  rmSync(base, { recursive: true, force: true })
  const agentsRoot = join(base, 'agents')
  const projectRoot = join(base, 'project')
  const aspHome = join(base, 'asp-home')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  writeSpace(agentsRoot, 'pm-dev')
  writeSpace(agentsRoot, 'pm-claude-only', ['claude', 'agent-harness'])
  const sha = seedImmutableMirror(asp, aspHome)
  writeAgent(agentsRoot, AGENT, [
    'space:pm-dev@dev',
    `space:pm-pinned@git:${sha}`,
    'space:pm-claude-only@dev',
  ])
  writeAgent(agentsRoot, DEV_AGENT, ['space:pm-dev@dev', 'space:pm-claude-only@dev'])
  return { base, agentsRoot, projectRoot, aspHome }
}

export function compileRequest(asp: Asp, fixture: Fixture, row: Row): RuntimeCompileRequest {
  const agent = row.agent ?? AGENT
  const agentRoot = join(fixture.agentsRoot, agent)
  const suffix = `pathmark_${row.id.replaceAll('-', '_')}`
  const scopeRef = `agent:${agent}:project:project:task:T-11825`
  const ids = {
    requestId: `request_${suffix}`,
    operationId: `operation_${suffix}`,
    hostSessionId: `host_${suffix}`,
    generation: 1,
    runtimeId: `runtime_${suffix}`,
    invocationId: `inv_${suffix}`,
    initialInputId: `input_${suffix}`,
    runId: `run_${suffix}`,
    traceId: `trace_${suffix}`,
    idempotencyKey: suffix,
  }
  return {
    schemaVersion: 'agent-runtime-compile-request/v2',
    agent: { id: agent },
    identity: ids,
    placement: {
      agentRoot,
      projectRoot: fixture.projectRoot,
      cwd: fixture.projectRoot,
      runMode: 'task',
      bundle: { kind: 'agent-project', agentName: agent, projectRoot: fixture.projectRoot },
      correlation: {
        sessionRef: { scopeRef, laneRef: 'main' },
        hostSessionId: ids.hostSessionId,
      },
    },
    requested: row.requested,
    materialization: {
      initialPrompt: 'pathmark prompt',
      attachments: [],
      taskContext: {
        taskId: 'T-11825',
        phase: 'pathmark',
        role: 'fixture',
        requiredEvidenceKinds: [],
        hintsText: 'path marker fixture',
      },
    },
    ...(row.resume === true
      ? {
          continuation: {
            hrc: {
              provider: 'anthropic',
              key: 'pathmark-session',
              continuationId: 'cont_pathmark',
            },
            source: 'hrc',
          },
        }
      : {}),
    hrcPolicy: {
      permissionPolicy: {
        mode: 'allow',
        audit: true,
        provenance: { source: 'test', requestId: ids.requestId, createdAt: NOW_ISO },
      },
      inputPolicy: asp.contracts.DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
      resourceLimits: { startupTimeoutMs: 60_000, turnTimeoutMs: 60_000 },
      observability: { traceId: ids.traceId },
      capabilityPolicy: { allowDegrade: false, requireBrokerDefaultForCodexHeadless: true },
    },
    correlation: {
      requestId: ids.requestId,
      operationId: ids.operationId,
      hostSessionId: ids.hostSessionId,
      generation: 1,
      runtimeId: ids.runtimeId,
      runId: ids.runId,
      invocationId: ids.invocationId,
      traceId: ids.traceId,
      appId: 'agent-spaces',
      appSessionKey: suffix,
      scopeRef,
      laneRef: 'main',
    },
  } as unknown as RuntimeCompileRequest
}

export function compilerRuntime(asp: Asp) {
  const { harnessRegistry } = asp.execution
  return {
    getHarnessAdapter: (harnessId: string) =>
      harnessRegistry.getOrThrow(harnessId as Parameters<typeof harnessRegistry.getOrThrow>[0]),
    detectAgentLocalComponents: asp.execution.detectAgentLocalComponents,
    planPlacementRuntime: asp.execution.planPlacementRuntime,
    prepareAgentToolRuntime: asp.execution.prepareAgentToolRuntime,
    prepareCodexRuntimeHome: asp.execution.prepareCodexRuntimeHome,
    resolveCodexRuntimeHomePath: asp.execution.resolveCodexRuntimeHomePath,
  }
}

/**
 * Pin what a compile reads from the environment and doesn't take from
 * compileContext: the wall clock, random UUIDs (staging dirs, claude
 * --session-id) and the pid (staging dir names). Two runs of the same code
 * over the same <base> then produce byte-identical trees.
 */
function pinNondeterminism(): void {
  setSystemTime(new Date(NOW_ISO))
  let n = 0
  const randomUUID = (): `${string}-${string}-${string}-${string}-${string}` =>
    `00000000-0000-4000-8000-${(n++).toString(16).padStart(12, '0')}`
  mock.module('node:crypto', () => ({ ...nodeCrypto, randomUUID }))
  globalThis.crypto.randomUUID = randomUUID
  Object.defineProperty(process, 'pid', { value: 4242 })
}

async function tree(base: string, out: string, metricsVarRoot: string): Promise<void> {
  pinNondeterminism()
  const asp = await loadAsp()
  // Through the host config, not ASP_USAGE_METRICS_VAR_ROOT: the environment is
  // hashed into every plan (effectiveEnvironmentHash), so it must match the
  // baseline run exactly.
  const { configureUsageMetricsHost } = await import('spaces-config/usage-metrics')
  configureUsageMetricsHost({ varRoot: resolve(metricsVarRoot) })
  const fixture = createFixture(asp, resolve(base))
  process.env['ASP_AGENTS_ROOT'] = fixture.agentsRoot
  const client = asp.compiler.createAgentSpacesClient({
    aspHome: fixture.aspHome,
    runtime: compilerRuntime(asp),
  })
  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, 'plans'), { recursive: true })
  for (const row of ROWS) {
    let result: unknown
    try {
      result = await client.compileRuntimePlan(compileRequest(asp, fixture, row), {
        compileContext: { nowIso: NOW_ISO, idSalt: 'pathmark' },
      })
    } catch (error) {
      // A throw is a compile outcome too; record it so before/after compare it.
      result = { threw: String(error), issues: (error as { issues?: unknown }).issues }
    }
    writeFileSync(join(out, 'plans', `${row.id}.json`), `${JSON.stringify(result, null, 2)}\n`)
    const ok = (result as { ok?: boolean }).ok === true
    process.stdout.write(`${row.id}: ${ok ? 'ok' : JSON.stringify(result).slice(0, 400)}\n`)
  }
  cpSync(fixture.aspHome, join(out, 'asp-home'), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => !src.startsWith(join(fixture.aspHome, 'tmp')) && !src.includes(`${'/'}.git`),
  })
  if (existsSync(join(fixture.aspHome, 'tmp'))) mkdirSync(join(out, 'asp-home', 'tmp'))
}

// ---------------------------------------------------------------------------
// E2E: a scratch aspd (from source) plus scratch asp CLI runs, then read back
// paths-<day>.ndjson and account for every approved marker.
// ---------------------------------------------------------------------------

/** Every approved marker, with why the scratch drive cannot reach it (if so). */
export const APPROVED_MARKERS: Record<string, string | undefined> = {
  'compile.entry': undefined,
  'compile.recipe': undefined,
  'compile.harness-source': undefined,
  'compile.continuation': undefined,
  'compile.inspection': undefined,
  'client.prepare-process': undefined,
  'client.process-spec': undefined,
  'client.legacy-entry': undefined,
  'declaration.resolve': undefined,
  'declaration.project-mode': undefined,
  'declaration.agent-root': undefined,
  'declaration.profile-absent': undefined,
  'placement.inspect': undefined,
  'placement.scaffold-fallback': undefined,
  'capability.observe': undefined,
  'continuation.observe': undefined,
  'aspc.observation-schema-fallback': undefined,
  'prepare.frontend': undefined,
  'prepare.spec-kind': undefined,
  'prepare.identity': undefined,
  'prepare.system-prompt': undefined,
  'prepare.codex-home': undefined,
  'harness.detect': undefined,
  'materialize.registry-fetch': undefined,
  'materialize.lock-write': undefined,
  'materialize.snapshot': undefined,
  'materialize.space': undefined,
  'materialize.agent-local': undefined,
  'materialize.bundle': undefined,
  'materialize.bundle-prune': undefined,
  'materialize.codex-home': undefined,
  'materialize.prompt-artifact': undefined,
  'run.entry': undefined,
  'run.legacy-migrate': undefined,
  'run.surface': undefined,
  'install.entry': undefined,
}

const E2E_CLIENT = { name: 'pathmark-e2e', version: '1.0.0' }

/** `serve <socket> <metrics-var-root> <log>`: the scratch aspd child. */
async function serve(socketPath: string, metricsVarRoot: string, logPath: string): Promise<void> {
  const { configureUsageMetricsHost, usageMetrics } = await import('spaces-config/usage-metrics')
  configureUsageMetricsHost({ product: 'aspd/scratch', varRoot: resolve(metricsVarRoot) })
  const { createAspcService } = await import('spaces-aspc')
  const { createRuntimeCompiler, runtimeDependencies } = await import(
    '../harness/aspc-facade/src/runtime-compiler.js'
  )
  const { startAspdServer } = await import('../harness/aspc-facade/src/aspd.js')
  const server = await startAspdServer({
    socketPath,
    service: createAspcService({ compiler: createRuntimeCompiler(), runtimeDependencies }),
    log: (line) => appendFileSync(logPath, `${line}\n`),
    metrics: usageMetrics('aspd'),
  })
  process.on('SIGTERM', () => {
    void server.retire().then(() => process.exit(0))
  })
  process.stdout.write('ready\n')
}

async function startScratchAspd(
  cwd: string,
  socketPath: string,
  metricsVarRoot: string,
  logPath: string,
  env: NodeJS.ProcessEnv
): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [import.meta.path, 'serve', socketPath, metricsVarRoot, logPath],
    { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] }
  )
  await new Promise<void>((resolveReady, reject) => {
    child.once('exit', (code) => reject(new Error(`scratch aspd exited ${code}`)))
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready')) resolveReady()
    })
  })
  return child
}

function declarationContext(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    agentId: AGENT,
    project: { mode: 'root', projectRoot: fixture.projectRoot },
    cwd: fixture.projectRoot,
    runMode: 'task',
    ...overrides,
  }
}

async function driveAspd(asp: Asp, fixture: Fixture, socketPath: string, log: string[]) {
  const { AspcUnixClient } = await import('spaces-aspc-protocol/unix-client')
  const client = await AspcUnixClient.connect({ socketPath, clientInfo: E2E_CLIENT })
  const call = async (label: string, fn: () => Promise<unknown>) => {
    try {
      const response = (await fn()) as { ok?: unknown } | undefined
      log.push(`aspd ${label}: ok=${String(response?.ok)}`)
    } catch (error) {
      log.push(`aspd ${label}: threw ${String(error).slice(0, 200)}`)
    }
  }
  for (const row of ROWS) {
    await call(`compileHarnessInvocation ${row.id}`, () =>
      client.compileHarnessInvocation({
        compileRequest: compileRequest(asp, fixture, row),
        aspHome: fixture.aspHome,
      })
    )
  }
  const ctx = declarationContext(fixture)
  const req = (context: Record<string, unknown>) =>
    ({ schemaVersion: 'aspc-resolve-runtime-declaration-request/v1', context }) as never
  await call('resolveRuntimeDeclaration root', () => client.resolveRuntimeDeclaration(req(ctx)))
  await call('resolveRuntimeDeclaration infer-from-cwd', () =>
    client.resolveRuntimeDeclaration(
      req(declarationContext(fixture, { project: { mode: 'infer-from-cwd' } }))
    )
  )
  await call('resolveRuntimeDeclaration none', () =>
    client.resolveRuntimeDeclaration(
      req(declarationContext(fixture, { project: { mode: 'none' } }))
    )
  )
  await call('resolveRuntimeDeclaration supplied-root', () =>
    client.resolveRuntimeDeclaration(
      req(declarationContext(fixture, { agentRoot: join(fixture.agentsRoot, AGENT) }))
    )
  )
  await call('resolveRuntimeDeclaration unknown-agent', () =>
    client.resolveRuntimeDeclaration(req(declarationContext(fixture, { agentId: 'pm-nobody' })))
  )
  await call('resolveRuntimeDeclaration profile-less agent', () =>
    client.resolveRuntimeDeclaration(req(declarationContext(fixture, { agentId: 'pm-bare' })))
  )
  await call('resolveRuntimeDeclaration foreign-schema', () =>
    client.resolveRuntimeDeclaration({
      schemaVersion: 'aspc-resolve-runtime-declaration-request/v0',
      context: ctx,
    } as never)
  )
  await call('inspectRuntimePlacement', () =>
    client.inspectRuntimePlacement({
      schemaVersion: 'aspc-inspect-runtime-placement-request/v1',
      context: ctx,
    } as never)
  )
  for (const harness of ['agent-harness', 'claude', 'codex', 'muse']) {
    await call(`observeRuntimeCapability ${harness}`, () =>
      client.observeRuntimeCapability({
        schemaVersion: 'aspc-observe-runtime-capability-request/v1',
        harness,
        context: ctx,
      } as never)
    )
  }
  for (const continuation of [
    { provider: 'anthropic', key: 'pathmark-missing-session' },
    { provider: 'codex', key: 'pathmark-missing-thread' },
    { provider: 'pi', key: join(fixture.base, 'pi-session.jsonl') },
  ]) {
    await call(`observeContinuationArtifact ${continuation.provider}`, () =>
      client.observeContinuationArtifact({
        schemaVersion: 'aspc-observe-continuation-artifact-request/v1',
        continuation,
      })
    )
  }
  const prepare = (context: Record<string, unknown>, expected: Record<string, string>) =>
    client.prepareProcessInvocation({
      schemaVersion: 'aspc-prepare-process-invocation-request/v1',
      context,
      preparationCorrelation: {},
      expected,
      launch: { interactionMode: 'interactive', ioMode: 'pty' },
    } as never)
  await call('prepareProcessInvocation undeclared', () =>
    prepare(ctx, { provider: 'anthropic', frontend: 'claude-code' })
  )
  await call('prepareProcessInvocation claude', () =>
    prepare(declarationContext(fixture, { provisionDirectives: { harness: 'claude' } }), {
      provider: 'anthropic',
      frontend: 'claude-code',
    })
  )
  await client.close()
}

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string[]): void {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  })
  log.push(`asp ${args.join(' ')}: exit=${result.status}`)
  if (result.status !== 0) log.push(`  stderr: ${(result.stderr ?? '').slice(-400)}`)
}

const CLI_ENTRY = resolve(import.meta.dir, '..', 'apps', 'cli', 'src', 'index.ts')

function driveCli(fixture: Fixture, env: NodeJS.ProcessEnv, log: string[]): void {
  const agentRoot = join(fixture.agentsRoot, AGENT)
  const devAgentRoot = join(fixture.agentsRoot, DEV_AGENT)
  const scope = (agent: string) => `${agent}@project:T-11825`
  for (const [harness, root, agent] of [
    ['claude', agentRoot, AGENT],
    ['codex', devAgentRoot, DEV_AGENT],
    ['muse', agentRoot, AGENT],
  ] as const) {
    runCli(
      [
        'agent',
        scope(agent),
        'task',
        'pathmark prompt',
        '--agent-root',
        root,
        '--project-root',
        fixture.projectRoot,
        '--harness',
        harness,
        '--dry-run',
      ],
      fixture.projectRoot,
      env,
      log
    )
  }
  for (const harness of ['claude', 'codex', 'agent-harness']) {
    runCli(['run', 'pm-target', '--harness', harness, '--dry-run'], fixture.projectRoot, env, log)
  }
  runCli(['install'], fixture.projectRoot, env, log)
  runCli(
    ['build', 'pm-target', '--output', join(fixture.base, 'build-out')],
    fixture.projectRoot,
    env,
    log
  )
  runCli(['describe', 'pm-target'], fixture.projectRoot, env, log)
}

type PathRow = { marker: string; caller: string; outcome: string; count: number; host: string }

function readPathRows(metricsVarRoot: string): PathRow[] {
  const dir = join(metricsVarRoot, 'state', 'agent-spaces', 'metrics')
  const rows: PathRow[] = []
  for (const name of readdirSync(dir).filter((file) => file.startsWith('paths-'))) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const row = JSON.parse(line) as PathRow & { kind: string }
      if (row.kind === 'path') rows.push(row)
    }
  }
  return rows
}

async function e2e(base: string, out: string): Promise<number> {
  const asp = await loadAsp()
  const fixture = createFixture(asp, resolve(base))
  // A target for the project-mode CLI paths (asp run/install/build/describe),
  // named apart from the fixture agents so it never overrides their spaces,
  // and an agent with no agent-profile.toml (declaration.profile-absent).
  writeFileSync(
    join(fixture.projectRoot, 'asp-targets.toml'),
    'schema = 2\n\n[targets.pm-target]\ndescription = "path marker fixture"\ncompose = ["space:pm-dev@dev", "space:pm-claude-only@dev"]\n'
  )
  mkdirSync(join(fixture.agentsRoot, 'pm-bare'), { recursive: true })
  writeFileSync(join(fixture.agentsRoot, 'pm-bare', 'SOUL.md'), '# Bare\n')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const metricsVarRoot = resolve(out, 'metrics-var')
  const env = {
    ...process.env,
    ASP_HOME: fixture.aspHome,
    ASP_AGENTS_ROOT: fixture.agentsRoot,
    ASP_USAGE_METRICS_VAR_ROOT: metricsVarRoot,
  }
  const log: string[] = []
  // Relative to <base>: a scratchpad-depth absolute path overruns the 104-byte
  // sun_path limit. Server and client both resolve it from <base>.
  const socketPath = 'aspd.sock'
  const aspd = await startScratchAspd(
    fixture.base,
    socketPath,
    resolve(metricsVarRoot),
    resolve(out, 'aspd.log'),
    env
  )
  const cwd = process.cwd()
  process.chdir(fixture.base)
  try {
    await driveAspd(asp, fixture, socketPath, log)
  } finally {
    process.chdir(cwd)
    const exited = new Promise((done) => aspd.once('exit', done))
    aspd.kill('SIGTERM')
    await exited
  }
  driveCli(fixture, env, log)
  writeFileSync(join(out, 'drive.log'), `${log.join('\n')}\n`)

  const rows = readPathRows(metricsVarRoot)
  const coverage = Object.entries(APPROVED_MARKERS).map(([marker, unreachable]) => {
    const hits = rows.filter((row) => row.marker === marker)
    return {
      marker,
      fired: hits.length > 0,
      count: hits.reduce((sum, row) => sum + row.count, 0),
      outcomes: [...new Set(hits.map((row) => row.outcome))].sort(),
      callers: [...new Set(hits.map((row) => `${row.host}:${row.caller}`))].sort(),
      ...(hits.length === 0 ? { notReachedBecause: unreachable ?? 'UNEXPLAINED' } : {}),
    }
  })
  const unknown = [...new Set(rows.map((row) => row.marker))].filter(
    (marker) => !(marker in APPROVED_MARKERS)
  )
  writeFileSync(
    join(out, 'coverage.json'),
    `${JSON.stringify({ coverage, unknownMarkers: unknown }, null, 2)}\n`
  )
  for (const entry of coverage) {
    process.stdout.write(
      `${entry.fired ? 'FIRED ' : 'MISSED'} ${entry.marker} x${entry.count} ${entry.outcomes.join(',')}${entry.fired ? '' : ` (${entry.notReachedBecause})`}\n`
    )
  }
  const unexplained = coverage.filter(
    (entry) => !entry.fired && entry.notReachedBecause === 'UNEXPLAINED'
  )
  if (unknown.length > 0) process.stdout.write(`unknown markers: ${unknown.join(', ')}\n`)
  return unexplained.length === 0 && unknown.length === 0 ? 0 : 1
}

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2)
  if (mode === 'tree' && args.length === 3) {
    await tree(args[0] as string, args[1] as string, args[2] as string)
  } else if (mode === 'serve' && args.length === 3) {
    await serve(args[0] as string, args[1] as string, args[2] as string)
  } else if (mode === 'e2e' && args.length === 2) {
    process.exit(await e2e(args[0] as string, args[1] as string))
  } else {
    process.stderr.write(
      'usage: bun scripts/path-markers-e2e.ts tree <base> <out> <metrics-var-root>\n' +
        '       bun scripts/path-markers-e2e.ts e2e <base> <out>\n'
    )
    process.exit(2)
  }
}
