/**
 * The desktop cutover half of the Codex overlay (campaign P-00502 leg D).
 *
 * These cases exist because the failure they guard is silent in every direction
 * that matters. The generated hooks are strings produced by a template inside
 * another template: a mis-escaped interpolation still WRITES a file, Codex still
 * runs it, and the only symptom is a hook that quietly does nothing in front of
 * a turn — which is indistinguishable from a conversation that is simply not
 * registered yet. So each case runs the REAL generated script through node with
 * a real hook payload, rather than asserting on the source that produced it.
 *
 * The helper is stubbed on PATH, not mocked in-process, because the seam under
 * test IS the spawn: env plumbing, stdin framing, and the bounded wait.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { syncAgentToCodexDefault } from './sync-agent-to-codex-default'

const NATIVE_THREAD_ID = '01a08138-7d09-7e12-b8ba-d82b744d9a1e'
const CANONICAL_SCOPE = 'agent:stella:project:hrc-ios:task:primary-nova'

type Overlay = {
  root: string
  codexHome: string
  preToolUse: string
  discovery: string
  binDir: string
  cacheDir: string
}

/** Materialize the overlay into a throwaway Codex home, hooks and all. */
async function buildOverlay(): Promise<Overlay> {
  const root = await mkdtemp(join(tmpdir(), 'codex-desktop-hooks-'))
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
  const binDir = join(root, 'bin')
  const cacheDir = join(root, 'cache')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(cacheDir, { recursive: true })
  return {
    root,
    codexHome,
    preToolUse: join(codexHome, '.asp-agent-sync', 'pre-tool-use-praesidium-env.mjs'),
    discovery: join(codexHome, '.asp-agent-sync', 'desktop-registration-discovery.mjs'),
    binDir,
    cacheDir,
  }
}

/**
 * A stand-in for HRC's installed helper.
 *
 * `mode` selects the three answers the overlay must survive: a registration,
 * a daemon that is not there, and a helper that never returns.
 */
