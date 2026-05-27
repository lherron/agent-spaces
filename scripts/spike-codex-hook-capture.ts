#!/usr/bin/env bun
/**
 * T-01681 spike — capture REAL codex interactive lifecycle hook payloads using
 * the EXISTING ASP codex hook infra, driven through ghostmux.
 *
 * Reuse:
 *  - buildHrcCodexHooksConfig(CODEX_INTERACTIVE_HOOK_EVENTS) from the codex
 *    adapter materializes the same hooks.json shape ASP ships (Stop today),
 *    extended to all 5 lifecycle events all pointing at $HRC_LAUNCH_HOOK_CLI.
 *  - The ghostmux operator primitives drive a real operator-typed turn.
 *  - HRC_LAUNCH_HOOK_CLI -> spike-codex-hook-recorder.ts tees raw stdin.
 *
 * Output artifacts land in <ARTIFACT_DIR>/payloads (raw payloads) + a pane.txt.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import TOML from '@iarna/toml'

import {
  CODEX_INTERACTIVE_HOOK_EVENTS,
  addCodexHookTrustState,
  buildHrcCodexHooksConfig,
} from '../packages/harness-codex/src/adapters/codex-adapter.js'
import {
  capturePane,
  driveOperatorTurn,
  ghostmux,
  ghostmuxAvailable,
  sleep,
} from '../packages/agent-spaces/src/testing/pre-hrc-ghostmux-operator.js'

const ARTIFACT_DIR =
  process.env['ASP_SPIKE_ARTIFACT_DIR'] ?? '/Users/lherron/praesidium/var/wrkq-artifacts/T-01681'
const PAYLOAD_DIR = join(ARTIFACT_DIR, 'payloads')
const RECORDER = join(import.meta.dir, 'spike-codex-hook-recorder.ts')
const GMUX = 'ghostmux'
const MARKER = `SPIKE_${Date.now().toString(36).toUpperCase()}`
const ENTER_DELAY_MS = 250

function resolveCodex(): string {
  const explicit = process.env['ASP_CODEX_PATH']
  if (explicit && existsSync(explicit)) return explicit
  const versionsDir = join(homedir(), '.nvm/versions/node')
  if (existsSync(versionsDir)) {
    for (const v of readdirSync(versionsDir).sort().reverse()) {
      const c = join(versionsDir, v, 'bin/codex')
      if (existsSync(c)) return c
    }
  }
  const onPath = Bun.which('codex')
  if (onPath) return onPath
  throw new Error('codex binary not found (set ASP_CODEX_PATH)')
}

function materializeCodexHome(): string {
  // realpathSync resolves macOS /var -> /private/var. codex canonicalizes the
  // hooks.json path before keying [hooks.state], so the trust keys must use the
  // canonical path or codex treats the hooks as untrusted and re-prompts.
  const codexHome = realpathSync(mkdtempSync(join(tmpdir(), 'spike-codex-home-')))

  // Reuse the production builder, extended to the full lifecycle event set.
  const hooksPath = join(codexHome, 'hooks.json')
  const hooksConfig = buildHrcCodexHooksConfig(CODEX_INTERACTIVE_HOOK_EVENTS)
  writeFileSync(hooksPath, `${JSON.stringify(hooksConfig, null, 2)}\n`)

  // Pre-seed BOTH trust gates so the unattended run never blocks on a prompt:
  //  - project trust for the cwd (codex's directory-trust dialog)
  //  - hook trust via the existing ASP helper (codex's hook-review dialog) — the
  //    --dangerously-bypass-hook-trust flag does NOT skip the interactive TUI gate.
  const baseConfig: Record<string, unknown> = {
    features: { hooks: true },
    projects: { [process.cwd()]: { trust_level: 'trusted' } },
  }
  const config = addCodexHookTrustState(baseConfig, hooksPath, hooksConfig)
  writeFileSync(join(codexHome, 'config.toml'), `${TOML.stringify(config as TOML.JsonMap)}\n`)

  // Reuse real OAuth creds.
  const userAuth = join(homedir(), '.codex', 'auth.json')
  if (existsSync(userAuth)) {
    try {
      symlinkSync(userAuth, join(codexHome, 'auth.json'))
    } catch {
      /* ignore */
    }
  }
  return codexHome
}

async function waitForCodexReady(surfaceId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let prev = ''
  let stable = 0
  while (Date.now() < deadline) {
    const pane = await capturePane(GMUX, surfaceId)
    // Codex composer renders a bordered input; treat a non-trivial, stable pane
    // mentioning codex / the input affordance as "ready".
    if (pane.length > 40 && pane === prev) {
      stable += 1
      if (stable >= 2) return true
    } else {
      stable = 0
    }
    prev = pane
    await sleep(1000)
  }
  return false
}

