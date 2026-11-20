import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAntigravityHookEvents } from '../src/drivers/antigravity-cli-hrcpty/hook-events'
import { ANTIGRAVITY_HOOK_GENERATION } from '../src/drivers/antigravity-cli-hrcpty/launch'
import type { DriverContext } from '../src/drivers/driver'

// Live max3, neon@memelord:primary: the model's answer was in agy's transcript
// at 01:31:58 but the broker emitted it at 01:32:07, when the Stop hook fired.
// A prompt queued at 01:32:06 then rendered above the previous turn's answer.
// No hook fires between a final answer and Stop, so the transcript itself must
// wake the driver.
describe('antigravity transcript wakeup', () => {
  test('emits an answer when agy writes it, before the next hook', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-wakeup-'))
    const transcriptPath = join(dir, 'transcript_full.jsonl')
    const userRow = {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-20T01:31:51Z',
      content: '<USER_REQUEST>\nHi\n</USER_REQUEST>\n',
    }
    writeFileSync(transcriptPath, `${JSON.stringify(userRow)}\n`)
    const emitted: Array<{ type: string; payload: unknown }> = []
    const ctx = {
      invocationId: 'inv-wakeup',
      emit: (type: string, payload: unknown) => {
        emitted.push({ type, payload })
      },
    } as unknown as DriverContext
    const callbackSocket = join(dir, 'hook.sock')
    const events = createAntigravityHookEvents({
      ctx,
      env: { HARNESS_BROKER_RUNTIME_ID: 'rt-wakeup' },
      callbackSocket,
      onReady: () => {},
      onWorkspaceMismatch: () => {},
      onMissedMail: () => {},
    })
    try {
      await events.accept({
        invocationId: 'inv-wakeup',
        runtimeId: 'rt-wakeup',
        generation: ANTIGRAVITY_HOOK_GENERATION,
        callbackSocket,
        startedAt: Date.now(),
        event: 'PreInvocation',
        payload: { invocationNum: 0, lastUserInput: 'Hi', initialNumSteps: 1, transcriptPath },
      } as never)
      expect(emitted.some((e) => e.type === 'turn.started')).toBe(true)

      appendFileSync(
        transcriptPath,
        `${JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-20T01:31:58Z',
          content: 'Hey Lance!',
        })}\n`
      )
      const deadline = Date.now() + 2000
      while (
        Date.now() < deadline &&
        !emitted.some((e) => e.type === 'assistant.message.completed')
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(emitted.map((e) => e.type)).toContain('assistant.message.completed')
    } finally {
      events.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('arms once agy creates the transcript after the first hooks named it', async () => {
    // agy names the transcript at SessionStart and PreInvocation before it
    // creates the file; the watch must survive that and arm on a later hook.
    const dir = mkdtempSync(join(tmpdir(), 'agy-wakeup-'))
    const transcriptPath = join(dir, 'transcript_full.jsonl')
    const emitted: string[] = []
    const ctx = {
      invocationId: 'inv-lazy',
      emit: (type: string) => {
        emitted.push(type)
      },
    } as unknown as DriverContext
    const callbackSocket = join(dir, 'hook.sock')
    const events = createAntigravityHookEvents({
      ctx,
      env: { HARNESS_BROKER_RUNTIME_ID: 'rt-lazy' },
      callbackSocket,
      onReady: () => {},
      onWorkspaceMismatch: () => {},
      onMissedMail: () => {},
    })
    const hook = (event: string, payload: Record<string, unknown>) =>
      events.accept({
        invocationId: 'inv-lazy',
        runtimeId: 'rt-lazy',
        generation: ANTIGRAVITY_HOOK_GENERATION,
        callbackSocket,
        startedAt: Date.now(),
        event,
        payload: { transcriptPath, ...payload },
      } as never)
    try {
      await hook('SessionStart', {})
      await hook('PreInvocation', { invocationNum: 0, lastUserInput: 'Hi', initialNumSteps: 1 })
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T01:31:51Z', content: '<USER_REQUEST>\nHi\n</USER_REQUEST>\n' })}\n`
      )
      await hook('PostInvocation', {})
      appendFileSync(
        transcriptPath,
        `${JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-20T01:31:58Z', content: 'Hey Lance!' })}\n`
      )
      const deadline = Date.now() + 2000
      while (Date.now() < deadline && !emitted.includes('assistant.message.completed')) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(emitted).toContain('assistant.message.completed')
    } finally {
      events.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
