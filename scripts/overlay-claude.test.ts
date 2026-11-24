import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let home: string
let claude: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'claude-overlay-'))
  claude = join(home, '.claude')
  mkdirSync(join(claude, 'sessions'), { recursive: true })
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

function overlay(): string {
  const result = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, 'overlay-claude.ts'), '--to', claude],
    cwd: join(import.meta.dir, '..'),
  })
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
  return result.stdout.toString()
}

test('preserves unmanaged settings bytes and is idempotent', () => {
  const settings = join(claude, 'settings.json')
  const motd =
    '{ "matcher": "startup", "hooks": [{"command":"cat ~/praesidium/AGENT_MOTD.md","type":"command"}] }'
  const original = `{ "permissions": {"allow":[ "Read" ]}, "hooks": {"SessionStart": [${motd}]} }\n`
  writeFileSync(settings, original)
  expect(overlay()).toContain('overlay updated')
  const written = readFileSync(settings, 'utf8')
  expect(written).toContain(motd)
  expect(written).toContain('"permissions": {"allow":[ "Read" ]}')
  const { hooks } = JSON.parse(written)
  expect(Object.keys(hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification'])
  expect(hooks.SessionStart).toHaveLength(2)
  expect(overlay()).toContain('overlay unchanged')
  expect(readFileSync(settings, 'utf8')).toBe(written)
})

test('reports a live registration on the first prompt after join', () => {
  overlay()
  const sessionId = 'desktop-session'
  const claudePid = '31416'
  const state = join(claude, 'hrc-desktop', sessionId)
  mkdirSync(state, { recursive: true })
  writeFileSync(
    join(claude, 'sessions', `${claudePid}.json`),
    JSON.stringify({ entrypoint: 'claude-desktop', sessionId, cwd: home })
  )
  writeFileSync(join(state, 'broker.pid'), String(process.pid))

  function prompt() {
    const result = Bun.spawnSync({
      cmd: [process.execPath, join(claude, 'hrc-desktop-hook', 'join.mjs'), claudePid],
      env: { HOME: home, PATH: '/usr/bin:/bin' },
      stdin: Buffer.from(
        JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId })
      ),
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe('')
    return result.stdout.toString()
  }

  expect(prompt()).toBe('')
  writeFileSync(
    join(state, 'join.json'),
    JSON.stringify({
      phase: 'joined',
      pid: process.pid,
      scopeRef: `agent:vega:project:hrc-runtime:task:claude-${sessionId}`,
    })
  )
  expect(JSON.parse(prompt())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `## Join report\n\nregistered: vega@hrc-runtime:claude-${sessionId}\n`,
    },
  })
  expect(prompt()).toBe('')
})

