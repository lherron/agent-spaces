#!/usr/bin/env bun
/**
 * Scratch E2E for R2 Native reads (T-11838, docs/proposals/aspd-rust-front-door.md).
 *
 * raspd answers `aspc.resolveRuntimeDeclaration` and
 * `aspc.observeContinuationArtifact` itself. This runs a release's Bun aspd on
 * a private socket and its raspd in front (the front-door shape), then sends
 * every request twice, once through raspd and once to Bun directly, at the
 * same moment against the same files, and requires:
 *
 *  1. Byte-identical reply lines (only `evaluatedAt`, the evaluation time, is
 *     tokenized), for the compare runner's R2 cases, the native refusal cases
 *     below, and a sweep of the node's real agents, projects and continuation
 *     artifacts (read-only).
 *  2. Each native-eligible case is served by raspd (`servedBy: native` in
 *     raspd.log, joined by the envelope `client`); each case raspd does not
 *     judge is relayed (`servedBy: bun`, `relay: relayed`) with its `fallback`
 *     reason, and Bun's bytes reach the client unchanged.
 *  3. No file under either stage changes (the reads are read-only).
 *  4. Latency per op, native vs Bun direct, p50/p99 (recorded, not gated).
 *
 * Usage: bun scripts/raspd-native-reads-e2e.ts [--out <dir>] [--commit <sha>]
 *          [--release <built release dir>] [--raspd <binary>] [--iterations <n>]
 *          [--no-corpus]
 */
import { type ChildProcess, spawn } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { basename, join, resolve } from 'node:path'
import {
  type CallCase,
  HELLO_PARAMS,
  type Stage,
  buildCases,
  seedStage,
} from './aspd-compare/cases.ts'
import { buildScratchRelease, must } from './lib/scratch-release.ts'
import { isolateUsageMetrics } from './lib/usage-metrics-isolation.ts'
import { loadAsp } from './path-markers-e2e.ts'

isolateUsageMetrics()

const repo = resolve(import.meta.dir, '..')
const arg = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d+Z$/, 'Z')
const out = resolve(
  arg('--out') ?? join(repo, '..', 'var', 'wrkq-artifacts', 'T-11838', 'e2e', stamp)
)
mkdirSync(out, { recursive: true })
const iterations = Number(arg('--iterations') ?? '200')
const REAL_HOME = process.env['HOME'] as string

type Check = { name: string; ok: boolean; detail?: unknown }
const checks: Check[] = []
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
}
const record = (name: string, value: unknown) =>
  writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`)

// -- release --------------------------------------------------------------------

// Unix socket paths are limited to 104 bytes on macOS; keep the scratch root short.
const scratch = mkdtempSync('/tmp/rnr-')
let releasePath = arg('--release')
let commit = arg('--commit')
if (releasePath === undefined) {
  commit = must(['git', 'rev-parse', commit ?? 'HEAD']).trim()
  releasePath = buildScratchRelease(commit, scratch, join(scratch, 'releases')).releasePath
}
const raspd = arg('--raspd') ?? join(releasePath, 'raspd')
const bunAspd = join(releasePath, 'aspd')
const release = JSON.parse(readFileSync(join(releasePath, 'release.json'), 'utf8')) as {
  releaseId: string
  sourceCommit: string
}

// -- daemons ----------------------------------------------------------------------

type Pair = {
  name: string
  front: string
  bun: string
  raspdLog: string
  children: ChildProcess[]
}

async function waitForSocket(path: string, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (existsSync(path)) return
    if (child.exitCode !== null) throw new Error(`${path}: daemon exited ${child.exitCode}`)
    await Bun.sleep(100)
  }
  throw new Error(`${path} never listened`)
}

/** Bun aspd on aspd-bun.sock, raspd on aspd.sock in front, one literal env. */
async function startPair(name: string, env: Record<string, string>): Promise<Pair> {
  const ns = join(scratch, name)
  mkdirSync(join(ns, 'run'), { recursive: true })
  const front = join(ns, 'run', 'aspd.sock')
  const bun = join(ns, 'run', 'aspd-bun.sock')
  const raspdLog = join(ns, 'raspd.log')
  const options = { cwd: ns, env, stdio: ['ignore', 'ignore', 'pipe'] as const }
  const bunChild = spawn(
    bunAspd,
    ['serve', '--socket', bun, '--log', join(ns, 'aspd.log')],
    options
  )
  await waitForSocket(bun, bunChild)
  const raspdChild = spawn(
    raspd,
    [
      'serve',
      '--socket',
      front,
      '--upstream',
      bun,
      '--log',
      raspdLog,
      '--release-root',
      releasePath as string,
    ],
    options
  )
  await waitForSocket(front, raspdChild)
  return { name, front, bun, raspdLog, children: [raspdChild, bunChild] }
}

async function stopPair(pair: Pair): Promise<void> {
  for (const child of pair.children) {
    child.kill('SIGTERM')
    await new Promise((done) => (child.exitCode !== null ? done(null) : child.once('exit', done)))
  }
}

// -- rpc --------------------------------------------------------------------------

/** hello, then one call, on a fresh connection (the HRC pattern): the raw reply lines. */
async function call(socket: string, client: string, method: string, params: unknown) {
  return await new Promise<string[]>((done, reject) => {
    const s = connect(socket)
    const timer = setTimeout(() => {
      s.destroy()
      reject(new Error(`timeout on ${socket}`))
    }, 60_000)
    let buffer = ''
    const lines: string[] = []
    s.on('error', reject)
    s.on('connect', () => {
      s.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, client, method: 'aspc.hello', params: HELLO_PARAMS })}\n`
      )
      s.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, client, method, params })}\n`)
    })
    // One decoder per stream: a multibyte character split across reads
    // must not decode as U+FFFD (e14d0fb9).
    const decoder = new TextDecoder()
    s.on('data', (chunk) => {
      buffer += decoder.decode(chunk, { stream: true })
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        lines.push(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
      if (lines.length >= 2) {
        clearTimeout(timer)
        s.end()
        done(lines)
      }
    })
  })
}

/** One persistent connection, `n` sequential calls: per-call milliseconds. */
async function timeCalls(socket: string, method: string, params: unknown, n: number) {
  return await new Promise<number[]>((done, reject) => {
    const s = connect(socket)
    const times: number[] = []
    let buffer = ''
    let sentAt = 0
    let id = 0
    const next = () => {
      id += 1
      sentAt = performance.now()
      s.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, client: 'r2e2e/latency', method, params })}\n`
      )
    }
    s.on('error', reject)
    s.on('connect', next)
    // One decoder per stream: a multibyte character split across reads
    // must not decode as U+FFFD (e14d0fb9).
    const decoder = new TextDecoder()
    s.on('data', (chunk) => {
      buffer += decoder.decode(chunk, { stream: true })
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        buffer = buffer.slice(index + 1)
        times.push(performance.now() - sentAt)
        if (times.length >= n) {
          s.end()
          done(times)
          return
        }
        next()
        index = buffer.indexOf('\n')
      }
    })
  })
}

