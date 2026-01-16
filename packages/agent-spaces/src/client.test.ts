import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createAgentSpacesClient } from './index.js'

const client = createAgentSpacesClient()

describe('agent-spaces client', () => {
  test('getHarnessCapabilities returns expected harnesses', async () => {
    const caps = await client.getHarnessCapabilities()
    const ids = caps.harnesses.map((h) => h.id)
    expect(ids).toContain('agent-sdk')
    expect(ids).toContain('pi-sdk')
  })

  test('resolve returns resolve_failed for invalid spec', async () => {
    const result = await client.resolve({
      aspHome: '/tmp/asp-test',
      spec: { target: { targetName: 'default', targetDir: 'relative/path' } },
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('resolve_failed')
  })

  test('runTurn returns model_not_supported and emits ordered events', async () => {
    const events: Array<{ type: string; seq: number }> = []

    const response = await client.runTurn({
      externalSessionId: 'session-test',
      externalRunId: 'run-test',
      aspHome: '/tmp/asp-test',
      spec: { spaces: ['space:base@dev'] },
      harness: 'agent-sdk',
      model: 'api/not-a-model',
      cwd: '/tmp',
      prompt: 'Hello',
      callbacks: {
        onEvent: (event) => {
          events.push({ type: event.type, seq: event.seq })
        },
      },
    })

    expect(response.result.success).toBe(false)
    expect(response.result.error?.code).toBe('model_not_supported')
    expect(events.map((e) => e.type)).toEqual(['state', 'message', 'state', 'complete'])
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })

  test('runTurn resumes using session record for pi harness', async () => {
    const aspHome = join(tmpdir(), `asp-resume-${Date.now()}`)
    const externalSessionId = 'session-resume'
    const harnessSessionId = join(aspHome, 'sessions', 'pi', 'missing-resume')

    await mkdir(join(aspHome, 'sessions'), { recursive: true })

    const hash = createHash('sha256')
    hash.update(externalSessionId)
    const recordPath = join(aspHome, 'sessions', `${hash.digest('hex')}.json`)
    const now = new Date().toISOString()
    const record = {
      externalSessionId,
      harness: 'pi-sdk',
      harnessSessionId,
      model: 'openai-codex/gpt-5.2-codex',
      createdAt: now,
      updatedAt: now,
    }
    await writeFile(recordPath, JSON.stringify(record, null, 2), 'utf-8')

    const events: Array<{ type: string; harnessSessionId?: string }> = []

    const response = await client.runTurn({
      externalSessionId,
      externalRunId: 'run-resume',
      aspHome,
      spec: { spaces: ['space:base@dev'] },
      harness: 'pi-sdk',
      model: 'openai-codex/gpt-5.2-codex',
      cwd: '/tmp',
      prompt: 'Hello',
      callbacks: {
        onEvent: (event) => {
          events.push({ type: event.type, harnessSessionId: event.harnessSessionId })
        },
      },
    })

    expect(response.result.success).toBe(false)
    expect(response.result.error?.code).toBe('harness_session_not_found')
    expect(events.map((event) => event.type)).toEqual(['state', 'message', 'state', 'complete'])
    expect(events[0]?.harnessSessionId).toBe(harnessSessionId)
  })

  test('runTurn returns harness_session_not_found for missing pi session', async () => {
    const missingSessionPath = join(tmpdir(), `asp-missing-${Date.now()}`)
    await rm(missingSessionPath, { recursive: true, force: true })

    const response = await client.runTurn({
      externalSessionId: 'session-missing',
      externalRunId: 'run-missing',
      aspHome: '/tmp/asp-test',
      spec: { spaces: ['space:base@dev'] },
      harness: 'pi-sdk',
      model: 'openai-codex/gpt-5.2-codex',
      harnessSessionId: missingSessionPath,
      cwd: '/tmp',
      prompt: 'Hello',
      callbacks: { onEvent: () => {} },
    })

    expect(response.result.success).toBe(false)
    expect(response.result.error?.code).toBe('harness_session_not_found')
  })
})
