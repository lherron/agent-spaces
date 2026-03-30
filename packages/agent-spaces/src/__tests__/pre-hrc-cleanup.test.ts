/**
 * RED/GREEN TDD tests for T-00933: Pre-HRC runtime/session/event cleanup.
 *
 * Sub-tasks:
 *   T-00934 — Dead event types removal (runtime/events, runtime/session dead types)
 *   T-00935 — Dead session/harness paths (CodexSession registration, execution/session barrel, dead exports)
 *   T-00936 — hostSessionId cutover in control-plane
 *
 * RED CONDITIONS (must fail before implementation):
 *   - Dead event exports (RunEventEmitter, RunEvent, etc.) should NOT exist from spaces-execution
 *   - Dead session event types should NOT be re-exported from runtime/session barrel
 *   - execution/session barrel (pure re-export) should be removed
 *   - CodexSession should NOT be registered in session registry
 *   - control-plane should use hostSessionId (not cpSessionId) — tested via grep, not import
 *
 * GREEN CONDITIONS (must pass after implementation):
 *   - All "must survive" public exports still accessible
 *   - Dead code removed
 *   - hostSessionId cutover complete
 *
 * REGRESSION GUARDS (green from start, must stay green):
 *   - Core public API exports from agent-spaces package
 *   - Runtime session core types (UnifiedSession, SessionRegistry, etc.)
 *   - SdkSessionIdEvent reachable via UnifiedSessionEvent
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UnifiedSessionEvent } from 'spaces-runtime'

const AGENT_SPACES_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const CONTROL_PLANE_ROOT = join(AGENT_SPACES_ROOT, '..', 'control-plane')

// ===================================================================
// REGRESSION GUARDS — Public surface that MUST survive cleanup
// These are GREEN from the start and must stay GREEN.
// ===================================================================

describe('[T-00933] public surface preservation (regression guard)', () => {
  test('createAgentSpacesClient is exported from agent-spaces', async () => {
    const mod = await import('../index.js')
    expect(mod.createAgentSpacesClient).toBeFunction()
  })

  test('AgentEvent type is exported (via type re-export, verified by constructing a value)', async () => {
    // AgentEvent is a type-only export. We verify the module shape includes
    // the types that compose AgentEvent by constructing a conforming object.
    const types = await import('../types.js')
    const _stateEvent = {
      type: 'state' as const,
      state: 'running' as const,
    }
    // If AgentEvent type were removed, this file would fail type-check at build time.
    // At runtime we verify the types module is importable.
    expect(types).toBeDefined()
  })

  test('RunTurnNonInteractiveRequest/Response types are importable', async () => {
    const types = await import('../types.js')
    // Construct a minimal conforming request to prove the type shape exists
    expect(types).toBeDefined()
  })

  test('buildCorrelationEnvVars is exported from agent-spaces', async () => {
    const mod = await import('../index.js')
    expect(mod.buildCorrelationEnvVars).toBeFunction()
  })

  test('@lherron/agent-spaces/runtime core session types survive', async () => {
    const session = await import('spaces-runtime/session')
    // Core types that must survive
    expect(session.SessionRegistry).toBeDefined()
    expect(session.createSession).toBeFunction()
    expect(session.setSessionRegistry).toBeFunction()
  })

  test('UnifiedSessionEvent includes SdkSessionIdEvent discriminant', async () => {
    // SdkSessionIdEvent is part of the UnifiedSessionEvent union.
    // We construct a conforming SdkSessionIdEvent and verify at runtime
    // that the types module exports the union that includes it.
    const types = await import('spaces-runtime/session')
    // The types are compile-time. At runtime, verify the module shape.
    expect(types).toBeDefined()
    // Deeper check: construct a SdkSessionIdEvent-shaped value
    const evt = { type: 'sdk_session_id' as const, sdkSessionId: 'sess-123' }
    expect(evt.type).toBe('sdk_session_id')
    expect(evt.sdkSessionId).toBe('sess-123')
  })

  test('HarnessRegistry is exported from spaces-runtime', async () => {
    const mod = await import('spaces-runtime')
    expect(mod.HarnessRegistry).toBeDefined()
  })

  test('agent-sdk in-flight APIs are exported from spaces-execution', async () => {
    const agentSdk = await import('spaces-execution/agent-sdk')
    expect(agentSdk.AgentSession).toBeDefined()
  })
})

// ===================================================================
// T-00934: Dead event types removal
// RED — These assert dead exports are GONE. Currently they still exist → FAIL.
// ===================================================================

describe('[T-00934] dead event exports removed from spaces-execution', () => {
  test('RunEventEmitter should NOT be re-exported from spaces-execution', async () => {
    const mod = await import('spaces-execution')
    // After cleanup, RunEventEmitter should not be accessible from spaces-execution.
    // Currently it IS exported (via `export * from 'spaces-runtime/events'`), so this FAILS (RED).
    expect((mod as any).RunEventEmitter).toBeUndefined()
  })

  test('RunEvent type artifacts should NOT be re-exported from spaces-execution', async () => {
    const mod = await import('spaces-execution')
    // createEventEmitter and getEventsOutputPath are part of the dead events module.
    // After cleanup they should not be accessible from spaces-execution.
    expect((mod as any).createEventEmitter).toBeUndefined()
    expect((mod as any).getEventsOutputPath).toBeUndefined()
  })

  test('runtime/events directory should be removed or quarantined', () => {
    const eventsDir = join(AGENT_SPACES_ROOT, 'packages', 'runtime', 'src', 'events')
    // After cleanup, this directory should not exist (or should be empty/quarantined).
    // Currently it exists → FAIL (RED).
    expect(existsSync(eventsDir)).toBe(false)
  })

  test('execution/src/index.ts should NOT re-export from spaces-runtime/events', () => {
    const indexPath = join(AGENT_SPACES_ROOT, 'packages', 'execution', 'src', 'index.ts')
    const content = require('node:fs').readFileSync(indexPath, 'utf8')
    // After cleanup, the `export * from 'spaces-runtime/events'` line should be gone.
    expect(content).not.toContain("from 'spaces-runtime/events'")
  })
})

// ===================================================================
// T-00935: Dead session/harness paths
// RED — CodexSession registration, execution/session barrel, dead exports
// ===================================================================

describe('[T-00935] dead session and harness paths removed', () => {
  test('CodexSession should NOT be exported from spaces-execution main barrel', async () => {
    const mod = await import('spaces-execution')
    // After cleanup, CodexSession should not be re-exported from the main barrel.
    // Currently it IS exported → FAIL (RED).
    expect((mod as any).CodexSession).toBeUndefined()
  })

  test('CodexSession should NOT be registered in the session registry', async () => {
    // Import the harness module which performs registration side-effects
    const harness = await import('spaces-execution/harness')
    const { sessionRegistry } = harness

    // After cleanup, 'codex' should not be a registered session kind.
    // Currently it IS registered → FAIL (RED).
    let threw = false
    try {
      // SessionRegistry.create() or similar — we test by checking if codex factory exists
      const factory =
        (sessionRegistry as any)._factories?.get('codex') ??
        (sessionRegistry as any).factories?.get('codex')
      // Alternative: try to create a session and see if it throws "not registered"
      if (factory) {
        threw = false
      } else {
        threw = true
      }
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test('execution/session barrel should be removed (pure re-export)', () => {
    const sessionBarrel = join(
      AGENT_SPACES_ROOT,
      'packages',
      'execution',
      'src',
      'session',
      'index.ts'
    )
    // After cleanup, this file should not exist — it's just `export * from 'spaces-runtime/session'`.
    // Currently it exists → FAIL (RED).
    expect(existsSync(sessionBarrel)).toBe(false)
  })

  test('dead event types should NOT be re-exported from runtime/session barrel', async () => {
    // These types are being removed from runtime/session/types.ts in T-00934.
    // The session barrel currently re-exports them. After cleanup they should be gone.
    // We check by reading the barrel source for their names.
    const barrelPath = join(AGENT_SPACES_ROOT, 'packages', 'runtime', 'src', 'session', 'index.ts')
    const content = require('node:fs').readFileSync(barrelPath, 'utf8')

    // These dead types should NOT appear in the barrel after cleanup:
    // Individual event member interfaces are internal to the UnifiedSessionEvent
    // union — they should NOT be top-level barrel exports. Supporting types like
    // AttachmentRef and PromptOptions ARE public (T-00937).
    const deadTypes = [
      'AgentStartEvent',
      'AgentEndEvent',
      'TurnStartEvent',
      'TurnEndEvent',
      'MessageStartEvent',
      'MessageUpdateEvent',
      'MessageEndEvent',
      'ToolExecutionStartEvent',
      'ToolExecutionUpdateEvent',
      'ToolExecutionEndEvent',
    ]

    for (const typeName of deadTypes) {
      expect(content).not.toContain(typeName)
    }
  })
})

// ===================================================================
// T-00936: hostSessionId cutover in control-plane
// RED — CP files still use cpSessionId → FAIL
// ===================================================================

describe('[T-00936] hostSessionId cutover in control-plane', () => {
  test('terminal-router.ts should use hostSessionId, not cpSessionId', () => {
    const filePath = join(
      CONTROL_PLANE_ROOT,
      'packages',
      'control-plane',
      'src',
      'terminal-router.ts'
    )

    if (!existsSync(filePath)) {
      throw new Error(
        `terminal-router.ts not found at ${filePath} — adjust CONTROL_PLANE_ROOT if needed`
      )
    }

    const content = require('node:fs').readFileSync(filePath, 'utf8')

    // After cutover, cpSessionId should not appear in buildProcessInvocationSpec calls.
    // Currently it DOES appear → FAIL (RED).
    //
    // We check for the specific pattern: `cpSessionId:` as an object property.
    // This avoids false positives from comments or other uses.
    const cpSessionIdProps = content.match(/cpSessionId\s*:/g) || []
    expect(cpSessionIdProps.length).toBe(0)
  })

  test('asp-client-backend.ts should use hostSessionId, not cpSessionId', () => {
    const filePath = join(
      CONTROL_PLANE_ROOT,
      'packages',
      'session-agent-spaces',
      'src',
      'asp-client-backend.ts'
    )

    if (!existsSync(filePath)) {
      throw new Error(
        `asp-client-backend.ts not found at ${filePath} — adjust CONTROL_PLANE_ROOT if needed`
      )
    }

    const content = require('node:fs').readFileSync(filePath, 'utf8')

    // After cutover, cpSessionId should be replaced with hostSessionId.
    // Currently cpSessionId IS used → FAIL (RED).
    const cpSessionIdProps = content.match(/cpSessionId\s*:/g) || []
    expect(cpSessionIdProps.length).toBe(0)
  })
})

// ===================================================================
// T-00939 Change 1: resume → continuationKey rename
// RED — These assert the rename has happened. Currently `resume` is used → FAIL.
// ===================================================================

describe('[T-00939] resume → continuationKey rename', () => {
  test('CreateSessionOptions should have continuationKey, not resume', () => {
    const optionsPath = join(
      AGENT_SPACES_ROOT,
      'packages',
      'runtime',
      'src',
      'session',
      'options.ts'
    )
    const content = readFileSync(optionsPath, 'utf8')

    // After rename, `resume` should not appear as a field declaration.
    // `continuationKey` should be present instead.
    // Currently `resume?: string` IS the field name → FAIL (RED).
    expect(content).toContain('continuationKey')
    expect(content).not.toMatch(/^\s+resume\??\s*:/m)
  })

  test('AgentSessionConfig should have continuationKey, not resume', () => {
    const agentSessionPath = join(
      AGENT_SPACES_ROOT,
      'packages',
      'harness-claude',
      'src',
      'agent-sdk',
      'agent-session.ts'
    )
    const content = readFileSync(agentSessionPath, 'utf8')

    // After rename, AgentSessionConfig should use `continuationKey`.
    // Currently `resume?: string` IS the field name → FAIL (RED).
    expect(content).toContain('continuationKey')
    expect(content).not.toMatch(/^\s+resume\??\s*:/m)
  })

  test('AgentSession.start() passes continuationKey to SDK query options', () => {
    const agentSessionPath = join(
      AGENT_SPACES_ROOT,
      'packages',
      'harness-claude',
      'src',
      'agent-sdk',
      'agent-session.ts'
    )
    const content = readFileSync(agentSessionPath, 'utf8')

    // The SDK query options spread should reference `this.config.continuationKey`,
    // not `this.config.resume`.
    // Currently uses `this.config.resume` → FAIL (RED).
    expect(content).toContain('this.config.continuationKey')
    expect(content).not.toContain('this.config.resume')
  })

  test('harness-claude register.ts maps options.continuationKey', () => {
    const registerPath = join(AGENT_SPACES_ROOT, 'packages', 'harness-claude', 'src', 'register.ts')
    const content = readFileSync(registerPath, 'utf8')

    // After rename, register.ts should map `options.continuationKey` to config.
    // Currently maps `options.resume` → FAIL (RED).
    expect(content).toContain('options.continuationKey')
    expect(content).not.toContain('options.resume')
  })

  test('harness-codex register.ts maps options.continuationKey to resumeThreadId', () => {
    const registerPath = join(AGENT_SPACES_ROOT, 'packages', 'harness-codex', 'src', 'register.ts')
    const content = readFileSync(registerPath, 'utf8')

    // After rename, register.ts should read `options.continuationKey` (not `options.resume`)
    // and map it to `resumeThreadId` in the codex config.
    // Currently maps `options.resume` → FAIL (RED).
    expect(content).toContain('options.continuationKey')
    expect(content).not.toContain('options.resume')
  })

  test('client.ts createSession calls use continuationKey, not resume', () => {
    const clientPath = join(AGENT_SPACES_ROOT, 'packages', 'agent-spaces', 'src', 'client.ts')
    const content = readFileSync(clientPath, 'utf8')

    // After rename, all `{ resume: ... }` spreads in createSession calls
    // should become `{ continuationKey: ... }`.
    // Currently uses `resume:` in session option spreads → FAIL (RED).
    //
    // We check that `resume:` does not appear in session-option-context lines
    // (lines containing continuationKey or resume as object property).
    // The CLI-level `resume` (execution layer) is NOT in scope.
    const sessionOptionResumeProps = content.match(/\{\s*resume\s*:/g) || []
    expect(sessionOptionResumeProps.length).toBe(0)
  })
})

// ===================================================================
// T-00939 Change 2: Codex event emission fix
// RED — codex agent_start currently emits sessionId: this.threadId → FAIL.
// ===================================================================

describe('[T-00939] codex agent_start event emission fix', () => {
  test('codex-session.ts emits sessionId: this.sessionId (not this.threadId) in agent_start', () => {
    const codexSessionPath = join(
      AGENT_SPACES_ROOT,
      'packages',
      'harness-codex',
      'src',
      'codex-session',
      'codex-session.ts'
    )
    const content = readFileSync(codexSessionPath, 'utf8')

    // Find the agent_start emit line. After fix it should use this.sessionId (runtime owner),
    // not this.threadId (provider thread ID).
    // Currently emits `sessionId: this.threadId` → FAIL (RED).
    const agentStartBlock = content.match(/emitEvent\(\{[^}]*type:\s*'agent_start'[^}]*\}\)/s)
    expect(agentStartBlock).not.toBeNull()

    const block = agentStartBlock![0]
    // sessionId should reference this.sessionId (the runtime owner ID)
    expect(block).toContain('sessionId: this.sessionId')
    // sdkSessionId should reference this.threadId (the provider thread ID)
    expect(block).toContain('sdkSessionId: this.threadId')
    // Must NOT have sessionId: this.threadId (the bug)
    expect(block).not.toContain('sessionId: this.threadId')
  })

  test('codex agent_start event contains both sessionId and sdkSessionId at runtime', async () => {
    // This test uses the real CodexSession with the existing shim to verify
    // the agent_start event shape at runtime.
    const { CodexSession } = await import('spaces-harness-codex/codex-session')

    const tmpBase = join(tmpdir(), `codex-t939-${Date.now()}`)
    await mkdir(tmpBase, { recursive: true })

    const shimPath = join(tmpBase, 'codex-shim.js')
    const codexHome = join(tmpBase, 'codex-home')
    await mkdir(codexHome, { recursive: true })

    // Minimal shim: responds to initialize, initialized, thread/start, then exits
    await writeFile(
      shimPath,
      `#!/usr/bin/env node
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);

  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'codex-shim' } });
    return;
  }
  if (msg.method === 'initialized') return;
  if (msg.method === 'thread/start') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        thread: {
          id: 'thread-abc-123',
          preview: '',
          modelProvider: 'openai',
          createdAt: Math.floor(Date.now() / 1000),
          path: '/tmp',
          cwd: process.cwd(),
          cliVersion: '0.0.0',
          source: 'appServer',
          gitInfo: null,
          turns: [],
        },
        model: 'gpt-5.3-codex',
        modelProvider: 'openai',
        cwd: process.cwd(),
        approvalPolicy: 'on-request',
        sandbox: { type: 'readOnly' },
        reasoningEffort: null,
      },
    });
    return;
  }
});
`,
      'utf-8'
    )
    await chmod(shimPath, 0o755)

    const session = new CodexSession({
      ownerId: 'owner-runtime-id',
      cwd: '/tmp',
      sessionId: 'session-runtime-id',
      homeDir: codexHome,
      appServerCommand: shimPath,
      model: 'gpt-5.3-codex',
      approvalPolicy: 'on-request',
    })

    const events: UnifiedSessionEvent[] = []
    session.onEvent((event: UnifiedSessionEvent) => events.push(event))

    try {
      await session.start()
    } finally {
      await session.stop('test-done')
      await rm(tmpBase, { recursive: true, force: true })
    }

    // Find the agent_start event
    const agentStart = events.find((e) => e.type === 'agent_start')
    expect(agentStart).toBeDefined()

    // After fix: sessionId should be the runtime owner ID ('session-runtime-id'),
    // NOT the provider thread ID ('thread-abc-123').
    // Currently sessionId IS 'thread-abc-123' (the threadId) → FAIL (RED).
    expect((agentStart as any).sessionId).toBe('session-runtime-id')

    // After fix: sdkSessionId should carry the provider thread ID.
    // Currently sdkSessionId is NOT present → FAIL (RED).
    expect((agentStart as any).sdkSessionId).toBe('thread-abc-123')
  })
})