const tokenize = (line: string) =>
  line.replace(
    /"evaluatedAt":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/g,
    '"evaluatedAt":"«wall-clock»"'
  )

type Outcome = {
  id: string
  method: string
  expect: 'native' | string
  match: boolean
  servedBy?: string
  fallback?: string
  replyBytes: number
  ok?: unknown
  code?: unknown
}

const paramsOf = new Map<string, unknown>()

async function runCases(pair: Pair, cases: Array<CallCase & { expect: string }>) {
  for (const entry of cases) paramsOf.set(entry.id, entry.params)
  const results: Outcome[] = []
  const replies: Record<string, { raspd: string; bun: string }> = {}
  for (const entry of cases) {
    const client = `r2e2e/${entry.id}`
    const [viaRaspd, direct] = await Promise.all([
      call(pair.front, client, entry.method, entry.params),
      call(pair.bun, `${client}#direct`, entry.method, entry.params),
    ])
    const second = (lines: string[]) =>
      lines.find((l) => l.startsWith('{"jsonrpc":"2.0","id":2,')) ?? ''
    const a = tokenize(second(viaRaspd))
    const b = tokenize(second(direct))
    replies[entry.id] = { raspd: a, bun: b }
    const parsed = JSON.parse(a) as { result?: Record<string, unknown>; error?: unknown }
    const result = parsed.result
    results.push({
      id: entry.id,
      method: entry.method,
      expect: entry.expect,
      match: a === b,
      replyBytes: a.length,
      ok: result?.['ok'],
      code:
        (result?.['failure'] as { code?: unknown } | undefined)?.code ??
        (result?.['resolution'] as { code?: unknown } | undefined)?.code ??
        (result?.['artifact'] as { code?: unknown } | undefined)?.code ??
        (parsed.error ? 'jsonrpc-error' : undefined),
    })
  }
  await Bun.sleep(300)
  const served = new Map<string, { servedBy: string; fallback?: string }>()
  for (const line of readFileSync(pair.raspdLog, 'utf8').split('\n')) {
    if (!line.includes('"rpc.request"')) continue
    const row = JSON.parse(line) as Record<string, unknown>
    const data = (row['data'] ?? row) as Record<string, unknown>
    if (typeof data['op'] !== 'string' || !String(data['op']).startsWith('aspc.')) continue
    if (data['op'] === 'aspc.hello') continue
    served.set(String(data['client']), {
      servedBy: String(data['servedBy']),
      ...(data['fallback'] !== undefined ? { fallback: String(data['fallback']) } : {}),
    })
  }
  for (const r of results) {
    const s = served.get(`r2e2e/${r.id}`)
    r.servedBy = s?.servedBy
    if (s?.fallback !== undefined) r.fallback = s.fallback
  }
  return { results, replies }
}