function installHelperStub(overlay: Overlay, mode: 'registered' | 'pending' | 'hang'): void {
  const path = join(overlay.binDir, 'hrc-desktop-hook')
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
const raw = readFileSync(0, 'utf8')
const dir = process.env.HRC_DESKTOP_CACHE_DIR
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'helper-invocation.json'), JSON.stringify({
  stdin: JSON.parse(raw || '{}'),
  legacyScopeRef: process.env.HRC_DESKTOP_LEGACY_SCOPE_REF,
  callbackSocket: process.env.HRC_CALLBACK_SOCKET,
  spoolDir: process.env.HRC_SPOOL_DIR,
}))
if (${JSON.stringify(mode)} === 'hang') { setInterval(() => {}, 1000); }
else if (${JSON.stringify(mode)} === 'pending') {
  process.stdout.write(JSON.stringify({ status: 'integration_pending', reason: 'hrc_unreachable', detail: '' }) + '\\n')
} else {
  const cache = {
    scopeRef: ${JSON.stringify(CANONICAL_SCOPE)},
    agentId: 'stella', projectId: 'hrc-ios', slotToken: 'primary-nova', laneRef: 'main',
    hostSessionId: 'hsid-test', nativeThreadId: JSON.parse(raw).session_id,
    homeIdentity: '/Users/lherron/.codex', projectRoot: '/Users/lherron/praesidium/clients/hrc-ios',
    registeredAt: '2026-09-08T18:31:10.820Z', cachedAt: new Date().toISOString(),
  }
  writeFileSync(join(dir, cache.nativeThreadId + '.json'), JSON.stringify(cache))
  process.stdout.write(JSON.stringify({ status: 'registered', source: 'hrc', cache }) + '\\n')
}
`,
    { mode: 0o755 }
  )
  chmodSync(path, 0o755)
}

function runHook(
  overlay: Overlay,
  script: string,
  payload: object,
  options: { cacheDir?: string; timeoutMs?: number } = {}
): { stdout: string; ms: number } {
  const started = Date.now()
  const result = spawnSync('node', [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30_000,
    env: {
      ...process.env,
      PATH: `${overlay.binDir}:${process.env['PATH'] ?? ''}`,
      HRC_DESKTOP_CACHE_DIR: options.cacheDir ?? overlay.cacheDir,
      CODEX_HOME: overlay.codexHome,
    },
  })
  return { stdout: result.stdout ?? '', ms: Date.now() - started }
}

function hookContext(stdout: string): string {
  if (stdout.trim().length === 0) return ''
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: { additionalContext?: string; updatedInput?: { command?: string } }
  }
  return parsed.hookSpecificOutput?.additionalContext ?? ''
}

function injectedCommand(stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: { updatedInput?: { command?: string } }
  }
  return parsed.hookSpecificOutput?.updatedInput?.command ?? ''
}

const sessionStart = {
  hook_event_name: 'SessionStart',
  source: 'startup',
  session_id: NATIVE_THREAD_ID,
  transcript_path: `/Users/lherron/.codex/sessions/rollout-${NATIVE_THREAD_ID}.jsonl`,
  cwd: '/Users/lherron/praesidium/clients/hrc-ios',
}

describe('codex desktop registration discovery hook', () => {
  test('both generated hook scripts are executable JavaScript', async () => {
    const overlay = await buildOverlay()
    try {
      for (const script of [overlay.preToolUse, overlay.discovery]) {
        const check = spawnSync('node', ['--check', script], { encoding: 'utf8' })
        expect({ script, status: check.status, stderr: check.stderr }).toEqual({
          script,
          status: 0,
          stderr: '',
        })
      }
    } finally {
      await rm(overlay.root, { recursive: true, force: true })
    }
  })

  test('SessionStart registers, caches the scope, and reports the readable address', async () => {
    const overlay = await buildOverlay()
    try {
      installHelperStub(overlay, 'registered')
      const { stdout } = runHook(overlay, overlay.discovery, sessionStart)
      expect(hookContext(stdout)).toContain(CANONICAL_SCOPE)

      // The helper received desktop's own evidence, the internal socket, and the
      // legacy address — never an instruction about what the name should be.
      const seen = JSON.parse(
        readFileSync(join(overlay.cacheDir, 'helper-invocation.json'), 'utf8')
      ) as {
        stdin: Record<string, unknown>
        legacyScopeRef: string
        callbackSocket: string
        spoolDir: string
      }
      expect(seen.stdin['session_id']).toBe(NATIVE_THREAD_ID)
      expect(seen.stdin['transcript_path']).toBe(sessionStart.transcript_path)
      expect(seen.stdin['source']).toBe('startup')
      expect(seen.legacyScopeRef).toContain(`task:codex-${NATIVE_THREAD_ID}`)
      expect(seen.callbackSocket).toContain('/var/run/hrc/hrc.sock')
      expect(seen.spoolDir).toContain('/var/run/hrc/spool')
      expect(existsSync(join(overlay.cacheDir, `${NATIVE_THREAD_ID}.json`))).toBe(true)
    } finally {
      await rm(overlay.root, { recursive: true, force: true })
    }
  })

  test('UserPromptSubmit is the fallback for an already-open conversation', async () => {
    const overlay = await buildOverlay()
    try {
      installHelperStub(overlay, 'registered')
      const { stdout } = runHook(overlay, overlay.discovery, {
        hook_event_name: 'UserPromptSubmit',
        session_id: NATIVE_THREAD_ID,
        transcript_path: sessionStart.transcript_path,
        cwd: sessionStart.cwd,
      })
      expect(hookContext(stdout)).toContain(CANONICAL_SCOPE)
      const seen = JSON.parse(
        readFileSync(join(overlay.cacheDir, 'helper-invocation.json'), 'utf8')
      ) as { stdin: Record<string, unknown> }
      // The hook source desktop did not supply is the one this event IS.
      expect(seen.stdin['source']).toBe('user-prompt-submit')
    } finally {
      await rm(overlay.root, { recursive: true, force: true })
    }
  })

  test('an unreachable daemon reports integration pending and mints no name', async () => {
    const overlay = await buildOverlay()
    try {
      installHelperStub(overlay, 'pending')
      const { stdout } = runHook(overlay, overlay.discovery, sessionStart)
      const context = hookContext(stdout)
      expect(context).toContain('integration pending')
      expect(context).not.toContain('primary-')
      expect(existsSync(join(overlay.cacheDir, `${NATIVE_THREAD_ID}.json`))).toBe(false)
    } finally {
      await rm(overlay.root, { recursive: true, force: true })
    }
  })

  test('a helper that never returns is killed, and the turn proceeds', async () => {
    const overlay = await buildOverlay()
    try {
      installHelperStub(overlay, 'hang')
      const { stdout, ms } = runHook(overlay, overlay.discovery, sessionStart, {
        timeoutMs: 20_000,
      })
      // The bound is 4s inside the hook; anything near the node-level timeout
      // would mean the hook is holding the turn rather than releasing it.
      expect(ms).toBeLessThan(12_000)
      expect(hookContext(stdout)).toContain('integration pending')
    } finally {
      await rm(overlay.root, { recursive: true, force: true })
    }
  })
})

describe('codex desktop command env injection', () => {
  test('an established registration supplies the canonical Stella identity', async () => {
    const overlay = await buildOverlay()
    try {
      installHelperStub(overlay, 'registered')
      runHook(overlay, overlay.discovery, sessionStart)

      const { stdout } = runHook(overlay, overlay.preToolUse, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        session_id: NATIVE_THREAD_ID,
        cwd: sessionStart.cwd,
        tool_input: { command: 'wrkc say T-08296 --to clod -' },
      })
      const command = injectedCommand(stdout)
      expect(command).toContain(`ASP_SCOPE_REF='${CANONICAL_SCOPE}'`)
      expect(command).toContain("ASP_PROJECT='hrc-ios'")
      expect(command).toContain("ASP_TASK_ID='primary-nova'")
      expect(hookContext(stdout)).toContain('HRC registration: established')
    } finally {
      await rm(overlay.root, { recursive: true, force: true })
    }
  })

  test('wrkc and wrkp are injected, closing the allowlist gap that broke replies', async () => {
    const overlay = await buildOverlay()
    try {
      installHelperStub(overlay, 'registered')
      runHook(overlay, overlay.discovery, sessionStart)
      for (const command of ['wrkc inbox', 'wrkp status', 'wrkq ls']) {
        const { stdout } = runHook(overlay, overlay.preToolUse, {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          session_id: NATIVE_THREAD_ID,
          cwd: sessionStart.cwd,
          tool_input: { command },
        })
        expect({ command, injected: injectedCommand(stdout).includes('ASP_SCOPE_REF=') }).toEqual({
          command,
          injected: true,
        })
      }
      // The control: an unrelated command is still left alone.
      const untouched = runHook(overlay, overlay.preToolUse, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        session_id: NATIVE_THREAD_ID,
        cwd: sessionStart.cwd,
        tool_input: { command: 'ls -la' },
      })
      expect(untouched.stdout.trim()).toBe('')
    } finally {
      await rm(overlay.root, { recursive: true, force: true })
    }
  })

  test('before registration the previous UUID-style address is retained unchanged', async () => {
    const overlay = await buildOverlay()
    try {
      const { stdout } = runHook(
        overlay,
        overlay.preToolUse,
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          session_id: NATIVE_THREAD_ID,
          cwd: sessionStart.cwd,
          tool_input: { command: 'wrkq ls' },
        },
        { cacheDir: join(overlay.root, 'no-cache') }
      )
      const command = injectedCommand(stdout)
      expect(command).toContain(`ASP_TASK_ID='codex-${NATIVE_THREAD_ID}'`)
      expect(command).not.toContain('primary-nova')
      expect(hookContext(stdout)).toContain('HRC registration: pending')
    } finally {
      await rm(overlay.root, { recursive: true, force: true })
    }
  })
})

describe('managed hook installation preserves what it does not own', () => {
  test('installs both discovery events, keeps foreign hooks, and is idempotent', async () => {
    const overlay = await buildOverlay()
    try {
      const hooksPath = join(overlay.codexHome, 'hooks.json')
      const withForeign = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
        hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>
      }
      withForeign.hooks['SessionStart'].push({
        matcher: '',
        hooks: [{ command: 'echo lance-owned' }],
      })
      withForeign.hooks['Stop'] = [{ matcher: '', hooks: [{ command: 'echo lance-stop' }] }]
      writeFileSync(hooksPath, JSON.stringify(withForeign, null, 2))

      await syncAgentToCodexDefault({
        agentId: 'stella',
        codexHome: overlay.codexHome,
        aspHome: join(overlay.root, 'asp-home'),
        agentsRoot: join(overlay.root, 'agents'),
        projectRoot: join(overlay.root, 'project'),
        apply: true,
        fetchRegistry: false,
        installHooks: true,
      })

      const after = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
      }
      const commandsFor = (event: string): string[] =>
        (after.hooks[event] ?? []).flatMap((group) => group.hooks.map((hook) => hook.command))

      expect(commandsFor('SessionStart').filter((c) => c.includes('discovery'))).toHaveLength(1)
      expect(commandsFor('UserPromptSubmit').filter((c) => c.includes('discovery'))).toHaveLength(1)
      expect(commandsFor('PreToolUse').filter((c) => c.includes('pre-tool-use'))).toHaveLength(1)
      // Unmanaged handlers survive a re-sync, on a shared event and on its own.
      expect(commandsFor('SessionStart')).toContain('echo lance-owned')
      expect(commandsFor('Stop')).toContain('echo lance-stop')
    } finally {
      await rm(overlay.root, { recursive: true, force: true })
    }
  })
})
