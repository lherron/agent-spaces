/**
 * The self-join half of the Codex overlay (campaign P-00521 T-08594).
 *
 * The discovery hook no longer calls HRC. It resolves the active ASP release
 * at hook run time and spawns `harness-broker desktop-join` detached. Each
 * case runs the REAL generated script through node with a real hook payload:
 * the seam under test is the spawn (release resolution, argv, detach, exit).
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { syncAgentToCodexDefault } from './sync-agent-to-codex-default'

const THREAD_ID = '0199abcd-1234-5678-9abc-def012345678'

async function buildOverlay(): Promise<{ codexHome: string; discovery: string }> {
  const root = await mkdtemp(join(tmpdir(), 'codex-self-join-'))
  const codexHome = join(root, 'codex-home')
  const agentsRoot = join(root, 'agents')
  const agentRoot = join(agentsRoot, 'stella')
  mkdirSync(agentRoot, { recursive: true })
  writeFileSync(join(agentRoot, 'SOUL.md'), '# Stella\n')
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    ['version = 3', '', '[spaces]', 'base = []', ''].join('\n')
  )
  await syncAgentToCodexDefault({
    agentId: 'stella',
    codexHome,
    aspHome: join(root, 'asp-home'),
    agentsRoot,
    projectRoot: join(root, 'project'),
    apply: true,
    fetchRegistry: false,
    installHooks: true,
  })
  return {
    codexHome,
    discovery: join(codexHome, '.asp-agent-sync', 'desktop-registration-discovery.mjs'),
  }
}

function installRelease(
  root: string,
  releaseId: string
): { activeJson: string; brokerBin: string; seenFile: string } {
  const releasePath = join(root, 'releases', releaseId)
  mkdirSync(releasePath, { recursive: true })
  const brokerBin = join(releasePath, 'harness-broker')
  const seenFile = join(root, 'spawned-argv.json')
  writeFileSync(
    brokerBin,
    `#!/usr/bin/env node\nconst fs = require('node:fs')\nfs.appendFileSync(${JSON.stringify(seenFile)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + '\\n')\nsetInterval(() => {}, 1000)\n`
  )
  chmodSync(brokerBin, 0o755)
  writeFileSync(
    join(releasePath, 'release.json'),
    JSON.stringify({ schemaVersion: 'asp-standalone-release/v1', releaseId })
  )
  const activeJson = join(root, 'service', 'active.json')
  mkdirSync(join(root, 'service'), { recursive: true })
  writeFileSync(
    activeJson,
    JSON.stringify({ schemaVersion: 'aspd-service-activation/v1', releaseId, releasePath })
  )
  return { activeJson, brokerBin, seenFile }
}

function sessionStartPayload() {
  return {
    hook_event_name: 'SessionStart',
    session_id: THREAD_ID,
    transcript_path: join(tmpdir(), 'rollout.jsonl'),
    cwd: tmpdir(),
    source: 'startup',
  }
}

function runDiscovery(
  discovery: string,
  codexHome: string,
  stdin: string,
  extraEnv: Record<string, string> = {}
) {
  const startedAt = Date.now()
  const result = spawnSync('node', [discovery], {
    input: stdin,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, CODEX_HOME: codexHome, ...extraEnv },
  })
  return { result, elapsedMs: Date.now() - startedAt }
}

function spawnedPids(seenFile: string): number[] {
  for (let i = 0; i < 30; i++) {
    if (existsSync(seenFile)) break
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  if (!existsSync(seenFile)) return []
  const pids: number[] = []
  for (const line of readFileSync(seenFile, 'utf8').trim().split('\n').filter(Boolean)) {
    const pid = (JSON.parse(line) as { pid: number }).pid
    if (Number.isInteger(pid) && !pids.includes(pid)) pids.push(pid)
  }
  return pids
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Reap every stub broker a test spawned and prove none outlives the test.
 * Called in a finally so a failing assertion cannot leak a lingering
 * detached child into $TMPDIR (or max3, under a suite rerun).
 */