const served = (r: Outcome) =>
  r.expect === 'native' ? r.servedBy === 'native' : r.servedBy === 'bun' && r.fallback === r.expect

// -- tree snapshots (read-only proof) -----------------------------------------------

function tree(root: string, out: Map<string, string> = new Map(), rel = ''): Map<string, string> {
  for (const name of readdirSync(join(root, rel)).sort()) {
    const path = join(rel, name)
    const stat = lstatSync(join(root, path))
    if (stat.isDirectory()) tree(root, out, path)
    else out.set(path, `${stat.size}:${stat.mtimeMs}`)
  }
  return out
}
const treeDiff = (a: Map<string, string>, b: Map<string, string>) =>
  [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k))

// -- 1. the compare runner's R2 cases plus native refusals, on a scratch stage ------

const asp = await loadAsp()
const stageBase = join(scratch, 'st')
const stage: Stage = seedStage(asp, stageBase)
const R2 = new Set(['aspc.resolveRuntimeDeclaration', 'aspc.observeContinuationArtifact'])
const RESOLVE = 'aspc-resolve-runtime-declaration-request/v1'
const OBSERVE = 'aspc-observe-continuation-artifact-request/v1'

// Refusals raspd answers itself: spaces-config's own messages, not a parser's.
const write = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}
write(join(stage.agentsRoot, 'pm-v3', 'agent-profile.toml'), 'version = 3\n')
write(
  join(stage.agentsRoot, 'pm-badharness', 'agent-profile.toml'),
  'version = 4\n[provisioning]\nharness = "gpt"\n'
)
write(
  join(stage.agentsRoot, 'pm-priming-missing', 'agent-profile.toml'),
  'version = 4\npriming_file = "PRIMING.md"\n'
)
write(
  join(stage.agentsRoot, 'pm-priming-dir', 'agent-profile.toml'),
  'version = 4\npriming_file = "primer"\n'
)
mkdirSync(join(stage.agentsRoot, 'pm-priming-dir', 'primer'), { recursive: true })
write(
  join(stage.agentsRoot, 'pm-rich', 'agent-profile.toml'),
  [
    'version = 4',
    'operator = true',
    'claims_task = true',
    'priming_file = "PRIMING.md"',
    '[identity]',
    'display = "Rich"',
    'role = "builder"',
    'avatar = "https://cdn.example.com/rich.png"',
    '[provisioning]',
    'harness = "codex"',
    'model = "gpt-5"',
    'node = "svc"',
    'yolo = true',
    '[provisioning.codex]',
    'model_reasoning_summary = "auto"',
    '[placement]',
    'launch = "participant-only"',
    '[placement.pins]',
    '"project:T-1" = "svc"',
    '[placement.homes]',
    'minisvc = "svc"',
    '"7" = "max3"',
    '',
  ].join('\n')
)
write(join(stage.agentsRoot, 'pm-rich', 'PRIMING.md'), 'Rich priming ✓ “quotes” \u0001\n')
// Deliberately unsupported: a valid profile carrying a TOML datetime (a JS Date in Bun).
write(
  join(stage.agentsRoot, 'pm-datetime', 'agent-profile.toml'),
  'version = 4\n[session.metadata]\nsince = 1979-05-27T07:32:00Z\n'
)
const targetsRoot = join(stageBase, 'project-semantic')
write(
  join(targetsRoot, 'asp-targets.toml'),
  'schema = 2\n[targets.pathmark]\ncompose = ["space:pm-dev@dev"]\n[targets.pathmark.provisioning]\nharness = "gpt"\n'
)
const richTargets = join(stageBase, 'project-rich')
write(
  join(richTargets, 'asp-targets.toml'),
  [
    'schema = 2',
    `agents-root = "${stage.agentsRoot}"`,
    '[targets.pm-rich]',
    'description = "rich target ✓"',
    'compose = ["space:pm-dev@dev", "space:path:../x@dev"]',
    '[targets.pm-rich.provisioning]',
    'model = "gpt-5.5"',
    'reasoning_effort = "high"',
    'presentation = false',
    '[targets.pm-rich.session.metadata]',
    'n = 1.5',
    'big = 12345678901234',
    '',
  ].join('\n')
)
const schemaInvalid = join(stageBase, 'project-schema')
write(join(schemaInvalid, 'asp-targets.toml'), 'schema = 2\nbogus = 1\n')

const resolveCase = (id: string, context: Record<string, unknown>, expect = 'native') => ({
  kind: 'call' as const,
  id,
  method: 'aspc.resolveRuntimeDeclaration',
  params: { schemaVersion: RESOLVE, context },
  expect,
})
const observeCase = (id: string, params: Record<string, unknown>, expect = 'native') => ({
  kind: 'call' as const,
  id,
  method: 'aspc.observeContinuationArtifact',
  params: { schemaVersion: OBSERVE, ...params },
  expect,
})
const base = (agentId: string, extra: Record<string, unknown> = {}) => ({
  agentId,
  cwd: stage.projectRoot,
  runMode: 'task',
  project: { mode: 'none' },
  ...extra,
})
const rootOf = (projectRoot: string, projectId?: string) => ({
  mode: 'root',
  projectRoot,
  ...(projectId !== undefined ? { projectId } : {}),
})

