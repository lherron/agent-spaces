#!/usr/bin/env bun
/** Scratch launchd acceptance for T-13057. Requires --release and --out.
 * Run serially with other heavy checks. Owns only its random scratch labels.
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { versionOf } from './aspd-service/daemon-process.ts'

const repo = resolve(import.meta.dir, '..')
const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1]
if (!process.argv.includes('--release') || !process.argv.includes('--out')) {
  throw new Error('usage: raspd-sole-supervised-e2e.ts --release <artifact> --out <evidence>')
}
const release = resolve(arg('--release') as string)
const out = resolve(arg('--out') as string)
const parent = resolve(repo, '../var/scratch/agent-spaces/T-13057')
mkdirSync(parent, { recursive: true })
mkdirSync(out, { recursive: true })
const root = mkdtempSync(join(parent, 's-'))
const ns = join(root, 'ns')
const label = `com.praesidium.scratch.t13057.${basename(root)}`
const labels = [label, `${label}.raspd`]
const ownedLabels = new Set<string>()
const domain = `gui/${process.getuid?.()}`
const env: Record<string, string> = {}
for (const key of ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG']) {
  const value = process.env[key]
  if (value !== undefined) env[key] = value
}
env['ASP_USAGE_METRICS_VAR_ROOT'] = join(root, 'metrics')
const lines: string[] = []
const checks: { name: string; ok: boolean; detail: unknown }[] = []
const log = (s: string) => {
  lines.push(s)
  console.log(s)
}
function run(argv: string[]) {
  const r = spawnSync(argv[0] as string, argv.slice(1), {
    env,
    cwd: repo,
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
function must(argv: string[]) {
  log(`$ ${argv.join(' ')}`)
  const r = run(argv)
  log(`${r.stdout}${r.stderr}[exit ${r.status}]`)
  if (r.status !== 0) throw new Error(`failed: ${argv.join(' ')}`)
  return r.stdout
}
const service = (...args: string[]) =>
  JSON.parse(must(['bun', join(repo, 'scripts/aspd-service.ts'), ...args])) as Record<
    string,
    unknown
  >
function check(name: string, ok: boolean, detail: unknown = null) {
  checks.push({ name, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`)
  if (!ok) throw new Error(name)
}
const socket = join(ns, 'run/aspd.sock')
const bunSocket = join(ns, 'run/aspd-bun.sock')
const plist = (l: string) => join(homedir(), 'Library/LaunchAgents', `${l}.plist`)
const processes = () =>
  run(['ps', '-axo', 'pid=,command='])
    .stdout.split('\n')
    .filter((l) => l.includes(ns) && /\/(aspd|raspd)\s+serve\b/.test(l))
const snapshots: unknown[] = []
async function snapshot(step: string, sole: boolean) {
  const jobs = labels.map((l) => {
    const command = ['launchctl', 'print', `${domain}/${l}`]
    const result = run(command)
    log(`$ ${command.join(' ')}\n${result.stdout}${result.stderr}[exit ${result.status}]`)
    const pid = /\bpid = (\d+)/.exec(result.stdout)?.[1]
    return {
      label: l,
      ...result,
      pid: pid === undefined ? undefined : Number(pid),
      plist: existsSync(plist(l)),
    }
  })
  const version = await versionOf(socket)
  const bun = await versionOf(bunSocket)
  const cmds = processes()
  const script = readFileSync(join(ns, 'service/raspd-launchd-run.sh'), 'utf8')
  log(`$ ps (namespace daemons)\n${cmds.join('\n')}`)
  const value = { step, sole, jobs, version, bun, processes: cmds, script }
  snapshots.push(value)
  writeFileSync(join(out, 'launchd-readbacks.json'), `${JSON.stringify(snapshots, null, 2)}\n`)
  check(
    step,
    jobs[1]?.status === 0 &&
      jobs[1]?.pid !== undefined &&
      jobs[1]?.plist === true &&
      (version?.['frontDoor'] as { role?: string })?.role === (sole ? 'sole' : 'front') &&
      (version?.['release'] as { releaseId?: string })?.releaseId === basename(release) &&
      (sole
        ? jobs[0]?.status !== 0 &&
          jobs[0]?.plist === false &&
          bun === undefined &&
          !existsSync(bunSocket) &&
          cmds.length === 1 &&
          !script.includes('--upstream') &&
          !cmds[0]?.includes('--upstream')
        : jobs[0]?.status === 0 &&
          jobs[0]?.pid !== undefined &&
          jobs[0]?.plist === true &&
          bun !== undefined &&
          cmds.length === 2 &&
          script.includes('--upstream') &&
          cmds.some((c) => c.includes('--upstream'))),
    {
      jobs: jobs.map((j) => ({ label: j.label, status: j.status, pid: j.pid, plist: j.plist })),
      processes: cmds,
    }
  )
  return jobs[1]?.pid as number
}
let failure: unknown
try {
  log(`release ${release}; scratch ${root}; labels ${labels.join(', ')}`)
  for (const l of labels)
    check(
      `fresh label ${l}`,
      run(['launchctl', 'print', `${domain}/${l}`]).status !== 0 && !existsSync(plist(l))
    )
  for (const l of labels) ownedLabels.add(l)
  service('init', ns)
  const configPath = join(ns, 'service/config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.inheritEnv = []
  config.env = { ...env, ASP_HOME: join(root, 'asp-home') }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  must([
    'bun',
    join(repo, 'scripts/asp-release.ts'),
    'install',
    '--artifact',
    release,
    '--release-root',
    join(ns, 'releases'),
  ])
  service('activate', ns, basename(release))
  service('supervise', ns, label)
  const direct = run(['launchctl', 'print', `${domain}/${label}`])
  log(`$ launchctl print ${domain}/${label}\n${direct.stdout}${direct.stderr}`)
  check(
    'supervise direct: Bun job loaded and serving',
    direct.status === 0 && (await versionOf(socket)) !== undefined
  )
  service('front-door-enable', ns, labels[1] as string)
  await snapshot('fronted after supervise', false)
  // Reproduce the slice-4a repair: hand an already-fronted namespace to supervision.
  service('stop', ns)
  const c = JSON.parse(readFileSync(configPath, 'utf8'))
  c.supervisor = undefined
  writeFileSync(configPath, `${JSON.stringify(c, null, 2)}\n`)
  for (const l of labels) rmSync(plist(l), { force: true })
  service('start', ns)
  service('supervise', ns, label)
  await snapshot('fronted then supervise: both daemons serve', false)
  service('sole-enable', ns)
  const before = await snapshot('sole-enable: no Bun job/plist, no upstream', true)
  log(`$ kill -KILL ${before} (owned scratch raspd)`)
  process.kill(before, 'SIGKILL')
  let next = before
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    await Bun.sleep(250)
    const printed = run(['launchctl', 'print', `${domain}/${labels[1]}`])
    next = Number(/\bpid = (\d+)/.exec(printed.stdout)?.[1] ?? before)
    if (next !== before && (await versionOf(socket)) !== undefined) break
  }
  check('launchd respawns killed sole raspd with a new pid', next !== before, { before, next })
  await snapshot('respawn stays sole', true)
  service('activate', ns, basename(release))
  await snapshot('activate same release stays sole', true)
  service('restart', ns)
  await snapshot('restart stays sole', true)
  service('front-door-enable', ns)
  await snapshot('rollback: both jobs loaded, raspd has upstream', false)
} catch (error) {
  failure = String(error)
  log(`ERROR ${failure}`)
} finally {
  // Always unload only the random labels reserved by this invocation, even on failure.
  if (existsSync(join(ns, 'service/config.json'))) {
    const stopped = run(['bun', join(repo, 'scripts/aspd-service.ts'), 'stop', ns])
    log(`$ aspd-service stop ${ns}\n${stopped.stdout}${stopped.stderr}[exit ${stopped.status}]`)
  }
  for (const l of ownedLabels) {
    const boot = run(['launchctl', 'bootout', `${domain}/${l}`])
    log(`$ launchctl bootout ${domain}/${l}\n${boot.stdout}${boot.stderr}[exit ${boot.status}]`)
    rmSync(plist(l), { force: true })
  }
  const listed = run(['launchctl', 'list'])
  const jobs = listed.stdout.split('\n').filter((l) => labels.some((label) => l.includes(label)))
  const sockets = existsSync(join(ns, 'run'))
    ? readdirSync(join(ns, 'run')).filter((n) => n.endsWith('.sock'))
    : []
  const remaining = processes()
  log(`$ launchctl list (scratch labels)\n${jobs.join('\n')}\ncount=${jobs.length}`)
  const clean =
    listed.status === 0 &&
    jobs.length === 0 &&
    labels.every((l) => !existsSync(plist(l))) &&
    sockets.length === 0 &&
    remaining.length === 0
  checks.push({
    name: 'cleanup: zero jobs, plists, processes and sockets',
    ok: clean,
    detail: { jobs, sockets, processes: remaining },
  })
  log(`${clean ? 'PASS' : 'FAIL'} cleanup: ${JSON.stringify(checks.at(-1))}`)
  writeFileSync(
    join(out, 'summary.json'),
    `${JSON.stringify({ releaseId: basename(release), root, labels, failure, checks }, null, 2)}\n`
  )
  writeFileSync(join(out, 'transcript.txt'), `${lines.join('\n')}\n`)
  if (clean) {
    run(['chmod', '-R', 'u+w', root])
    rmSync(root, { recursive: true, force: true })
  }
}
process.exit(failure === undefined && checks.every((c) => c.ok) ? 0 : 1)