test('a joining hook sweeps the state of ended sessions and keeps every live one', () => {
  overlay()
  const deadPid = Bun.spawnSync({ cmd: ['/usr/bin/true'] }).pid
  const current = 'current-session'
  const stateRoot = join(claude, 'hrc-desktop')
  const scopes = join(claude, 'hrc-desktop-scopes')
  mkdirSync(scopes, { recursive: true })
  function session(sessionId: string, options: { rowPid?: number; brokerPid?: number }) {
    const state = join(stateRoot, sessionId)
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'join.json'), JSON.stringify({ phase: 'joined', pid: deadPid }))
    writeFileSync(join(scopes, `${sessionId}.json`), '{}')
    if (options.brokerPid !== undefined) {
      writeFileSync(join(state, 'broker.pid'), String(options.brokerPid))
    }
    if (options.rowPid !== undefined) {
      writeFileSync(
        join(claude, 'sessions', `${options.rowPid === deadPid ? 77777 : options.rowPid}.json`),
        JSON.stringify({ pid: options.rowPid, sessionId, entrypoint: 'claude-desktop', cwd: home })
      )
    }
    return state
  }
  // The hook's own session: its row's pid is the hook's argv, its broker alive.
  writeFileSync(
    join(claude, 'sessions', '31416.json'),
    JSON.stringify({ entrypoint: 'claude-desktop', sessionId: current, cwd: home })
  )
  const currentState = session(current, { brokerPid: process.pid })
  const live = session('live-session', { rowPid: process.pid })
  const archivedWithBroker = session('archived-broker-alive', { brokerPid: process.pid })
  const archived = session('archived-session', { brokerPid: deadPid })
  const crashed = session('crashed-session', { rowPid: deadPid })

  function prompt() {
    const result = Bun.spawnSync({
      cmd: [process.execPath, join(claude, 'hrc-desktop-hook', 'join.mjs'), '31416'],
      env: { HOME: home, PATH: '/usr/bin:/bin' },
      stdin: Buffer.from(
        JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: current })
      ),
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe('')
  }

  // Ended records: a resumed session's binding, aged out after 30 days unless live.
  const endedRoot = join(claude, 'hrc-desktop-ended')
  mkdirSync(endedRoot, { recursive: true })
  const monthAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
  for (const name of ['old-ended', 'young-ended', 'live-session']) {
    writeFileSync(join(endedRoot, `${name}.json`), '{"phase":"ended"}')
    if (name !== 'young-ended') utimesSync(join(endedRoot, `${name}.json`), monthAgo, monthAgo)
  }

  // A registry row caught mid-write: nothing is swept this time.
  writeFileSync(join(claude, 'sessions', '55555.json'), '{"pid":')
  prompt()
  expect(existsSync(archived)).toBe(true)
  expect(existsSync(crashed)).toBe(true)

  rmSync(join(claude, 'sessions', '55555.json'))
  prompt()
  expect(existsSync(currentState)).toBe(true)
  expect(existsSync(live)).toBe(true)
  expect(existsSync(archivedWithBroker)).toBe(true)
  expect(existsSync(archived)).toBe(false)
  expect(existsSync(crashed)).toBe(false)
  expect(existsSync(join(scopes, 'archived-session.json'))).toBe(false)
  expect(existsSync(join(scopes, 'live-session.json'))).toBe(true)
  expect(existsSync(join(endedRoot, 'old-ended.json'))).toBe(false)
  expect(existsSync(join(endedRoot, 'young-ended.json'))).toBe(true)
  expect(existsSync(join(endedRoot, 'live-session.json'))).toBe(true)
  const swept = readFileSync(join(claude, 'hrc-desktop-ended.log'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).sessionId)
    .sort()
  expect(swept).toEqual(['archived-session', 'crashed-session'])
})

test('SessionStart adds a guard that reads the current caller env at Bash execution', () => {
  overlay()
  const sessionId = 'new-desktop-session'
  const state = join(claude, 'hrc-desktop', sessionId)
  const envFile = join(home, 'session-start.sh')
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'broker.pid'), String(process.pid))
  writeFileSync(
    join(claude, 'sessions', '31416.json'),
    JSON.stringify({ entrypoint: 'claude-desktop', sessionId, cwd: home })
  )
  writeFileSync(
    join(state, 'join.json'),
    JSON.stringify({
      phase: 'joined',
      pid: process.pid,
      scopeRef: `agent:vega:project:hrc-runtime:task:claude-${sessionId}`,
    })
  )
  const hook = Bun.spawnSync({
    cmd: [process.execPath, join(claude, 'hrc-desktop-hook', 'join.mjs'), '31416'],
    env: { HOME: home, PATH: '/usr/bin:/bin', CLAUDE_ENV_FILE: envFile },
    stdin: Buffer.from(JSON.stringify({ hook_event_name: 'SessionStart', session_id: sessionId })),
  })
  expect(hook.exitCode).toBe(0)
  const setup = readFileSync(envFile, 'utf8')
  function bashCall() {
    const shell = Bun.spawnSync({
      cmd: ['/bin/bash', '-ec', `${setup}\nprintf '%s' "\${HRC_RUNTIME_ID:-unjoined}"`],
      env: {},
    })
    expect(shell.exitCode).toBe(0)
    return shell.stdout.toString()
  }
  expect(bashCall()).toBe('unjoined')
  writeFileSync(join(state, 'caller-env.sh'), 'export HRC_RUNTIME_ID=rt_joined\n')
  expect(bashCall()).toBe('rt_joined')
})