// The runner's own R2 cases: its two TOML-syntax refusals are not raspd's to word.
const runnerCases = buildCases(asp as never, stage)
  .filter((c): c is CallCase => c.kind === 'call' && R2.has(c.method))
  .map((c) => ({
    ...c,
    expect:
      c.id.endsWith('_invalid') && !c.id.includes('agent_not_found')
        ? c.id.includes('project_targets')
          ? 'targets_toml_syntax'
          : 'profile_toml_syntax'
        : 'native',
  }))

const extraCases = [
  resolveCase('native:agent_profile_invalid:version', base('pm-v3')),
  resolveCase('native:agent_profile_invalid:harness', base('pm-badharness')),
  resolveCase('native:source_read_unavailable:priming', base('pm-priming-missing')),
  resolveCase('native:priming_invalid:directory', base('pm-priming-dir')),
  resolveCase(
    'native:project_targets_invalid:semantic',
    base('pathmark', { project: rootOf(targetsRoot, 'semantic') })
  ),
  resolveCase(
    'native:project_targets_invalid:semantic-supplied-root',
    base('pathmark', {
      agentRoot: join(stage.agentsRoot, 'pathmark'),
      project: rootOf(targetsRoot, ''),
    })
  ),
  resolveCase(
    'native:rich:target+directives',
    base('pm-rich', {
      project: rootOf(richTargets, 'rich'),
      provisionDirectives: { model: 'o5', remote: true, harness: 'claude' },
      taskId: 'T-11838',
    })
  ),
  resolveCase(
    'native:rich:infer-from-cwd',
    base('pm-rich', { cwd: richTargets, project: { mode: 'infer-from-cwd' } })
  ),
  resolveCase(
    'native:unsupported_directive',
    base('pathmark', { provisionDirectives: { colour: 'blue' } })
  ),
  resolveCase(
    'native:unsupported_harness:directive',
    base('pathmark', { provisionDirectives: { harness: 'gpt' } })
  ),
  resolveCase(
    'native:configured_context_mismatch:agent-root',
    base('pathmark', { agentRoot: join(stageBase, 'nowhere') })
  ),
  resolveCase(
    'native:configured_context_mismatch:not-dir',
    base('pathmark', {
      project: rootOf(join(stage.projectRoot, '..', 'project-rich', 'asp-targets.toml')),
    })
  ),
  resolveCase(
    'native:configured_context_mismatch:empty-sources',
    base('pathmark', { agentSources: {} })
  ),
  resolveCase(
    'native:caller-asp-home-config',
    base('pathmark', { agentSources: { aspHome: stage.aspHome } })
  ),
  resolveCase('native:unsupported_schema:fallback', base('pathmark')),
  resolveCase('fallback:invalid_params', { agentId: 7 }, 'invalid_params'),
  resolveCase(
    'fallback:targets_schema',
    base('pathmark', { project: rootOf(schemaInvalid) }),
    'targets_schema_invalid'
  ),
  resolveCase('fallback:datetime', base('pm-datetime'), 'toml_datetime'),
  observeCase('native:observe:unsupported_provider', {
    continuation: { provider: 'gemini', key: 'k' },
  }),
  observeCase('native:observe:pi', { continuation: { provider: 'pi', key: '/nope/pi.jsonl' } }),
  observeCase('native:observe:openai-ambiguous', {
    continuation: { provider: 'openai', key: 'k' },
  }),
  observeCase('native:observe:disagree', {
    continuation: { provider: 'claude', key: 'k', artifactFormat: 'codex' },
  }),
  observeCase('native:observe:frozen-codex-outside', {
    continuation: { provider: 'codex', key: 'k' },
    historicalExecution: {
      frozenStartRequest: {
        keyBinding: 'runtime-continuation',
        placement: {},
        startRequest: { spec: { process: { lockedEnv: { CODEX_HOME: '/elsewhere' } } } },
      },
    },
  }),
  observeCase('native:observe:frozen-codex-home', {
    continuation: { provider: 'codex', key: 'cmp-codex-thread-present' },
    historicalExecution: {
      frozenStartRequest: {
        keyBinding: 'runtime-continuation',
        placement: {},
        brokerDriver: 'codex-app-server',
        startRequest: { spec: { process: { lockedEnv: { CODEX_HOME: stage.codexHomeDev } } } },
      },
    },
  }),
  observeCase('native:observe:unsupported_schema', { continuation: {} }),
  observeCase(
    'fallback:observe:invalid_params',
    { continuation: { provider: 1 } },
    'invalid_params'
  ),
]
// The fallback case keeps a valid shape but names another schema version.
;(
  extraCases.find((c) => c.id === 'native:unsupported_schema:fallback')?.params as Record<
    string,
    unknown
  >
).schemaVersion = 'aspc-resolve-runtime-declaration-request/v0'
;(
  extraCases.find((c) => c.id === 'native:observe:unsupported_schema')?.params as Record<
    string,
    unknown
  >
).schemaVersion = 'aspc-observe-continuation-artifact-request/v0'

