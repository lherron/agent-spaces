/**
 * The scratch rig for raspd sole-mode checks (T-13039): a fresh compare-runner
 * stage, a synthetic release raspd accepts, stand-ins for the harness CLIs,
 * and a raspd started on it with a clean environment and umask 022.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'

import { buildCases, seedStage } from '../aspd-compare/cases.ts'
import { loadAsp } from '../path-markers-e2e.ts'
import type { BaseCase, Stage } from './ctx.ts'

export function drive(socket: string, frames: string[], idleMs = 180_000): Promise<any[]> {
  return new Promise((done, reject) => {
    const c = connect(socket)
    const lines: string[] = []
    let buffer = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      clearTimeout(timer)
      c.destroy()
      done(
        lines.map((l) => {
          try {
            return JSON.parse(l)
          } catch {
            return { unparsed: l }
          }
        })
      )
    }
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(finish, idleMs)
    }
    c.on('error', (e) => (lines.length > 0 ? finish() : reject(e)))
    c.on('close', finish)
    c.on('connect', () => {
      for (const f of frames) c.write(`${f}\n`)
      arm()
    })
    const dec = new TextDecoder()
    c.on('data', (chunk) => {
      buffer += dec.decode(chunk, { stream: true })
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      lines.push(...parts)
      if (lines.length >= frames.length) finish()
      else arm()
    })
  })
}

export const frame = (id: number, method: string, params: unknown) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params })

function sha256(text: string) {
  return createHash('sha256').update(text).digest('hex')
}

/** A release's identity (release.json releaseId, sourceCommit, builtAt). */
export type ReleaseIdentity = { releaseId: string; sourceCommit: string; builtAt: string }

const SYNTHETIC: ReleaseIdentity = {
  releaseId: 'asp-000000000000-20261109T000000Z-sole00',
  sourceCommit: '0000000000000000000000000000000000000000',
  builtAt: '2026-11-09T00:00:00.000Z',
}

/**
 * A release raspd accepts: release.json with the statusline asset and worker
 * bindings. `identity` names it (a Bun aspd payload only serves from a release
 * carrying its compiled-in identity).
 */
export function syntheticRelease(root: string, identity: ReleaseIdentity = SYNTHETIC): string {
  const id = identity.releaseId
  const release = join(root, id)
  mkdirSync(join(release, 'assets', 'claude'), { recursive: true })
  const statusline = '#!/bin/sh\necho statusline\n'
  writeFileSync(join(release, 'assets', 'claude', 'statusline.sh'), statusline, { mode: 0o755 })
  for (const exe of ['harness-broker', 'agent-harness'])
    writeFileSync(join(release, exe), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const manifest = {
    schemaVersion: 'asp-standalone-release/v1',
    releaseId: id,
    sourceCommit: identity.sourceCommit,
    builtAt: identity.builtAt,
    assets: {
      'claude-statusline': { path: 'assets/claude/statusline.sh', sha256: sha256(statusline) },
    },
    workerBindings: {
      'codex-app-server': 'harness-broker',
      'claude-code-tmux': 'harness-broker',
      'claude-code-hrcpty': 'harness-broker',
      'muse-serve': 'harness-broker',
      'muse-cli-tmux': 'harness-broker',
      'agent-harness': 'agent-harness',
      'agent-harness-tmux': 'agent-harness',
    },
    executables: {
      'harness-broker': { launcher: 'harness-broker' },
      'agent-harness': { launcher: 'agent-harness' },
    },
  }
  writeFileSync(join(release, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return release
}

/** Stand-ins for the harness CLIs raspd probes (claude by path, codex by --version). */
export function stubs(dir: string): { claude: string; codex: string } {
  mkdirSync(dir, { recursive: true })
  const claude = join(dir, 'claude')
  writeFileSync(claude, '#!/bin/sh\necho "2.1.0 (Claude Code)"\n', { mode: 0o755 })
  const codex = join(dir, 'codex')
  writeFileSync(
    codex,
    '#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.200.0";; *) echo help;; esac\n',
    { mode: 0o755 }
  )
  return { claude, codex }
}

async function waitFor(path: string, child: ChildProcess) {
  for (let i = 0; i < 300; i++) {
    if (existsSync(path)) return
    if (child.exitCode !== null) throw new Error(`raspd exited ${child.exitCode} before listening`)
    await Bun.sleep(50)
  }
  throw new Error(`raspd never listened on ${path}`)
}

export function logLines(path: string, from: number): { lines: any[]; to: number } {
  if (!existsSync(path)) return { lines: [], to: from }
  const buf = readFileSync(path)
  const lines = buf
    .subarray(from)
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return {}
      }
    })
  return { lines, to: buf.length }
}

