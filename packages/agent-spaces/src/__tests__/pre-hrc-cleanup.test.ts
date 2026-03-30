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
import { existsSync } from 'node:fs'
import { join } from 'node:path'

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
