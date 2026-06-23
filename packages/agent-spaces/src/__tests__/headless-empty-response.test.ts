/**
 * Regression test for T-01216: headless agent-sdk runs silently reporting
 * `success: true` when the child process produces no assistant output.
 *
 * Source-inspection tests are the convention in this package for
 * runPlacementTurnNonInteractive since the function pulls in the full
 * placement/session/harness pipeline and integration-level mocking is
 * costly. We assert the critical guard and logging hooks exist.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const runPlacementTurnSrc = readFileSync(resolve(__dirname, '..', 'run-placement-turn.ts'), 'utf8')

// Narrow named-region helper: bound runPlacementTurnNonInteractive by its
// declaration to EOF (it is the only top-level function in the file) rather than
// greedily scanning to the first column-0 brace, so the empty-response guard
// assertion stays scoped without pinning the whole body.
function fnRegion(source: string, startMarker: string): string | undefined {
  const start = source.indexOf(startMarker)
  return start === -1 ? undefined : source.slice(start)
}
const RUN_PLACEMENT_TURN_DECL = 'export async function runPlacementTurnNonInteractive'

const sessionSrc = readFileSync(
  resolve(__dirname, '..', '..', '..', 'harness-claude', 'src', 'agent-sdk', 'agent-session.ts'),
  'utf8'
)

describe('T-01216 empty_response guard', () => {
  test('runPlacementTurnNonInteractive guards against no-content success', () => {
    const runFn = fnRegion(runPlacementTurnSrc, RUN_PLACEMENT_TURN_DECL)
    expect(runFn).toBeDefined()
    // After the happy-path assembly of finalOutput, there must be a guard
    // that demotes the result to success:false when neither finalOutput
    // nor assistantState.assistantBuffer captured content.
    expect(runFn).toMatch(/producedContent/)
    expect(runFn).toMatch(/'empty_response'/)
  })

  test("AgentSpacesError union accepts 'empty_response'", () => {
    const typesSrc = readFileSync(resolve(__dirname, '..', 'types.ts'), 'utf8')
    expect(typesSrc).toMatch(/'empty_response'/)
  })
})

describe('T-01216 AgentSession resilience', () => {
  test('stop() tolerates a dead child (ProcessTransport not ready)', () => {
    // The interrupt() call inside stop() must not surface the dead-child
    // error to callers — it's expected whenever the turn's child exited
    // before stop() runs (e.g. crashed with code 1 mid-turn).
    const stopFn = sessionSrc.match(/async stop\(reason\?: string\)[\s\S]*?^ {2}\}/m)?.[0]
    expect(stopFn).toBeDefined()
    expect(stopFn).toMatch(/ProcessTransport is not ready/)
  })

  test('listenToOutput flushes pending turn_end on crash and clean exit', () => {
    // Both the catch and finally blocks must drain pendingTurnIds so that
    // awaiters of turnPromise in runPlacementTurnNonInteractive never hang
    // when the SDK iterator ends without a terminal result message. The drain
    // loop is factored into flushPendingTurns(); assert it is invoked from both
    // paths (once in catch, once in finally) and that the helper drains the queue.
    const listenFn = sessionSrc.match(/private async listenToOutput\(\)[\s\S]*?^ {2}\}/m)?.[0]
    expect(listenFn).toBeDefined()
    const flushCalls = listenFn?.match(/this\.flushPendingTurns\(\)/g) ?? []
    expect(flushCalls.length).toBeGreaterThanOrEqual(2)
    const flushFn = sessionSrc.match(/private flushPendingTurns\(\)[\s\S]*?^ {2}\}/m)?.[0]
    expect(flushFn).toBeDefined()
    expect(flushFn).toMatch(/while \(this\.pendingTurnIds\.length > 0\)/)
  })

  test('session.start logs structured diagnostics', () => {
    const startFn = sessionSrc.match(/async start\(\): Promise<void>[\s\S]*?^ {2}\}/m)?.[0]
    expect(startFn).toBeDefined()
    expect(startFn).toMatch(/\[agent-sdk\] session\.start/)
    expect(startFn).toMatch(/resume=/)
    expect(startFn).toMatch(/plugins=/)
  })

  test('listenToOutput failure is logged with diagnostic context', () => {
    const listenFn = sessionSrc.match(/private async listenToOutput\(\)[\s\S]*?^ {2}\}/m)?.[0]
    expect(listenFn).toBeDefined()
    expect(listenFn).toMatch(/listenToOutput failed/)
    expect(listenFn).toMatch(/pendingTurns=/)
    expect(listenFn).toMatch(/lastResponseLen=/)
  })
})
