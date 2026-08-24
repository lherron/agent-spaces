/**
 * Driver-level regression guard: codex-app-server resumeFallback:'fail' with a
 * missing thread MUST fail visibly — never silently fall back to a fresh start.
 *
 * T-04829 Phase 1 (ref: T-04828 broker resume contract, T-04827 parent).
 *
 * Key assertions (compile-runtime-plan.ts:871 sets resumeFallback:'fail' when
 * resume is intended; driver.ts:194–237 acts on it at startup):
 *
 *  1. resume-missing-fail fixture: broker.start() throws with HarnessError.
 *  2. Events do NOT include a driver.notice with code:'resume_fallback_start_fresh'.
 *  3. Events do NOT include 'invocation.started' (no process was launched fresh).
 *  4. Contrast: resume-missing-start-fresh emits resume_fallback_start_fresh and DOES start.
 *
 * These are GREEN GUARDS — the driver already implements the behavior correctly.
 * They fire if a future refactor re-introduces a silent fresh-start fallback.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import type { HarnessInvocationSpec, InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { createBroker } from '../../../src/broker'
import { createCodexAppServerDriver } from '../../../src/drivers/codex-app-server/driver'

const root = new URL('../../..', import.meta.url).pathname
const fixtureDir = join(root, 'test/fixtures/fake-codex')

const now = () => new Date('2026-06-15T12:00:00.000Z')

function scenarioSpec(
  scenario: string,
  overrides: Partial<HarnessInvocationSpec> = {}
): HarnessInvocationSpec {
  return {
    specVersion: 'harness-broker.invocation/v1',
    invocationId: `inv_${scenario.replaceAll('-', '_')}`,
    harness: {
      frontend: 'codex',
      provider: 'openai',
      driver: 'codex-app-server',
    },
    process: {
      command: Bun.execPath,
      args: [join(fixtureDir, `${scenario}.ts`), '--literal', '$NO_EXPAND', '*.ts'],
      cwd: process.cwd(),
      lockedEnv: {},
      harnessTransport: { kind: 'jsonrpc-stdio' },
      limits: {
        startupTimeoutMs: 5000,
        turnTimeoutMs: 5000,
        stopGraceMs: 500,
      },
    },
    interaction: {
      mode: 'headless',
      turnConcurrency: 'single',
      inputQueue: 'none',
    },
    driver: {
      kind: 'codex-app-server',
      resumeFallback: 'start-fresh',
      permissionPolicy: { mode: 'deny' },
    },
    ...overrides,
  }
}

describe('resumeFallback:fail + missing thread — never starts fresh (T-04829)', () => {
  test('broker.start() rejects with HarnessError when thread is missing and fallback is fail', async () => {
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      now,
    })

    await expect(
      broker.start({
        spec: scenarioSpec('resume-missing-fail', {
          continuation: { provider: 'codex', kind: 'thread', key: 'thread_missing' },
          driver: {
            kind: 'codex-app-server',
            resumeThreadId: 'thread_missing',
            resumeFallback: 'fail',
            permissionPolicy: { mode: 'deny' },
          },
        }),
      })
    ).rejects.toMatchObject({ code: BrokerErrorCode.HarnessError })
  })

  test('events do NOT include resume_fallback_start_fresh when resumeFallback is fail', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })

    await broker
      .start({
        spec: scenarioSpec('resume-missing-fail', {
          continuation: { provider: 'codex', kind: 'thread', key: 'thread_missing' },
          driver: {
            kind: 'codex-app-server',
            resumeThreadId: 'thread_missing',
            resumeFallback: 'fail',
            permissionPolicy: { mode: 'deny' },
          },
        }),
      })
      .catch(() => {
        /* expected to throw — we check the events below */
      })

    const freshFallbackNotice = events.find(
      (e) =>
        e.type === 'driver.notice' &&
        (e.payload as { code?: string }).code === 'resume_fallback_start_fresh'
    )
    expect(freshFallbackNotice).toBeUndefined()
  })

  test('events do NOT include invocation.started when resumeFallback is fail and thread is missing', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })

    await broker
      .start({
        spec: scenarioSpec('resume-missing-fail', {
          continuation: { provider: 'codex', kind: 'thread', key: 'thread_missing' },
          driver: {
            kind: 'codex-app-server',
            resumeThreadId: 'thread_missing',
            resumeFallback: 'fail',
            permissionPolicy: { mode: 'deny' },
          },
        }),
      })
      .catch(() => {
        /* expected to throw */
      })

    expect(events.map((e) => e.type)).not.toContain('invocation.started')
  })

  test('events DO include invocation.failed with a thread-not-found code', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })

    await broker
      .start({
        spec: scenarioSpec('resume-missing-fail', {
          continuation: { provider: 'codex', kind: 'thread', key: 'thread_missing' },
          driver: {
            kind: 'codex-app-server',
            resumeThreadId: 'thread_missing',
            resumeFallback: 'fail',
            permissionPolicy: { mode: 'deny' },
          },
        }),
      })
      .catch(() => {
        /* expected to throw */
      })

    const failed = events.find((e) => e.type === 'invocation.failed')
    expect(failed).toBeDefined()
    // The failure must surface the thread-missing signal, not a generic error
    expect((failed?.payload as { code?: string }).code).toBe('thread_missing')
  })
})

describe('Contrast — resumeFallback:start-fresh emits resume_fallback_start_fresh and starts', () => {
  test('start-fresh fallback emits the resume_fallback_start_fresh driver.notice', async () => {
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createCodexAppServerDriver()],
      onEvent: (event) => events.push(event),
      now,
    })

    const userInput = {
      inputId: 'input_contrast',
      kind: 'user' as const,
      content: [{ type: 'text' as const, text: 'contrast turn' }],
    }

    const spec = scenarioSpec('resume-missing-start-fresh', {
      driver: {
        kind: 'codex-app-server',
        resumeThreadId: 'thread_missing',
        resumeFallback: 'start-fresh',
        permissionPolicy: { mode: 'deny' },
      },
    })

    await broker.start({ spec })
    await broker
      .input({
        invocationId: spec.invocationId ?? '',
        input: userInput,
        policy: { whenBusy: 'reject' },
      })
      .catch(() => {
        /* ignore for contrast test */
      })

    const freshFallbackNotice = events.find(
      (e) =>
        e.type === 'driver.notice' &&
        (e.payload as { code?: string }).code === 'resume_fallback_start_fresh'
    )
    expect(freshFallbackNotice).toBeDefined()
    expect(events.map((e) => e.type)).toContain('invocation.started')
  })
})