test('the Stop hook enforces HRC reply obligations and allows on any failure', async () => {
  overlay()
  const sessionId = 'desktop-session'
  const claudePid = '31416'
  const state = join(claude, 'hrc-desktop', sessionId)
  mkdirSync(state, { recursive: true })
  writeFileSync(
    join(claude, 'sessions', `${claudePid}.json`),
    JSON.stringify({ entrypoint: 'claude-desktop', sessionId, cwd: home })
  )
  writeFileSync(
    join(state, 'join.json'),
    JSON.stringify({
      phase: 'joined',
      pid: process.pid,
      runtimeId: 'rt-desktop',
      scopeRef: `agent:vega:project:hrc-runtime:task:claude-${sessionId}`,
    })
  )
  const hrcSocket = join('/tmp', `stop-${crypto.randomUUID().slice(0, 8)}.sock`)
  const asked: Array<{ body: unknown; caller: string | null }> = []
  const server = Bun.serve({
    unix: hrcSocket,
    async fetch(request) {
      asked.push({ body: await request.json(), caller: request.headers.get('x-praesidium-caller') })
      return Response.json({ decision: 'block', reason: 'Answer EN-1 before ending the turn.' })
    },
  })
  async function stop() {
    const child = Bun.spawn({
      cmd: [process.execPath, join(claude, 'hrc-desktop-hook', 'join.mjs'), claudePid],
      env: { HOME: home, PATH: '/usr/bin:/bin', HRC_MAIL_STOP_SOCKET: hrcSocket },
      stdin: Buffer.from(JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId })),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code).toBe(0)
    expect(stderr).toBe('')
    return stdout
  }
  try {
    expect(JSON.parse(await stop())).toEqual({
      decision: 'block',
      reason: 'Answer EN-1 before ending the turn.',
    })
    expect(asked).toEqual([
      {
        body: { runtimeId: 'rt-desktop' },
        caller: `vega@hrc-runtime:claude-${sessionId}`,
      },
    ])
  } finally {
    server.stop(true)
    rmSync(hrcSocket, { force: true })
  }
  // HRC unreachable: the turn ends normally.
  expect(await stop()).toBe('')
})

describe.skipIf(process.platform !== 'darwin')('desktop shell gate', () => {
  function hookCommand(): string {
    return JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8')).hooks.SessionStart[0]
      .hooks[0].command
  }

  function run(entrypoint: string, brokerEnv: Record<string, string> = {}) {
    // Control the parent row separately from the fallback to prove a CLI
    // parent cannot be admitted via the fallback.
    writeFileSync(
      join(claude, 'sessions', '31416.json'),
      JSON.stringify({ entrypoint: 'claude-desktop' })
    )
    overlay()
    const bin = join(home, '.local', 'bin')
    mkdirSync(bin, { recursive: true })
    const node = join(bin, 'node')
    writeFileSync(node, '#!/bin/sh\nprintf "%s\\n" "$2"\n')
    chmodSync(node, 0o700)
    return Bun.spawnSync({
      cmd: [
        '/bin/sh',
        '-c',
        'printf "%s" "$1" > "$HOME/.claude/sessions/$$.json"; /bin/sh -c "$2"; exit "$?"',
        'hook-test',
        JSON.stringify({ entrypoint }),
        hookCommand(),
      ],
      env: { HOME: home, PATH: '/usr/bin:/bin', CLAUDE_PID: '31416', ...brokerEnv },
      stdin: 'ignore',
    })
  }

  test('rejects a broker invocation and any other broker-prefixed variable, even if empty', () => {
    for (const key of ['HARNESS_BROKER_INVOCATION_ID', 'HARNESS_BROKER_FUTURE_KEY']) {
      const result = run('claude-desktop', { [key]: '' })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toBe('')
      expect(result.stderr.toString()).toBe('')
    }
  })

  test('rejects a cli parent even when the fallback says desktop', () => {
    const result = run('cli')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('')
    expect(result.stderr.toString()).toBe('')
  })

  test('passes a desktop parent to Node and falls back to CLAUDE_PID when the parent row is absent', () => {
    const parent = run('claude-desktop')
    expect(parent.exitCode).toBe(0)
    expect(parent.stdout.toString().trim()).toMatch(/^[0-9]+$/)
    expect(parent.stdout.toString().trim()).not.toBe('31416')
    const result = Bun.spawnSync({
      cmd: ['/bin/sh', '-c', hookCommand()],
      env: { HOME: home, PATH: '/usr/bin:/bin', CLAUDE_PID: '31416' },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString().trim()).toBe('31416')
  })
})
