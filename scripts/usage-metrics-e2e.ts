#!/usr/bin/env bun
/**
 * Scratch E2E for ASP usage metrics (T-11824).
 *
 * Builds real releases from clean clones of a baseline commit (before metrics)
 * and the change commit, serves them from one scratch aspd namespace
 * (`<scratch>/var/aspd`, so aspd derives the scratch var root itself), drives
 * the same raw RPC script against each, runs the asp CLI from the change clone,
 * then repeats the change run with an unwritable metrics dir.
 *
 * Proves: replies are byte-identical across baseline / metered / broken
 * metrics (release identity normalized); request, connection and invocation
 * rows are exact; CLI exit codes and output are unaffected by a write failure;
 * aspd's metrics warning is an L2 line in aspd.log. Writes the day files and a
 * summary under --out.
 *
 * Usage: bun scripts/usage-metrics-e2e.ts --out <dir> [--commit <sha>] [--baseline <sha>]
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '..')

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function run(command: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(command[0] as string, command.slice(1), {
    cwd: options.cwd ?? repo,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: 300_000,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function must(command: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = run(command, options)
  if (result.status !== 0) {
    throw new Error(
      `${command.join(' ')} exited ${result.status}\n${result.stderr}${result.stdout}`
    )
  }
  return result.stdout
}

const out = resolve(arg('--out') ?? join(repo, '..', 'var', 'wrkq-artifacts', 'T-11824', 'e2e'))
const commit = must(['git', 'rev-parse', arg('--commit') ?? 'HEAD']).trim()
const baseline = must(['git', 'rev-parse', arg('--baseline') ?? 'dc36ba6f']).trim()
// Unix socket paths are limited to 104 bytes on macOS; keep the scratch root short.
const scratch = mkdtempSync('/tmp/aspum-')
const varRoot = join(scratch, 'var')
const ns = join(varRoot, 'aspd')
const metricsDir = join(varRoot, 'state', 'agent-spaces', 'metrics')
const logDir = join(varRoot, 'logs', 'agent-spaces')
mkdirSync(out, { recursive: true })

function buildRelease(sha: string): { releaseId: string; releasePath: string; src: string } {
  const src = join(scratch, `src-${sha.slice(0, 8)}`)
  must(['git', 'clone', '-q', repo, src])
  must(['git', 'checkout', '-q', sha], { cwd: src })
  must(['bun', 'install', '--frozen-lockfile'], { cwd: src })
  const report = JSON.parse(
    must(['bun', 'scripts/asp-release.ts', 'build', '--output-root', join(scratch, 'builds')], {
      cwd: src,
    })
  ) as { releaseId: string; releasePath: string }
  must(
    [
      'bun',
      'scripts/asp-release.ts',
      'install',
      '--artifact',
      report.releasePath,
      '--release-root',
      join(ns, 'releases'),
    ],
    {
      cwd: src,
    }
  )
  return { ...report, src }
}

// -- RPC script -----------------------------------------------------------------

type Frame = Record<string, unknown> | { raw: string }
const HELLO = {
  method: 'aspc.hello',
  params: { clientInfo: { name: 'usage-e2e', version: '1' }, protocolVersions: ['aspc/0.1'] },
  client: 'usage-e2e/1',
}
const CONNECTIONS: Frame[][] = [
  // A long-lived connection: several requests on one socket.
  [
    HELLO,
    { method: 'health', params: {}, client: 'usage-e2e/1' },
    { method: 'surface', params: {}, client: 'usage-e2e/1' },
  ],
  // The hello-per-call pattern: one request per connection.
  [HELLO],
  [HELLO],
  [HELLO],
  [{ method: 'version', params: {}, client: 'usage-e2e/1' }],
  [{ method: 'aspc.retiredOperation', params: {}, client: 'usage-e2e/1' }],
  [{ method: 'aspc.resolveRuntimeDeclaration', params: { bogus: true }, client: 'usage-e2e/1' }],
  [{ method: 'health', params: { typo: true } }],
  [{ raw: '{not-json' }],
]
const EXPECTED_REQUESTS = CONNECTIONS.flat().length

async function drive(socketPath: string): Promise<string[][]> {
  const replies: string[][] = []
  for (const frames of CONNECTIONS) {
    replies.push(
      await new Promise<string[]>((resolveFrames, reject) => {
        const socket = connect(socketPath)
        const timer = setTimeout(() => reject(new Error('rpc timeout')), 30_000)
        const got: string[] = []
        let buffer = ''
        socket.on('error', reject)
        socket.on('connect', () => {
          frames.forEach((frame, index) =>
            socket.write(
              'raw' in frame
                ? `${frame.raw}\n`
                : `${JSON.stringify({ jsonrpc: '2.0', id: index + 1, ...frame })}\n`
            )
          )
        })
        socket.on('data', (chunk) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          got.push(...lines)
          if (got.length >= frames.length) {
            clearTimeout(timer)
            socket.end()
            socket.once('close', () => resolveFrames(got))
          }
        })
      })
    )
  }
  return replies
}

// -- CLI script -----------------------------------------------------------------

const CLI_RUNS: { args: string[]; deterministic: boolean }[] = [
  { args: ['--help'], deterministic: true },
  { args: ['agent', '--help'], deterministic: true },
  { args: ['harnesses', '--json'], deterministic: true },
  { args: ['lint', '--bogus'], deterministic: true },
  // A real in-process compile; its output names fresh materialization paths.
  {
    args: ['agent', 'clod@agent-spaces:T-11824', 'query', 'usage e2e prompt', '--dry-run'],
    deterministic: false,
  },
]

function runCli(src: string) {
  return CLI_RUNS.map(({ args }) => {
    const result = run(['bun', join(src, 'apps', 'cli', 'bin', 'asp.js'), ...args], {
      env: { ...process.env, ASP_USAGE_METRICS_VAR_ROOT: varRoot },
    })
    return { args, ...result }
  })
}

// -- phases ---------------------------------------------------------------------

const service = (verb: string, src: string, extra?: string) =>
  JSON.parse(
    must(['bun', 'scripts/aspd-service.ts', verb, ns, ...(extra ? [extra] : [])], { cwd: src })
  )

function dayRows(component: string): Record<string, unknown>[] {
  if (!existsSync(metricsDir)) return []
  return readdirSync(metricsDir)
    .filter((name) => name.startsWith(`${component}-`) && name.endsWith('.ndjson'))
    .flatMap((name) =>
      readFileSync(join(metricsDir, name), 'utf8').trim().split('\n').filter(Boolean)
    )
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const checks: { name: string; ok: boolean; detail?: unknown }[] = []
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
}

const base = buildRelease(baseline)
const change = buildRelease(commit)
const codex = must(['bash', '-lc', 'command -v codex']).trim()
service('init', change.src, codex)
service('log-dir', change.src, logDir)
const socketPath = join(ns, 'run', 'aspd.sock')
// Replies keep their exact bytes; only release identity and build time are
// masked, and pipelined replies on one connection (answered in completion
// order) are put in request-id order.
const normalize = (replies: string[][], release: { releaseId: string }, sha: string) =>
  JSON.stringify(
    replies.map((frames) =>
      [...frames].sort((a, b) => Number(JSON.parse(a).id ?? 0) - Number(JSON.parse(b).id ?? 0))
    )
  )
    .replaceAll(release.releaseId, '<release>')
    .replaceAll(sha, '<commit>')
    .replace(/\\"builtAt\\":\\"[^\\]+\\"/g, '\\"builtAt\\":\\"<builtAt>\\"')

// Phase A: baseline release, before metrics existed.
service('activate', change.src, base.releaseId)
const baselineReplies = await drive(socketPath)
service('stop', change.src)
check('baseline release wrote no metrics', dayRows('aspd').length === 0)

// Phase B: metered release + CLI.
service('activate', change.src, change.releaseId)
const meteredReplies = await drive(socketPath)
const cliMetered = runCli(change.src)
service('stop', change.src)
writeFileSync(join(out, 'replies-baseline.json'), `${normalize(baselineReplies, base, baseline)}\n`)
writeFileSync(join(out, 'replies-metered.json'), `${normalize(meteredReplies, change, commit)}\n`)
check(
  'replies byte-identical to the pre-metrics release',
  normalize(meteredReplies, change, commit) === normalize(baselineReplies, base, baseline)
)

const aspdRows = dayRows('aspd')
const requestRows = aspdRows.filter((row) => row['kind'] === 'request')
const connectionRows = aspdRows.filter((row) => row['kind'] === 'connection')
const sum = (rows: Record<string, unknown>[], field: string) =>
  rows.reduce((total, row) => total + (row[field] as number), 0)
// Unsupervised starts log each run to its own aspd-<release>-<ts>.log; phase B
// is the change release's first run. aspd-service's readback hello is a real
// request too, so exactness is checked against that run's L3 lines.
const runLogs = () =>
  readdirSync(logDir)
    .filter((name) => name.startsWith('aspd-') && name.endsWith('.log'))
    .sort()
const runLines = (name: string) => readFileSync(join(logDir, name), 'utf8').trim().split('\n')
const l3 = (lines: string[]) =>
  lines.filter((line) => line.includes('"event":"rpc.request"')).map((line) => JSON.parse(line))
const phaseBLog = runLogs().filter((name) => name.includes(change.releaseId))[0] as string
const phaseBRequests = l3(runLines(phaseBLog))
check(
  'request rows equal the L3 request lines exactly',
  sum(requestRows, 'count') === phaseBRequests.length,
  { counted: sum(requestRows, 'count'), l3Lines: phaseBRequests.length }
)
const driven = requestRows.filter(
  (row) => row['client'] === 'usage-e2e/1' || row['client'] === 'unknown'
)
check('every driven request counted', sum(driven, 'count') === EXPECTED_REQUESTS, {
  counted: sum(driven, 'count'),
  expected: EXPECTED_REQUESTS,
})
check(
  'unknown op counted with -32601',
  requestRows.some((row) => row['op'] === 'aspc.retiredOperation' && row['outcome'] === '-32601')
)
check(
  'hello counted 4x for usage-e2e/1',
  sum(
    requestRows.filter((row) => row['op'] === 'aspc.hello' && row['client'] === 'usage-e2e/1'),
    'count'
  ) === 4
)
const connectionsOf = (client: string) => connectionRows.filter((row) => row['client'] === client)
check(
  'connection rows: 7 usage-e2e/1 connections carry 9 requests (max 3); 2 unknown carry 2',
  sum(connectionsOf('usage-e2e/1'), 'count') === 7 &&
    sum(connectionsOf('usage-e2e/1'), 'requestsSum') === 9 &&
    Math.max(...connectionsOf('usage-e2e/1').map((row) => row['requestsMax'] as number)) === 3 &&
    sum(connectionsOf('unknown'), 'count') === 2 &&
    sum(connectionsOf('unknown'), 'requestsSum') === 2,
  connectionRows
)
check(
  'requests per connection sum to the request total',
  sum(connectionRows, 'requestsSum') === sum(requestRows, 'count')
)
check(
  'aspd rows attribute product, host and the scratch var root',
  aspdRows.every((row) => row['product'] === `aspd/${change.releaseId}` && row['host'] === 'aspd')
)

const cliRows = dayRows('asp-cli')
check('one invocation row per CLI run', cliRows.length === CLI_RUNS.length, {
  rows: cliRows.length,
})
check(
  'invocation exit codes match what the caller saw',
  cliMetered.every((result, index) => cliRows[index]?.['exitCode'] === result.status)
)
check('help runs marked help:true', cliRows[0]?.['help'] === true && cliRows[1]?.['help'] === true)
check('dry-run compile recorded as in-process', cliRows[4]?.['compile'] === 'in-process')
const cliText = JSON.stringify(cliRows)
check(
  'no argument values in invocation rows',
  !['usage e2e prompt', 'clod@agent-spaces:T-11824', '--bogus', process.cwd()].some((value) =>
    cliText.includes(value)
  )
)
const rowText = JSON.stringify([...aspdRows, ...cliRows])
check(
  'no params, prompts or secrets in any row',
  !/params|prompt|token|secret/i.test(rowText.replaceAll('"--help"', ''))
)

for (const name of readdirSync(metricsDir)) copyFileSync(join(metricsDir, name), join(out, name))

// Phase C: the same drive with an unwritable metrics dir.
const before = readdirSync(metricsDir).map((name) => [
  name,
  readFileSync(join(metricsDir, name), 'utf8'),
])
for (const name of readdirSync(metricsDir)) chmodSync(join(metricsDir, name), 0o400)
chmodSync(metricsDir, 0o500)
service('start', change.src)
const brokenReplies = await drive(socketPath)
const cliBroken = runCli(change.src)
service('stop', change.src)
chmodSync(metricsDir, 0o755)
for (const name of readdirSync(metricsDir)) chmodSync(join(metricsDir, name), 0o644)
check(
  'unwritable metrics: replies byte-identical',
  normalize(brokenReplies, change, commit) === normalize(meteredReplies, change, commit)
)
check(
  'unwritable metrics: CLI exit codes unchanged',
  cliBroken.every((result, index) => result.status === cliMetered[index]?.status)
)
check(
  'unwritable metrics: deterministic CLI stdout/stderr unchanged',
  cliBroken.every(
    (result, index) =>
      !CLI_RUNS[index]?.deterministic ||
      (result.stdout === cliMetered[index]?.stdout && result.stderr === cliMetered[index]?.stderr)
  )
)
const after = readdirSync(metricsDir).map((name) => [
  name,
  readFileSync(join(metricsDir, name), 'utf8'),
])
check('unwritable metrics: no rows written', JSON.stringify(after) === JSON.stringify(before))
const aspdLog = runLogs().flatMap(runLines)
// Every line that mentions a metrics event must be one framed L2 warning.
const metricLines = aspdLog.filter((line) => line.includes('metrics.'))
const metricWarnings = metricLines.flatMap((line) => {
  try {
    return [JSON.parse(line)]
  } catch {
    return [{ unframed: line }]
  }
})
check(
  'aspd metrics warning is one L2 line in the aspd log',
  metricWarnings.length === 1 &&
    metricWarnings.every(
      (line) =>
        typeof line.ts === 'string' &&
        line.level === 'warn' &&
        line.component === 'metrics' &&
        line.event === 'metrics.write_failed' &&
        typeof line.data === 'object'
    ),
  metricWarnings
)
check(
  'L3 rpc.request lines keep listener/op/client',
  l3(aspdLog).every(
    (line) =>
      line.data.listener === 'aspd' &&
      typeof line.data.op === 'string' &&
      typeof line.data.client === 'string'
  )
)
for (const name of runLogs()) copyFileSync(join(logDir, name), join(out, name))
writeFileSync(
  join(out, 'aspd-metrics-warnings.ndjson'),
  `${metricWarnings.map((line) => JSON.stringify(line)).join('\n')}\n`
)

const summary = {
  commit,
  baseline,
  releases: { baseline: base.releaseId, change: change.releaseId },
  scratch,
  checks,
  cli: cliMetered.map(({ args, status }, index) => ({
    args: args.length,
    exitCode: status,
    brokenExitCode: cliBroken[index]?.status,
  })),
}
writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
const failed = checks.filter((entry) => !entry.ok)
for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}`)
console.log(`artifacts: ${out}`)
process.exit(failed.length === 0 ? 0 : 1)