function reapSpawned(seenFile: string): void {
  const survivors: number[] = []
  for (const pid of spawnedPids(seenFile)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
    for (let i = 0; i < 50 && pidAlive(pid); i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
    if (pidAlive(pid)) survivors.push(pid)
  }
  expect(survivors).toEqual([])
}

describe('desktop self-join discovery hook', () => {
  test('SessionStart spawns desktop-join detached, exits 0 fast, broker outlives the hook', async () => {
    const overlay = await buildOverlay()
    const root = await mkdtemp(join(tmpdir(), 'self-join-release-'))
    const release = installRelease(root, 'asp-test-1')
    try {
      const { result, elapsedMs } = runDiscovery(
        overlay.discovery,
        overlay.codexHome,
        JSON.stringify(sessionStartPayload()),
        { ASPD_ACTIVE_JSON: release.activeJson }
      )
      expect(result.status).toBe(0)
      expect(elapsedMs).toBeLessThan(4000)
      expect(result.stdout).toBe('')
      const pids = spawnedPids(release.seenFile)
      expect(pids.length).toBeGreaterThan(0)
      for (const pid of pids) expect(pidAlive(pid)).toBe(true)
      const seen = JSON.parse(
        readFileSync(release.seenFile, 'utf8').trim().split('\n').filter(Boolean).pop() as string
      ) as { argv: string[] }
      expect(seen.argv[0]).toBe('desktop-join')
      expect(seen.argv).toContain('--thread')
      expect(seen.argv).toContain(THREAD_ID)
    } finally {
      reapSpawned(release.seenFile)
    }
  })

  test('UserPromptSubmit also spawns (the respawn fallback)', async () => {
    const overlay = await buildOverlay()
    const root = await mkdtemp(join(tmpdir(), 'self-join-release-'))
    const release = installRelease(root, 'asp-test-1')
    try {
      const { result } = runDiscovery(
        overlay.discovery,
        overlay.codexHome,
        JSON.stringify({
          ...sessionStartPayload(),
          hook_event_name: 'UserPromptSubmit',
          source: 'user-prompt-submit',
        }),
        { ASPD_ACTIVE_JSON: release.activeJson }
      )
      expect(result.status).toBe(0)
      const pids = spawnedPids(release.seenFile)
      expect(pids.length).toBeGreaterThan(0)
      for (const pid of pids) expect(pidAlive(pid)).toBe(true)
    } finally {
      reapSpawned(release.seenFile)
    }
  })

  test('absent activation spawns nothing, exits 0, names it in join.log', async () => {
    const overlay = await buildOverlay()
    const { result } = runDiscovery(
      overlay.discovery,
      overlay.codexHome,
      JSON.stringify(sessionStartPayload()),
      { ASPD_ACTIVE_JSON: join(tmpdir(), 'no-such-active.json') }
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    const joinLog = join(overlay.codexHome, 'hrc-desktop', THREAD_ID, 'join.log')
    expect(existsSync(joinLog)).toBe(true)
    expect(readFileSync(joinLog, 'utf8')).toMatch(/no-active-release|activation-unreadable/)
  })

  test('release mismatch spawns nothing and logs the mismatch', async () => {
    const overlay = await buildOverlay()
    const root = await mkdtemp(join(tmpdir(), 'self-join-release-'))
    const release = installRelease(root, 'asp-test-1')
    writeFileSync(
      release.activeJson,
      JSON.stringify({
        schemaVersion: 'aspd-service-activation/v1',
        releaseId: 'asp-test-2',
        releasePath: join(root, 'releases', 'asp-test-1'),
      })
    )
    const { result } = runDiscovery(
      overlay.discovery,
      overlay.codexHome,
      JSON.stringify(sessionStartPayload()),
      { ASPD_ACTIVE_JSON: release.activeJson }
    )
    expect(result.status).toBe(0)
    expect(existsSync(release.seenFile)).toBe(false)
    const joinLog = join(overlay.codexHome, 'hrc-desktop', THREAD_ID, 'join.log')
    expect(readFileSync(joinLog, 'utf8')).toMatch(/release-mismatch/)
  })

  test('malformed stdin is the only exit-1', async () => {
    const overlay = await buildOverlay()
    const root = await mkdtemp(join(tmpdir(), 'self-join-release-'))
    const release = installRelease(root, 'asp-test-1')
    const bad = runDiscovery(overlay.discovery, overlay.codexHome, 'not-json{{{', {
      ASPD_ACTIVE_JSON: release.activeJson,
    })
    expect(bad.result.status).toBe(1)
    const empty = runDiscovery(overlay.discovery, overlay.codexHome, '', {
      ASPD_ACTIVE_JSON: release.activeJson,
    })
    expect(empty.result.status).toBe(0)
    const other = runDiscovery(
      overlay.discovery,
      overlay.codexHome,
      JSON.stringify({ hook_event_name: 'PreToolUse', session_id: THREAD_ID }),
      { ASPD_ACTIVE_JSON: release.activeJson }
    )
    expect(other.result.status).toBe(0)
    expect(existsSync(release.seenFile)).toBe(false)
  })
})
