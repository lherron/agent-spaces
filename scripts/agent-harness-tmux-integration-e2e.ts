#!/usr/bin/env bun
/**
 * T-07567 cross-phase integration: Phase 4 driver vs Phase 3 child, for real.
 *
 * Every assertion in the two phases' unit suites is against a DOUBLE — the
 * driver reds drive a fake control channel, the child reds drive a fake broker
 * socket server. Neither has met the other. This script closes that seam: a
 * REAL `agent-harness tui` child process, launched by the REAL
 * `agent-harness-tmux` driver, on a REAL tmux pane, through the REAL broker,
 * against REAL oauth credentials, running a REAL model turn.
 *
 * Production fidelity is deliberate. The spec mirrors what HRC's
 * `direct-agent-harness.ts` builds for the headless surface (sdk.provider
 * `openai-codex`, authMode `oauth`) and the auth store is the same
 * `~/.pi/agent/auth.json` that `broker-headless-handlers.ts:485` selects, so
 * the oauth branch of `resolvePiSdkAuth` and its injected `readStoredCredential`
 * are exercised on the path production actually takes.
 *
 * Usage:  bun scripts/agent-harness-tmux-integration-e2e.ts [--keep-pane]
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readStoredCredential } from '@earendil-works/pi-coding-agent'
import { createBroker, createDefaultAgentHarnessTmuxDriver } from 'spaces-harness-broker'
import type { HarnessInvocationSpec, InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { allocatePreHrcTmuxPane } from '../compiler/agent-spaces/src/testing/pre-hrc-tmux-allocator.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const keepPane = process.argv.includes('--keep-pane')
const marker = `t07567-${process.pid}`
const invocationId = `inv_agent_harness_tmux_${marker}`
const agentId = 'sparky'
const authStore = join(homedir(), '.pi', 'agent', 'auth.json')
const aspHome = process.env['ASP_HOME'] ?? join(homedir(), 'praesidium/var/spaces-repo')
const tmuxBin = process.env['TMUX_BIN'] ?? '/opt/homebrew/bin/tmux'
const sentinel = `PONG-${marker.toUpperCase()}`
/**
 * DEFAULT is the FRESH-launch case: no continuation anywhere, which is what
 * production starts from and what T-07585 made representable. Set
 * AH_E2E_CONTINUATION_KEY to an existing session file under
 * <aspHome>/agent-harness/sessions/<agentId>/ to exercise resume instead.
 */
const continuationKey = process.env['AH_E2E_CONTINUATION_KEY']

const BOOT_TIMEOUT_MS = 120_000
const TURN_TIMEOUT_MS = 180_000

const events: InvocationEventEnvelope[] = []
const failures: string[] = []

