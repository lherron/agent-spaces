import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