const stageEnv = {
  HOME: REAL_HOME,
  PATH: process.env['PATH'] as string,
  USER: process.env['USER'] ?? 'unknown',
  LANG: 'en_US.UTF-8',
  TMPDIR: process.env['TMPDIR'] ?? '/tmp',
  ASP_HOME: stage.aspHome,
  ASP_AGENTS_ROOT: stage.agentsRoot,
  ASP_USAGE_METRICS_VAR_ROOT: join(scratch, 'metrics'),
}
const before = tree(stageBase)
const stagePair = await startPair('stage', stageEnv)
const stageRun = await runCases(stagePair, [...runnerCases, ...extraCases])
const after = tree(stageBase)
record('stage-cases.json', stageRun.results)
record('stage-replies.json', stageRun.replies)
const mismatched = stageRun.results.filter((r) => !r.match).map((r) => r.id)
check(
  `stage: every R2 reply line is byte-identical to Bun direct (${stageRun.results.length} cases)`,
  mismatched.length === 0,
  { mismatched }
)
const misServed = stageRun.results
  .filter((r) => !served(r))
  .map((r) => ({ id: r.id, expect: r.expect, servedBy: r.servedBy, fallback: r.fallback }))
check(
  'stage: native-eligible cases served natively, the rest relayed with their fallback reason',
  misServed.length === 0,
  {
    misServed,
    native: stageRun.results.filter((r) => r.servedBy === 'native').length,
    relayed: stageRun.results.filter((r) => r.servedBy === 'bun').length,
  }
)
check('stage: no file under the stage changed (read-only)', treeDiff(before, after).length === 0, {
  changed: treeDiff(before, after),
})

// -- 2. unchanged HRC clients: Bun hrc and rusthrc through raspd ----------------------

const HRC_RUNTIME = resolve(repo, '..', 'hrc-runtime')
const RUSTHRC =
  arg('--rusthrc') ?? join(repo, 'crates', 'target', 'hrc-runtime', 'debug', 'rusthrc')
