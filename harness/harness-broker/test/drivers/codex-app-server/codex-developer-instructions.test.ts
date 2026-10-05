/**
 * T-09860 (EN-20252): task-scoped prompt content reaches codex per invocation.
 *
 * The shared CODEX_HOME AGENTS.md is task-invariant, so the compile carries
 * task-scoped sections as driver.developerInstructions, and the driver sends
 * them on every thread/start AND thread/resume from THIS invocation's spec — a
 * resumed seat never keeps a stale or foreign task. Absent = today's null.
 */

import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import type { InvocationId } from 'spaces-harness-broker-protocol'
import { buildThreadStartParams } from '../../../src/drivers/codex-app-server/driver-support'
import { invocationIdFrom } from '../../ids'
import { FakeCodexRpc, lease, setupDriver, spec } from './codex-tui-transport-support'

const SPEC = spec('inv_developer_instructions_params')

const TASK_SECTION = '## Current task context\n- Task ID: T-00042'

describe('codex developerInstructions (headless thread/start params)', () => {
  test('forwards the invocation developerInstructions', () => {
    const params = buildThreadStartParams(SPEC, {
      kind: 'codex-app-server',
      developerInstructions: TASK_SECTION,
    })
    expect(params['developerInstructions']).toBe(TASK_SECTION)
    expect(params['baseInstructions']).toBeNull()
  })

  test('absent developerInstructions keeps the null it always sent', () => {
    const params = buildThreadStartParams(SPEC, {
      kind: 'codex-app-server',
    })
    expect(params['developerInstructions']).toBeNull()
  })
})

describe('codex developerInstructions (codex-tui start and resume)', () => {
  async function firstThreadRequest(invocationId: InvocationId, resumeThreadId?: string) {
    const rpc = new FakeCodexRpc()
    rpc.onRequest = async (method) => {
      if (method === 'initialize') return {}
      if (method === 'hooks/list') return { data: [] }
      if (method === 'thread/queue/list') return { data: [] }
      if (method === 'thread/start') return { thread: { id: 'thread_fresh' } }
      if (method === 'thread/resume') return { thread: { id: resumeThreadId } }
      throw new Error(`unhandled fake RPC request: ${method}`)
    }
    const run = await setupDriver(rpc, invocationId, {
      developerInstructions: TASK_SECTION,
      ...(resumeThreadId !== undefined ? { resumeThreadId } : {}),
    })
    try {
      await run.broker.start({ spec: run.invocationSpec }, {}, { terminalSurface: lease() })
      return rpc.requests.find(
        (request) => request.method === 'thread/start' || request.method === 'thread/resume'
      )
    } finally {
      await run.broker.stop({ invocationId, reason: 'test cleanup' })
      await run.broker.dispose({ invocationId })
      await rm(run.socketDir, { recursive: true, force: true })
    }
  }

  test('thread/start carries the invocation task section', async () => {
    const request = await firstThreadRequest(invocationIdFrom('inv_codex_devinstr_start'))
    expect(request?.method).toBe('thread/start')
    expect(request?.params).toMatchObject({ developerInstructions: TASK_SECTION })
  })

  test('thread/resume carries the invocation task section', async () => {
    const request = await firstThreadRequest(
      invocationIdFrom('inv_codex_devinstr_resume'),
      'thread_prior'
    )
    expect(request?.method).toBe('thread/resume')
    expect(request?.params).toMatchObject({
      threadId: 'thread_prior',
      developerInstructions: TASK_SECTION,
    })
  })
})
