/**
 * T-09860 (EN-20252): task-scoped prompt content reaches codex per invocation.
 *
 * The shared CODEX_HOME AGENTS.md is task-invariant, so the compile carries
 * task-scoped sections as driver.developerInstructions, and the driver sends
 * them on every thread/start AND thread/resume from THIS invocation's spec — a
 * resumed seat never keeps a stale or foreign task. Absent = today's null
 * (pinned by the thread/start defaults test in app-server-start-params).
 */

import { describe, expect, test } from 'bun:test'
import { firstThreadRequest } from './codex-tui-transport-support'

const TASK_SECTION = '## Current task context\n- Task ID: T-00042'

describe('codex developerInstructions (thread/start and thread/resume)', () => {
  test('thread/start carries the invocation task section', async () => {
    const request = await firstThreadRequest('inv_codex_devinstr_start', {
      developerInstructions: TASK_SECTION,
    })
    expect(request?.method).toBe('thread/start')
    expect(request?.params).toMatchObject({
      developerInstructions: TASK_SECTION,
      baseInstructions: null,
    })
  })

  test('thread/resume carries the invocation task section', async () => {
    const request = await firstThreadRequest('inv_codex_devinstr_resume', {
      developerInstructions: TASK_SECTION,
      resumeThreadId: 'thread_prior',
    })
    expect(request?.method).toBe('thread/resume')
    expect(request?.params).toMatchObject({
      threadId: 'thread_prior',
      developerInstructions: TASK_SECTION,
    })
  })
})
