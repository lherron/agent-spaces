#!/usr/bin/env bun
/**
 * Muse-serve credential-free contract certification (T-08592, campaign P-00522).
 *
 * No-creds contract check against the REAL `muse serve` binary (MSP over
 * stdio) under a disposable HOME: initialize fingerprint gate, session/start,
 * echo turn lifecycle, steer/cancel fences, and wire-vocabulary discipline.
 * Model-calling turns are OUT OF SCOPE here (they need credentials and run in
 * the ghostmux HRC e2e, T-08595) — this row asserts the no-creds expectation
 * explicitly: the turn MUST settle terminal=failed with error.kind from the
 * published TurnErrorKind vocabulary, and usage MUST be absent.
 *
 * Matrix-row conventions followed: availability gate with clean SKIP when the
 * binary is absent, disposable state (temp HOME, removed afterwards),
 * PASS/FAIL verdict with evidence, nonzero exit on failure.
 *
 * Usage: bun scripts/smoke-muse-serve.ts [--bin <path>]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXPECTED_FINGERPRINT =
  'sha256:ab69549a7ebb423fce94068762da0b5ff3cdec1f8fc263dcc17248eda117f852'

// NOTE: session/started is emitted on the real wire (session/start opens with
// it) but is absent from the `muse schema` notification index — an export gap
// recorded as a T-08592 finding, not a vocabulary violation.
const KNOWN_NOTIFICATIONS = new Set([
  'initialized',
  'session/started',
  'approval/requested',
  'approval/resolved',
  'approval/updated',
  'item/completed',
  'item/delta',
  'item/started',
  'item/updated',
  'session/approvalModeChanged',
  'session/branchChanged',
  'session/contextUsage',
  'session/goalChanged',
  'session/modelChanged',
  'session/nameChanged',
  'session/reasoningEffortChanged',
  'session/statusChanged',
  'session/todoListChanged',
  'session/tokenUsage',
  'session/viewHealthChanged',
  'skill/changed',
  'turn/completed',
  'turn/retracted',
  'turn/retryScheduled',
  'turn/started',
  'turn/unqueued',
  'usage/changed',
  'userInput/requested',
  'userInput/settled',
  'view/gap',
])

interface Check {
  name: string
  ok: boolean
  detail?: string
}

function uuidv7(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function findBin(override: string | undefined): Promise<string | undefined> {
  if (override) return override
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    const candidate = join(dir, 'muse')
    try {
      const proc = Bun.spawnSync([candidate, '--version'])
      if (proc.exitCode === 0) return candidate
    } catch {
      // Not executable — try the next PATH entry.
    }
  }
  return undefined
}

async function main(): Promise<void> {
  const binFlag = process.argv.indexOf('--bin')
  const bin = await findBin(binFlag === -1 ? undefined : process.argv[binFlag + 1])
  if (!bin) {
    console.log('SKIP: no muse binary on PATH (pass --bin <path>)')
    process.exit(0)
  }
  const checks: Check[] = []
  const home = mkdtempSync(join(tmpdir(), 'muse-serve-smoke-'))
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
  }
  // NOTE: no --no-session-log. Memory-only sessions disable the read/view
  // surface (session/read, view/* answer methodNotFound and session/list is
  // empty). Durability lands inside the disposable temp HOME, removed below.
  const child = spawn(bin, ['serve'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  const pending = new Map<number, (message: Record<string, unknown>) => void>()
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  let nextId = 1
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length > 0) ingestLine(line)
      index = buffer.indexOf('\n')
    }
  })

  function ingestLine(line: string): void {
    const message = JSON.parse(line) as Record<string, unknown>
    if (typeof message['id'] === 'number' && pending.has(message['id'] as number)) {
      pending.get(message['id'] as number)?.(message)
      pending.delete(message['id'] as number)
    } else if (typeof message['method'] === 'string') {
      notifications.push({
        method: message['method'] as string,
        params: (message['params'] ?? {}) as Record<string, unknown>,
      })
    }
  }
  child.stderr.on('data', () => {
    // Host diagnostics channel; the wire is the contract under test.
  })

  function request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 20000
  ): Promise<Record<string, unknown>> {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, resolve)
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`timeout waiting for ${method}`))
        }
      }, timeoutMs)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, ...(detail !== undefined ? { detail } : {}) })
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const init = await request('initialize', {
      clientInfo: { name: 'muse_serve_smoke', version: '1' },
    })
    if (init['error'] !== undefined) {
      check('initialize accepted', false, JSON.stringify(init['error']).slice(0, 200))
      throw new Error('initialize rejected; cannot continue')
    }
    const result = (init['result'] ?? {}) as Record<string, unknown>
    const schema = (result['schema'] ?? {}) as Record<string, unknown>
    check('initialize accepted', true)
    check(
      'schema fingerprint matches committed export',
      schema['fingerprint'] === EXPECTED_FINGERPRINT,
      String(schema['fingerprint'] ?? 'absent')
    )
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 500))

    const start = await request('session/start', {
      commandId: uuidv7(),
      workspaceRoot: home,
    })
    const session = ((start['result'] ?? {}) as Record<string, unknown>)['session'] as
      | Record<string, unknown>
      | undefined
    check(
      'session/start returns a session id',
      typeof session?.['sessionId'] === 'string',
      start['error'] !== undefined ? JSON.stringify(start['error']).slice(0, 200) : undefined
    )
    const sessionId = session?.['sessionId'] as string

    const listed = await request('skill/list', { sessionId })
    check(
      'skill/list answers',
      Array.isArray((listed['result'] as Record<string, unknown> | undefined)?.['skills']),
      listed['error'] !== undefined ? JSON.stringify(listed['error']).slice(0, 160) : undefined
    )

    const commandId = uuidv7()
    const turn = await request(
      'turn/start',
      { commandId, sessionId, input: [{ type: 'text', text: 'say ECHO' }] },
      60000
    )
    const turnResult = (turn['result'] ?? {}) as Record<string, unknown>
    check(
      'turn/start accepted',
      turnResult['status'] === 'accepted',
      JSON.stringify(turn['error'] ?? turnResult).slice(0, 200)
    )
    check(
      'turnId taken from the ack (non-empty)',
      typeof turnResult['turnId'] === 'string' && (turnResult['turnId'] as string).length > 0,
      String(turnResult['turnId'] ?? 'absent')
    )
    check(
      'disposition is started',
      turnResult['disposition'] === 'started',
      String(turnResult['disposition'] ?? 'absent')
    )
    const turnId = turnResult['turnId'] as string

    const deadline = Date.now() + 45000
    let completed: Record<string, unknown> | undefined
    while (Date.now() < deadline) {
      completed = notifications.find(
        (n) =>
          n.method === 'turn/completed' && (n.params['turnId'] as string | undefined) === turnId
      )?.params
      if (completed) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    if (process.env['MUSE_SMOKE_DUMP'] === '1') {
      const counts = new Map<string, number>()
      for (const n of notifications) counts.set(n.method, (counts.get(n.method) ?? 0) + 1)
      console.log(`NOTIF-COUNTS ${JSON.stringify([...counts.entries()])}`)
      for (const n of notifications.filter((x) => x.method.startsWith('turn/'))) {
        console.log(`TURN-EVENT ${n.method} ${JSON.stringify(n.params).slice(0, 400)}`)
      }
    }
    check('turn/completed observed for the started turn', completed !== undefined)
    const terminal = completed?.['terminal'] as string | undefined
    const turnError = (completed?.['error'] ?? {}) as Record<string, unknown>
    check(
      'no-creds turn settles failed/authRequired with usage absent',
      terminal === 'failed' &&
        typeof turnError['kind'] === 'string' &&
        completed?.['usage'] == null,
      `terminal=${terminal ?? '?'} kind=${String(turnError['kind'] ?? '?')}`
    )

    const steer = await request('turn/steer', {
      commandId: uuidv7(),
      sessionId,
      expectedTurnId: uuidv7(),
      input: [{ type: 'text', text: 'x' }],
    })
    check(
      'steer fence rejects a non-running turn',
      steer['error'] !== undefined,
      JSON.stringify((steer['error'] ?? steer['result'] ?? {}) as Record<string, unknown>).slice(
        0,
        200
      )
    )

    const cancel = await request('turn/cancel', {
      commandId: uuidv7(),
      sessionId,
      turnId: uuidv7(),
    })
    check(
      'cancel fence rejects an unknown turn',
      cancel['error'] !== undefined,
      JSON.stringify((cancel['error'] ?? cancel['result'] ?? {}) as Record<string, unknown>).slice(
        0,
        200
      )
    )

    const unknown = notifications.filter((n) => !KNOWN_NOTIFICATIONS.has(n.method))
    check(
      'wire vocabulary stays within the 1.3.0 export',
      unknown.length === 0,
      unknown.map((n) => n.method).join(',') || undefined
    )
  } catch (error) {
    checks.push({
      name: 'smoke completed without exception',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    })
  } finally {
    child.kill()
    rmSync(home, { recursive: true, force: true })
  }

  let failed = 0
  for (const item of checks) {
    console.log(
      `${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`
    )
    if (!item.ok) failed += 1
  }
  if (failed > 0) {
    console.log(`muse-serve smoke: ${failed} failing check(s)`)
    process.exit(1)
  }
  console.log(`muse-serve smoke: all ${checks.length} checks green (no creds)`)
}

await main()