function check(label: string, ok: boolean, detail = ''): void {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`
  console.log(line)
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

function runTmux(argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(tmuxBin, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    proc.on('error', reject)
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`tmux ${argv.join(' ')} exited ${code}: ${stderr}`))
    )
  })
}

function capturePane(socketPath: string, paneId: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(tmuxBin, [
      '-S',
      socketPath,
      'capture-pane',
      '-t',
      paneId,
      '-p',
      '-S',
      '-200',
    ])
    let stdout = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    proc.on('error', () => resolve(''))
    proc.on('close', () => resolve(stdout))
  })
}

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await Bun.sleep(250)
  }
  console.log(`  (timed out waiting for ${label} after ${timeoutMs}ms)`)
  return false
}

function buildSpec(controlCwd: string): HarnessInvocationSpec {
  return {
    specVersion: 'harness-broker.invocation/v1',
    invocationId,
    harness: { frontend: 'agent-harness', provider: 'openai', driver: 'agent-harness-tmux' },
    process: {
      command: join(repoRoot, 'harness/agent-harness/bin/agent-harness.js'),
      // Deliberately non-empty and semantic: the driver must ignore ALL of it
      // and launch `tui --broker-control-socket <its own path>` instead.
      args: ['tui', '--agent-id', 'argv-must-not-win'],
      cwd: controlCwd,
      lockedEnv: { ASP_HOME: aspHome },
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
      agentId,
      projectId: 'agent-spaces',
      aspHome,
      runMode: 'task',
      scopeRef: `agent:${agentId}:project:agent-spaces:task:T-07567`,
      runId: `run-${marker}`,
    },
    ...(continuationKey !== undefined
      ? { continuation: { provider: 'openai', kind: 'session', key: continuationKey } }
      : {}),
    correlation: { runtimeId: `runtime-${marker}` },
  } as HarnessInvocationSpec
}

async function main(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), 'ah-tmux-e2e-'))
  const tmuxSocket = join(workDir, 'tmux.sock')
  const controlDir = join(workDir, 'ipc')
  let paneId = ''
  let disposed = false

  console.log(`repo       ${repoRoot}`)
  console.log(`asp home   ${aspHome}`)
  console.log(`auth store ${authStore}`)
  console.log(`sentinel   ${sentinel}`)
  console.log(`continuation ${continuationKey ?? '(none — fresh launch)'}`)
  console.log('')

  try {
    await runTmux(['-S', tmuxSocket, 'start-server'])
    const allocated = await allocatePreHrcTmuxPane({
      tmuxBin,
      socketPath: tmuxSocket,
      sessionName: `ah-e2e-${marker}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60),
    })
    // Test-rig only, and deliberately NOT a change to the launch shape: the
    // driver still pastes `exec bun <runner> ...`, so the child is still the
    // pane process. `remain-on-exit` keeps the dead pane readable so a child
    // that fails at startup leaves its stderr where capture-pane can reach it,
    // and `exit-empty off` keeps the server alive so every later tmux call
    // reports the real state instead of 'no server running'.
    await runTmux(['-S', tmuxSocket, 'set-option', '-g', 'remain-on-exit', 'on'])
    await runTmux(['-S', tmuxSocket, 'set-option', '-g', 'exit-empty', 'off'])
    paneId = allocated.paneId
    console.log(`pane       ${allocated.sessionId}/${allocated.windowId}/${allocated.paneId}`)

    // The REAL production driver, wired exactly as harness/agent-harness/src/cli.ts wires it.
    const driver = createDefaultAgentHarnessTmuxDriver(controlDir, { readStoredCredential })
    const broker = createBroker({
      drivers: [driver],
      onEvent: (event) => {
        events.push(event)
        const tag = event.turnId === undefined ? '' : ` turn=${event.turnId}`
        const detail =
          event.type === 'invocation.failed' ||
          event.type === 'turn.failed' ||
          event.type === 'diagnostic'
            ? ` ${JSON.stringify(event.payload)}`
            : ''
        console.log(`  event #${event.seq} ${event.type}${tag}${detail}`)
      },
    })

    const spec = buildSpec(repoRoot)
    await broker.start(
      { spec },
      { HARNESS_PI_AUTH_STORE: authStore },
      {
        terminalSurface: allocated.lease,
      }
    )

    // (d) `ready{sessionFile}` -> continuation.updated, emitted before any turn.
    const booted = await waitFor(
      'continuation.updated from the child ready frame',
      () => events.some((event) => event.type === 'continuation.updated'),
      BOOT_TIMEOUT_MS
    )
    if (!booted) {
      console.log(`\n--- pane ---\n${await capturePane(tmuxSocket, paneId)}`)
      throw new Error('child never reported ready over the control channel')
    }
    const continuation = events.find((event) => event.type === 'continuation.updated')
    check(
      'd. ready{sessionFile} surfaced as continuation.updated before any turn',
      continuation !== undefined &&
        typeof (continuation.payload as { key?: unknown }).key === 'string' &&
        (continuation.payload as { key: string }).key.length > 0,
      `key=${String((continuation?.payload as { key?: unknown })?.key)}`
    )

    const preTurnBody = events.filter((event) => event.type.startsWith('assistant.'))
    check('   no assistant body events before the first turn', preTurnBody.length === 0)

    // Drive one real prompt-bearing turn.
    const response = await broker.input({
      invocationId,
      input: {
        inputId: `input-${marker}`,
        kind: 'user',
        content: [
          {
            type: 'text',
            text: `Reply with exactly ${sentinel} and nothing else. Do not use any tools.`,
          },
        ],
      },
    })
    console.log(`  input disposition: ${JSON.stringify(response)}`)

    const settled = await waitFor(
      'turn settlement',
      () =>
        events.some(
          (event) =>
            event.type === 'turn.completed' ||
            event.type === 'turn.failed' ||
            event.type === 'turn.interrupted'
        ),
      TURN_TIMEOUT_MS
    )

    const startIndex = events.findIndex((event) => event.type === 'turn.started')
    const brokerTurnId = startIndex >= 0 ? events[startIndex]?.turnId : undefined
    const bodyIndexes = events
      .map((event, index) => ({ event, index }))
      .filter(
        ({ event }) =>
          event.type.startsWith('assistant.') ||
          event.type.startsWith('tool.') ||
          event.type === 'usage.updated'
      )
    const terminal = events.find(
      (event) =>
        event.type === 'turn.completed' ||
        event.type === 'turn.failed' ||
        event.type === 'turn.interrupted'
    )

    console.log('')
    check('a. turn.started bracket opened', startIndex >= 0, `turnId=${String(brokerTurnId)}`)
    check(
      'a. turn.started carries the broker-allocated turnId',
      brokerTurnId === `turn_${invocationId}_1`,
      String(brokerTurnId)
    )
    check(
      'a. body events carry the same broker turnId',
      bodyIndexes.length > 0 && bodyIndexes.every(({ event }) => event.turnId === brokerTurnId),
      `${bodyIndexes.length} body events`
    )
    check('a. the turn SETTLES', settled && terminal !== undefined, terminal?.type ?? 'none')
    check(
      'b. no body event precedes the turn.started bracket',
      startIndex >= 0 && bodyIndexes.every(({ index }) => index > startIndex),
      bodyIndexes.length === 0
        ? 'no body events'
        : `first body at #${bodyIndexes[0]?.index}, bracket at #${startIndex}`
    )
    check(
      'c. ack handshake completed against the real child (exact requestId branch)',
      startIndex >= 0,
      'turn.begin was acknowledged or applyInputNow would never have returned'
    )
    check(
      '   broker sequencing is dense and driver-owned',
      events.every((event, index) => event.seq === index + 1),
      `seq 1..${events.length}`
    )

    const assistantText = events
      .filter((event) => event.type === 'assistant.message.completed')
      .map((event) => JSON.stringify(event.payload))
      .join(' ')
    check(
      '   the model actually answered (real turn, not a stub)',
      assistantText.includes(sentinel),
      assistantText.slice(0, 200)
    )

    if (failures.length > 0) {
      console.log(`\n--- pane ---\n${await capturePane(tmuxSocket, paneId)}`)
    }

    await broker.stop({ invocationId, reason: 'e2e complete' })
    await broker.dispose({ invocationId })
    disposed = true
  } finally {
    if (!disposed) console.log('(broker not cleanly disposed)')
    if (!keepPane) {
      // Never leak a tmux server: leaked per-runtime broker servers were the
      // root cause of a prior PTY-exhaustion incident.
      await runTmux(['-S', tmuxSocket, 'kill-server']).catch(() => undefined)
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    } else {
      console.log(`\n(kept pane; attach with: ${tmuxBin} -S ${tmuxSocket} attach)`)
    }
  }

  console.log('')
  if (failures.length > 0) {
    console.log(`INTEGRATION FAILED (${failures.length}):`)
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exit(1)
  }
  console.log('INTEGRATION PASSED')
}

await main()