// `materialize` mode: build the codex home and print pointers, then exit so the
// caller can launch + drive + capture via the ghostmux CLI and watch it live.
if (process.argv[2] === 'materialize') {
  const codexHome = materializeCodexHome()
  console.log(`CODEX_HOME=${codexHome}`)
  console.log(`CODEX_BIN=${resolveCodex()}`)
  console.log(`RECORDER=${RECORDER}`)
  console.log(`PAYLOAD_DIR=${PAYLOAD_DIR}`)
  console.log(`EVENTS=${CODEX_INTERACTIVE_HOOK_EVENTS.join(',')}`)
  process.exit(0)
}

async function main(): Promise<void> {
  console.log(`[spike] marker=${MARKER} artifactDir=${ARTIFACT_DIR}`)
  const gmux = await ghostmuxAvailable(GMUX)
  if (!gmux.available) throw new Error(`ghostmux not available: ${gmux.reason}`)
  console.log(`[spike] ${gmux.reason}`)

  const codex = resolveCodex()
  console.log(`[spike] codex=${codex}`)
  const codexHome = materializeCodexHome()
  console.log(`[spike] CODEX_HOME=${codexHome}`)
  console.log(`[spike] hooks.json events: ${CODEX_INTERACTIVE_HOOK_EVENTS.join(', ')}`)

  // PATH so the recorder's `bun` and codex resolve inside the surface shell.
  const pathPrefix = `${join(homedir(), '.bun/bin')}:/opt/homebrew/bin:/usr/bin:/bin`
  const command = `${codex} --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox --no-alt-screen -C ${process.cwd()}`

  const newOut = await ghostmux(GMUX, [
    'new',
    '--command',
    command,
    '--title',
    'codex-hook-spike',
    '--env',
    `CODEX_HOME=${codexHome}`,
    '--env',
    `HRC_LAUNCH_HOOK_CLI=${RECORDER}`,
    '--env',
    `ASP_SPIKE_PAYLOAD_DIR=${PAYLOAD_DIR}`,
    '--env',
    `PATH=${pathPrefix}:${process.env['PATH'] ?? ''}`,
    '--json',
  ])
  if (newOut.code !== 0) throw new Error(`ghostmux new failed: ${newOut.stderr || newOut.stdout}`)
  const surfaceId = (JSON.parse(newOut.stdout) as { id?: string }).id
  if (!surfaceId) throw new Error(`no surface id: ${newOut.stdout}`)
  console.log(`[spike] surfaceId=${surfaceId}`)

  try {
    const ready = await waitForCodexReady(surfaceId, 40_000)
    const bootPane = await capturePane(GMUX, surfaceId)
    writeFileSync(join(ARTIFACT_DIR, 'pane-boot.txt'), bootPane)
    console.log(`[spike] codex ready=${ready}; boot pane saved (${bootPane.length} bytes)`)
    if (!ready) console.log('[spike] WARNING proceeding despite not-confirmed-ready; see pane-boot.txt')

    const prompt = `Run the bash command: printf '${MARKER}' — then reply with exactly ${MARKER} and nothing else.`
    console.log(`[spike] driving operator turn: ${prompt}`)
    await driveOperatorTurn(GMUX, surfaceId, prompt, ENTER_DELAY_MS)

    // Wait for a Stop payload to land (turn complete) or marker echo, with timeout.
    const deadline = Date.now() + 120_000
    let done = false
    while (Date.now() < deadline) {
      await sleep(2000)
      const files = existsSync(PAYLOAD_DIR) ? readdirSync(PAYLOAD_DIR) : []
      const sawStop = files.some((f) => f.startsWith('Stop-'))
      const pane = await capturePane(GMUX, surfaceId)
      if (sawStop) {
        console.log('[spike] Stop payload captured — turn complete')
        done = true
        break
      }
      if (pane.split(MARKER).length > 2) {
        // marker appears in both prompt and reply
        console.log('[spike] marker echoed in pane — turn likely complete, waiting for Stop')
      }
    }
    const finalPane = await capturePane(GMUX, surfaceId)
    writeFileSync(join(ARTIFACT_DIR, 'pane-final.txt'), finalPane)

    const captured = existsSync(PAYLOAD_DIR)
      ? readdirSync(PAYLOAD_DIR).filter((f) => f.endsWith('.json'))
      : []
    console.log(`[spike] done=${done}; captured ${captured.length} payload file(s):`)
    for (const f of captured.sort()) console.log(`         ${f}`)
    console.log(`[spike] CODEX_HOME left at ${codexHome} (inspect hooks.json/config.toml)`)
  } finally {
    await ghostmux(GMUX, ['kill-surface', '-t', surfaceId]).catch(() => undefined)
    if (process.env['ASP_SPIKE_KEEP_HOME'] !== '1') {
      rmSync(codexHome, { recursive: true, force: true })
    }
  }
}

await main()