let hrcRun: Record<string, unknown> | undefined
if (!process.argv.includes('--no-hrc')) {
  const root = join(scratch, 'hrc')
  for (const dir of ['run', 'state']) mkdirSync(join(root, dir), { recursive: true })
  const scope = 'agent:pathmark-dev:project:project:task:T-11838'
  const claudeScope = 'agent:pathmark:project:project:task:T-11838-claude'
  const env: Record<string, string> = {
    ...(Object.fromEntries(
      Object.entries(process.env).filter(
        ([k, v]) =>
          v !== undefined &&
          !/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CODEX_SANDBOX|HRC_SESSION_REF|HRC_RUNTIME_ID|HRC_RUN_ID|HRC_HOST_SESSION_ID|HRC_EVENT_FORWARD_URL|HRC_EVENT_INGEST_TCP_PORT|HRC_EVENT_FORWARD_SOURCE_REF|WRKQ_DB_PATH|WRKQ_DB_PATH_FILE|WRKQD_NODE_TOKENS|WRKQD_NODE_TOKENS_FILE|WRKQD_UNIX)$/.test(
            k
          )
      )
    ) as Record<string, string>),
    HRC_RUNTIME_DIR: join(root, 'run'),
    HRC_STATE_DIR: join(root, 'state'),
    HRC_PROJECT_SEARCH_ROOTS: stageBase,
    ASP_PROJECT_ROOT_OVERRIDE: stage.projectRoot,
    HRC_WRKQ_DB: join(root, 'wrkq.db'),
    WRKQ_DB: join(root, 'wrkq.db'),
    WRKQ_PRINCIPAL_REF: 'agent:clod',
    HRC_WRKQD_TOKEN_FILE: '',
    WRKQD_TOKEN_FILE: '',
    WRKQD_TOKEN: '',
    HRC_PEER_CONFIG_FILE: join(root, 'federation.json'),
    HRC_EVENT_INGEST_SOCKET: join(root, 'run', 'ingest.sock'),
    HRC_ACP_WEBHOOK_URL: '',
    HRC_ASPD_SOCKET: stagePair.front,
    ASP_HOME: stage.aspHome,
    ASP_AGENTS_ROOT: stage.agentsRoot,
  }
  writeFileSync(
    env.HRC_PEER_CONFIG_FILE as string,
    JSON.stringify({ nodeId: 'r2-t11838', peers: {} }),
    {
      mode: 0o600,
    }
  )
  // Bun hrc inspects the project's worktrees (runtime_reads.py does the same).
  must(['git', 'init', '-q'], { cwd: stage.projectRoot, env })
  must(['wrkqadm', 'migrate'], { cwd: stage.projectRoot, env })
  must(['wrkq', 'mkdir', '/project', '--kind', 'project', '--json'], {
    cwd: stage.projectRoot,
    env,
  })
  must(['wrkq', 'set', '/project', '--root', stage.projectRoot, '--json'], {
    cwd: stage.projectRoot,
    env,
  })
  // Archived sessions with retained continuations: the target view observes them.
  const placementOf = (agent: string) => ({
    agentRoot: join(stage.agentsRoot, agent),
    projectRoot: stage.projectRoot,
    cwd: stage.projectRoot,
    runMode: 'task',
    bundle: { kind: 'agent-project', agentName: agent, projectRoot: stage.projectRoot },
  })
  const { openHrcDatabase } = (await import(
    join(HRC_RUNTIME, 'packages', 'hrc-store-sqlite', 'src', 'database.ts')
  )) as {
    openHrcDatabase: (path: string) => {
      sessions: { insert(r: unknown): void }
      continuities: { upsert(r: unknown): void }
      close(): void
    }
  }
  const db = openHrcDatabase(join(root, 'state', 'state.sqlite'))
  const at = '2026-10-26T00:00:00.000Z'
  db.sessions.insert({
    hostSessionId: 'hsid-r2-codex',
    scopeRef: scope,
    laneRef: 'main',
    generation: 1,
    status: 'archived',
    createdAt: at,
    updatedAt: at,
    lastAppliedIntentJson: { placement: placementOf('pathmark-dev') },
    continuation: { provider: 'codex', key: 'cmp-codex-thread-present' },
  })
  db.sessions.insert({
    hostSessionId: 'hsid-r2-claude',
    scopeRef: claudeScope,
    laneRef: 'main',
    generation: 1,
    status: 'archived',
    createdAt: at,
    updatedAt: at,
    lastAppliedIntentJson: { placement: placementOf('pathmark') },
    continuation: { provider: 'anthropic', key: 'cmp-claude-session-present' },
  })
  for (const [scopeRef, host] of [
    [scope, 'hsid-r2-codex'],
    [claudeScope, 'hsid-r2-claude'],
  ]) {
    db.continuities.upsert({ scopeRef, laneRef: 'main', activeHostSessionId: host, updatedAt: at })
  }
  db.close()

  const hrcSocket = join(root, 'run', 'hrc.sock')
  const http = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://hrc${path}`, {
      unix: hrcSocket,
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    } as RequestInit)
    const text = await response.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {}
    return { status: response.status, body: parsed }
  }
  const requests: Array<[string, string, string, unknown]> = [
    [
      'declaration:intent',
      'POST',
      '/v1/declarations/resolve',
      {
        agentId: 'pathmark',
        agentRoot: join(stage.agentsRoot, 'pathmark'),
        cwd: stage.projectRoot,
        projectRoot: stage.projectRoot,
        projectId: 'project',
      },
    ],
    [
      'placement:scope',
      'POST',
      '/v1/placements/resolve',
      { scopeRef: 'agent:pathmark:project:project:task:T-11838' },
    ],
    [
      'target:codex',
      'GET',
      `/v1/targets/by-session-ref?sessionRef=${encodeURIComponent(`${scope}/lane:main`)}`,
      undefined,
    ],
    [
      'target:claude',
      'GET',
      `/v1/targets/by-session-ref?sessionRef=${encodeURIComponent(`${claudeScope}/lane:main`)}`,
      undefined,
    ],
  ]
  const owners: Record<string, unknown> = {}
  for (const [kind, argv] of [
    ['bun', ['bun', join(HRC_RUNTIME, 'packages', 'hrc-cli', 'src', 'cli.ts'), 'server', 'serve']],
    ['rusthrc', [RUSTHRC, 'server']],
  ] as const) {
    const logStart = readFileSync(stagePair.raspdLog, 'utf8').length
    const child = spawn(argv[0], argv.slice(1), {
      cwd: stage.projectRoot,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (c) => {
      stderr += c.toString()
    })
    let ready = false
    for (let i = 0; i < 300 && !ready; i++) {
      if (child.exitCode !== null) break
      try {
        ready = (await http('GET', '/v1/status')).status === 200
      } catch {}
      if (!ready) await Bun.sleep(100)
    }
    const calls: Record<string, unknown> = {}
    if (ready)
      for (const [name, method, path, body] of requests)
        calls[name] = await http(method, path, body)
    child.kill('SIGTERM')
    await new Promise((done) => (child.exitCode !== null ? done(null) : child.once('exit', done)))
    await Bun.sleep(200)
    const lines = readFileSync(stagePair.raspdLog, 'utf8')
      .slice(logStart)
      .split('\n')
      .filter((l) => l.includes('"rpc.request"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .map((row) => (row['data'] ?? row) as Record<string, unknown>)
      .filter((d) => R2.has(String(d['op'])))
    owners[kind] = {
      ready,
      stderrTail: stderr.slice(-1500),
      calls,
      raspd: lines.map((d) => ({
        op: d['op'],
        client: d['client'],
        servedBy: d['servedBy'],
        outcome: d['outcome'],
      })),
    }
  }
  hrcRun = {
    rusthrc: RUSTHRC,
    hrcRuntimeHead: must(['git', '-C', HRC_RUNTIME, 'rev-parse', 'HEAD']).trim(),
    owners,
  }
  record('hrc-clients.json', hrcRun)
  for (const kind of ['bun', 'rusthrc']) {
    const o = owners[kind] as {
      ready: boolean
      calls: Record<string, { status: number; body: unknown }>
      raspd: Array<{ op: string; servedBy: string; outcome: string }>
    }
    const natively = (op: string) =>
      o.raspd.filter((r) => r.op === op && r.servedBy === 'native').length
    const intent = o.calls['declaration:intent']
    const placement = o.calls['placement:scope']
    const codex = o.calls['target:codex']?.body
    check(
      `${kind} hrc: intent and placement declarations resolve, archived continuations observe, through raspd natively`,
      o.ready &&
        intent?.status === 200 &&
        placement?.status === 200 &&
        o.calls['target:codex']?.status === 200 &&
        o.calls['target:claude']?.status === 200 &&
        JSON.stringify(codex).includes('present') &&
        natively('aspc.resolveRuntimeDeclaration') >= 2 &&
        natively('aspc.observeContinuationArtifact') >= 1 &&
        o.raspd.every((r) => r.servedBy === 'native'),
      {
        statuses: Object.fromEntries(Object.entries(o.calls).map(([k, v]) => [k, v.status])),
        raspd: o.raspd,
      }
    )
  }
}

// -- 3. the node's real agents, projects and continuation artifacts ------------------

let corpusRun: Awaited<ReturnType<typeof runCases>> | undefined
let prodPair: Pair | undefined
if (!process.argv.includes('--no-corpus')) {
  const praesidium = join(REAL_HOME, 'praesidium')
  const service = JSON.parse(
    readFileSync(join(praesidium, 'var', 'aspd', 'service', 'config.json'), 'utf8')
  ) as { env: Record<string, string> }
  const prodEnv = { ...service.env, ASP_USAGE_METRICS_VAR_ROOT: join(scratch, 'metrics-prod') }
  const aspHome = prodEnv['ASP_HOME'] as string
  const agentsRoot = join(praesidium, 'var', 'agents')
  const agents = readdirSync(agentsRoot).filter((a) =>
    existsSync(join(agentsRoot, a, 'agent-profile.toml'))
  )
  const projects = readdirSync(praesidium)
    .map((p) => join(praesidium, p))
    .filter((p) => existsSync(join(p, 'asp-targets.toml')))
  const corpus: Array<CallCase & { expect: string }> = []
  for (const agent of agents) {
    corpus.push(
      resolveCase(`corpus:intent:${agent}`, {
        agentId: agent,
        agentRoot: join(agentsRoot, agent),
        cwd: praesidium,
        runMode: 'task',
        project: { mode: 'none' },
      })
    )
    for (const project of projects) {
      corpus.push(
        resolveCase(`corpus:placement:${agent}@${basename(project)}`, {
          agentId: agent,
          cwd: project,
          runMode: 'task',
          project: { mode: 'root', projectRoot: project, projectId: basename(project) },
          taskId: 'T-11838',
        })
      )
    }
  }
  for (const project of projects) {
    corpus.push(
      resolveCase(`corpus:infer:${basename(project)}`, {
        agentId: 'clod',
        cwd: join(project, 'docs'),
        runMode: 'query',
        project: { mode: 'infer-from-cwd' },
      })
    )
  }
  // Codex: the recorded-placement rule over the real codex homes.
  const codexHomes = join(aspHome, 'codex-homes')
  const named = existsSync(codexHomes)
    ? readdirSync(codexHomes).filter(
        (h) => h.includes('_') && existsSync(join(codexHomes, h, 'sessions'))
      )
    : []
  for (const home of named.slice(0, 25)) {
    const [project, agent] = home.split('_') as [string, string]
    const recorded = {
      placement: { agentRoot: join(agentsRoot, agent), projectRoot: join(praesidium, project) },
      bundle: { kind: 'agent-project', agentName: agent },
    }
    const rollouts: string[] = []
    const walk = (dir: string, depth: number) => {
      if (depth > 4 || rollouts.length >= 2) return
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (name.startsWith('rollout-') && name.endsWith('.jsonl')) rollouts.push(name)
        else if (lstatSync(path).isDirectory()) walk(path, depth + 1)
      }
    }
    walk(join(codexHomes, home, 'sessions'), 0)
    for (const rollout of rollouts) {
      const key = rollout.slice(-'.jsonl'.length - 36, -'.jsonl'.length)
      corpus.push(
        observeCase(`corpus:codex:${home}:${key}`, {
          continuation: { provider: 'codex', key },
          historicalExecution: { recordedPlacement: recorded },
        })
      )
    }
    corpus.push(
      observeCase(`corpus:codex:${home}:absent`, {
        continuation: { provider: 'codex', key: '00000000-0000-0000-0000-000000000000' },
        historicalExecution: { recordedPlacement: recorded },
      })
    )
  }
  // Claude: frozen CLAUDE_CONFIG_DIR and placement cwd over the real projects dir.
  const claudeHome = join(REAL_HOME, '.claude')
  for (const project of projects) {
    const encoded = project.replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(claudeHome, 'projects', encoded)
    const sessions = existsSync(dir)
      ? readdirSync(dir)
          .filter((n) => n.endsWith('.jsonl'))
          .slice(0, 2)
      : []
    for (const key of [...sessions.map((n) => n.slice(0, -'.jsonl'.length)), 'absent-session']) {
      const frozen = {
        keyBinding: 'runtime-continuation',
        placement: { cwd: project },
        startRequest: {
          spec: {
            driver: { kind: 'claude-code-tmux' },
            process: { lockedEnv: { CLAUDE_CONFIG_DIR: claudeHome } },
          },
        },
      }
      corpus.push(
        observeCase(`corpus:claude:${basename(project)}:${key}`, {
          continuation: { provider: 'anthropic', key },
          historicalExecution: { frozenStartRequest: frozen },
        })
      )
    }
    corpus.push(
      observeCase(`corpus:claude:${basename(project)}:no-frozen`, {
        continuation: { provider: 'anthropic', key: 'k' },
      })
    )
  }
  prodPair = await startPair('prod', prodEnv)
  corpusRun = await runCases(prodPair, corpus)
  record('corpus-cases.json', corpusRun.results)
  const corpusMismatch = corpusRun.results.filter((r) => !r.match)
  record(
    'corpus-mismatches.json',
    corpusMismatch.map((r) => ({ ...r, ...corpusRun?.replies[r.id] }))
  )
  const fallbacks: Record<string, number> = {}
  for (const r of corpusRun.results) {
    if (r.servedBy === 'bun')
      fallbacks[r.fallback ?? 'none'] = (fallbacks[r.fallback ?? 'none'] ?? 0) + 1
  }
  const codes: Record<string, number> = {}
  for (const r of corpusRun.results)
    codes[`${r.method.slice(5)}:${String(r.code ?? 'ok')}`] =
      (codes[`${r.method.slice(5)}:${String(r.code ?? 'ok')}`] ?? 0) + 1
  check(
    `corpus: every real-node reply byte-identical to Bun direct (${corpusRun.results.length} requests, ${agents.length} agents x ${projects.length} projects + continuations)`,
    corpusMismatch.length === 0,
    { mismatched: corpusMismatch.map((r) => r.id).slice(0, 50), codes, fallbacks }
  )
  check(
    'corpus: every real-node request is served natively (no fallback on live shapes)',
    corpusRun.results.every((r) => r.servedBy === 'native'),
    { fallbacks }
  )
}

// -- 4. latency, native vs Bun direct ---------------------------------------------------

const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return (
    Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 1000) /
    1000
  )
}
const latency: Record<string, unknown> = {}
const latencyPair = prodPair ?? stagePair
const latencyCases = [
  ...(prodPair
    ? (corpusRun?.results ?? [])
        .filter((r) => r.servedBy === 'native')
        .filter(
          (r) =>
            r.id.startsWith('corpus:placement:clod@agent-spaces') ||
            r.id.startsWith('corpus:intent:clod') ||
            (r.id.startsWith('corpus:codex:') && r.code === 'artifact_present') ||
            r.id.includes(':claude:agent-spaces:')
        )
        .slice(0, 4)
    : stageRun.results.filter(
        (r) =>
          r.id === 'resolve:placement:project-root-task' ||
          r.id === 'observe:codex:present:recorded'
      )),
]
for (const r of latencyCases) {
  const params = paramsOf.get(r.id)
  const native = await timeCalls(latencyPair.front, r.method, params, iterations)
  const bun = await timeCalls(latencyPair.bun, r.method, params, iterations)
  latency[r.id] = {
    method: r.method,
    iterations,
    native: { p50: pct(native, 50), p99: pct(native, 99) },
    bun: { p50: pct(bun, 50), p99: pct(bun, 99) },
  }
}
record('latency.json', latency)
console.log(JSON.stringify(latency, null, 2))

for (const pair of [stagePair, prodPair]) if (pair) await stopPair(pair)

const failed = checks.filter((c) => !c.ok)
record('report.json', {
  task: 'T-11838',
  releaseId: release.releaseId,
  sourceCommit: release.sourceCommit,
  raspd,
  checks,
  latency,
  passed: failed.length === 0,
})
console.log(
  `${failed.length === 0 ? 'PASS' : 'FAIL'} ${checks.length - failed.length}/${checks.length} -> ${out}`
)
if (failed.length === 0) rmSync(scratch, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
