/**
 * Regression test for T-01216: headless agent-sdk runs silently reporting
 * `success: true` when the child process produces no assistant output.
 * Source-inspection tests assert the AgentSession guard and logging hooks.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sessionSrc = readFileSync(
  resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'drivers',
    'harness-claude',
    'src',
    'agent-sdk',
    'agent-session.ts'
  ),
  'utf8'
)

describe('T-01216 empty_response guard', () => {
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