export type Rig = {
  scratch: string
  stage: Stage
  bases: Record<string, BaseCase>
  socket: string
  log: string
  child: ChildProcess
  stop: () => Promise<void>
}

/**
 * Seed the stage under `scratch` and start `raspd` on it (no --upstream unless
 * given). `subject: 'bun'` starts a release's Bun aspd binary (libexec/aspd)
 * instead, the oracle the native half's recorded replies come from: both get
 * the same environment, including the release identity a release launcher
 * exports, so their replies are comparable byte for byte.
 */
export async function startRig(
  scratch: string,
  raspd: string,
  extraArgs: string[] = [],
  subject: 'raspd' | 'bun' = 'raspd',
  identity?: ReleaseIdentity
): Promise<Rig> {
  const asp = await loadAsp()
  const stage = seedStage(asp, join(scratch, 'stage')) as Stage
  const bases: Record<string, BaseCase> = {}
  for (const c of buildCases(asp, stage))
    if (c.kind === 'call') bases[c.id] = { id: c.id, method: c.method, params: c.params }
  // ensureAspHome's directories, as the first compile on a node leaves them,
  // so a concurrent case's compile does not add them under another's snapshot.
  for (const d of ['repo', 'sources', 'snapshots', 'cache', 'projects', 'tmp'])
    mkdirSync(join(stage.aspHome, d), { recursive: true })
  const release = syntheticRelease(join(scratch, 'releases'), identity)
  const manifest = JSON.parse(readFileSync(join(release, 'release.json'), 'utf8'))
  const bin = stubs(join(scratch, 'bin'))
  const home = join(scratch, 'home')
  mkdirSync(home, { recursive: true })
  const socket = join(scratch, 'aspd.sock')
  const log = join(scratch, 'raspd.log')
  const env: Record<string, string> = {
    HOME: home,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    USER: process.env['USER'] ?? 'agent',
    LOGNAME: process.env['LOGNAME'] ?? process.env['USER'] ?? 'agent',
    SHELL: '/bin/zsh',
    TMPDIR: join(scratch, 'tmp'),
    LANG: 'en_US.UTF-8',
    ASP_HOME: stage.aspHome,
    ASP_AGENTS_ROOT: stage.agentsRoot,
    CLAUDE_CONFIG_DIR: stage.claudeHome,
    ASP_CLAUDE_PATH: bin.claude,
    ASP_CLAUDE_SKIP_COMMON_PATHS: '1',
    ASP_CODEX_PATH: bin.codex,
    ASP_CODEX_SKIP_COMMON_PATHS: '1',
    ASP_USAGE_METRICS_VAR_ROOT: join(scratch, 'var'),
    ASP_RELEASE_ID: manifest.releaseId,
    ASP_RELEASE_SOURCE_COMMIT: manifest.sourceCommit,
    ASP_RELEASE_ROOT: release,
  }
  mkdirSync(env['TMPDIR'] as string, { recursive: true })
  // Bun aspd refuses a payload outside its release: give it this one's libexec.
  if (subject === 'bun') {
    mkdirSync(join(release, 'libexec'), { recursive: true })
    for (const name of readdirSync(dirname(resolve(raspd))))
      copyFileSync(join(dirname(resolve(raspd)), name), join(release, 'libexec', name))
  }
  const argv =
    subject === 'bun'
      ? [join(release, 'libexec', basename(raspd)), 'serve', '--socket', socket, '--log', log]
      : [
          resolve(raspd),
          'serve',
          '--socket',
          socket,
          '--log',
          log,
          '--kernel-socket',
          join(scratch, 'kernel.sock'),
          '--release-root',
          release,
          '--metrics-dir',
          join(scratch, 'metrics'),
          ...extraArgs,
        ]
  const child = spawn('/bin/sh', ['-c', 'umask 022; exec "$@"', subject, ...argv], {
    cwd: scratch,
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  await waitFor(socket, child)
  const stop = async () => {
    if (child.exitCode !== null) return
    child.kill('SIGTERM')
    await new Promise((done) => child.on('exit', done))
  }
  return { scratch, stage, bases, socket, log, child, stop }
}
