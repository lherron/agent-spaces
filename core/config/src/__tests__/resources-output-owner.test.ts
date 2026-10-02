import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { compileResourcesPlan } from '../resources/index.js'

// T-10008: event-hook [output] must reach ACP exactly as ACP's validateJobOutputConfig
// (acp-server job-output-config.ts, b274d40) accepts it, and owner mismatches must name
// the project/agent that is actually outside the plan.

const owner = {
  projectId: 'agent-spaces',
  agentId: 'smokey',
  scopeRef: 'agent:smokey:project:agent-spaces',
}

type CompileResult =
  | { ok: true; resources: Array<{ desiredJson: Record<string, unknown> }> }
  | { ok: false; code: string; message: string }

async function compileInline(relPath: string, toml: string): Promise<CompileResult> {
  const agentRoot = mkdtempSync(join(tmpdir(), 'asp-resource-output-'))
  mkdirSync(dirname(join(agentRoot, relPath)), { recursive: true })
  writeFileSync(join(agentRoot, relPath), toml)
  try {
    const plan = await compileResourcesPlan({ agentRoot, owner })
    return { ok: true, resources: plan.resources }
  } catch (error) {
    return {
      ok: false,
      code: error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function eventHook(output: string, target = 'project = "agent-spaces"\nagent = "smokey"'): string {
  return `schema = 1
name = "hook"

[event]
source = "media-ingest"

[match]
event = "transcript.completed"

[target]
${target}

[input]
content = "Summarize."

${output}

[cooldown]
seconds = 600
`
}

const SINK = `[[output.sinks]]
kind = "webhook"
url = "http://127.0.0.1:18551/api/summaries"
format = "discord_markdown"
`

function schedule(target: string, extra = ''): string {
  return `schema = 1
name = "job"

[target]
${target}

[trigger]
kind = "schedule"
cron = "0 8 * * *"

[input]
content = "Run."
${extra}`
}

describe('event-hook output passthrough', () => {
  test('passes output.delivery through to the projection', async () => {
    const result = await compileInline(
      'event-hooks/hook.toml',
      eventHook(`${SINK}\n[output.delivery]\nmaxAttempts = 6\nmaxAgeSeconds = 3600\n`)
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resources[0]?.desiredJson['output']).toEqual({
      sinks: [
        {
          kind: 'webhook',
          url: 'http://127.0.0.1:18551/api/summaries',
          format: 'discord_markdown',
        },
      ],
      delivery: { maxAttempts: 6, maxAgeSeconds: 3600 },
    })
  })

  test('omits delivery when not authored', async () => {
    const result = await compileInline('event-hooks/hook.toml', eventHook(SINK))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resources[0]?.desiredJson['output']).not.toHaveProperty('delivery')
  })

  test('accepts a sink without format and passes include through', async () => {
    const result = await compileInline(
      'event-hooks/hook.toml',
      eventHook(
        '[[output.sinks]]\nkind = "webhook"\nurl = "https://localhost:9/x"\ninclude = ["final"]\n'
      )
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resources[0]?.desiredJson['output']).toEqual({
      sinks: [{ kind: 'webhook', url: 'https://localhost:9/x', include: ['final'] }],
    })
  })

  test.each([
    ['unknown output key', `${SINK}\n[output]\nretries = 3\n`, 'output.retries'],
    ['unknown sink key', `${SINK}headers = "x"\n`, 'output.sinks[0].headers'],
    [
      'unknown delivery key',
      `${SINK}\n[output.delivery]\nbackoff = 5\n`,
      'output.delivery.backoff',
    ],
    ['non-string include', `${SINK}include = [1]\n`, 'output.sinks[0].include'],
  ])('refuses %s', async (_name, output, needle) => {
    const toml = output.includes('[output]\n')
      ? eventHook(`[output]\nretries = 3\n\n${SINK}`)
      : eventHook(output)
    const result = await compileInline('event-hooks/hook.toml', toml)
    expect(result).toMatchObject({ ok: false, code: 'INVALID_OUTPUT' })
    if (result.ok) return
    expect(result.message).toContain(needle)
  })

  test.each([
    ['maxAttempts = 0', 'output.delivery.maxAttempts must be an integer from 1 to 1000'],
    ['maxAttempts = 1001', 'output.delivery.maxAttempts must be an integer from 1 to 1000'],
    ['maxAttempts = 2.5', 'output.delivery.maxAttempts must be an integer from 1 to 1000'],
    ['maxAgeSeconds = 59', 'output.delivery.maxAgeSeconds must be an integer from 60 to 604800'],
    [
      'maxAgeSeconds = 604801',
      'output.delivery.maxAgeSeconds must be an integer from 60 to 604800',
    ],
    ['maxAgeSeconds = "1h"', 'output.delivery.maxAgeSeconds must be an integer from 60 to 604800'],
  ])('refuses out-of-range delivery %s', async (line, message) => {
    const result = await compileInline(
      'event-hooks/hook.toml',
      eventHook(`${SINK}\n[output.delivery]\n${line}\n`)
    )
    expect(result).toMatchObject({ ok: false, code: 'INVALID_OUTPUT_DELIVERY' })
    if (result.ok) return
    expect(result.message).toContain(message)
  })
})

describe('owner mismatch messages', () => {
  test('schedule targeting another project names both projects and the --project fix', async () => {
    const result = await compileInline(
      'schedules/job.toml',
      schedule('project = "signal-pipeline"\nagent = "smokey"')
    )
    expect(result).toMatchObject({ ok: false, code: 'CROSS_OWNER_TARGET' })
    if (result.ok) return
    expect(result.message).toContain('target project signal-pipeline')
    expect(result.message).toContain('smokey@agent-spaces')
    expect(result.message).toContain('--project signal-pipeline')
    expect(result.message).not.toContain('is outside owner smokey')
  })

  test('schedule targeting another agent names the agents and the owner scope', async () => {
    const result = await compileInline(
      'schedules/job.toml',
      schedule('project = "agent-spaces"\nagent = "cody"')
    )
    expect(result).toMatchObject({ ok: false, code: 'CROSS_OWNER_TARGET' })
    if (result.ok) return
    expect(result.message).toContain('target agent cody')
    expect(result.message).toContain('smokey@agent-spaces')
  })

  test('schedule with no target project says it is required', async () => {
    const result = await compileInline('schedules/job.toml', schedule('agent = "smokey"'))
    expect(result).toMatchObject({ ok: false, code: 'CROSS_OWNER_TARGET' })
    if (result.ok) return
    expect(result.message).toContain('target.project is required')
    expect(result.message).toContain('smokey@agent-spaces')
  })

  test('event hook targeting another project names the --project fix', async () => {
    const result = await compileInline(
      'event-hooks/hook.toml',
      eventHook(SINK, 'project = "signal-pipeline"\nagent = "smokey"')
    )
    expect(result).toMatchObject({ ok: false, code: 'CROSS_OWNER_EVENT_HOOK' })
    if (result.ok) return
    expect(result.message).toContain('target project signal-pipeline')
    expect(result.message).toContain('smokey@agent-spaces')
    expect(result.message).toContain('--project signal-pipeline')
  })
})

describe('schedule output', () => {
  test('passes [output] on a schedule through with the same validator', async () => {
    const result = await compileInline(
      'schedules/job.toml',
      schedule(
        'project = "agent-spaces"\nagent = "smokey"',
        `\n${SINK}\n[output.delivery]\nmaxAttempts = 3\n`
      )
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resources[0]?.desiredJson['output']).toEqual({
      sinks: [
        {
          kind: 'webhook',
          url: 'http://127.0.0.1:18551/api/summaries',
          format: 'discord_markdown',
        },
      ],
      delivery: { maxAttempts: 3 },
    })
  })

  test('refuses an unknown output key on a schedule', async () => {
    const result = await compileInline(
      'schedules/job.toml',
      schedule('project = "agent-spaces"\nagent = "smokey"', `\n${SINK}headers = "x"\n`)
    )
    expect(result).toMatchObject({ ok: false, code: 'INVALID_OUTPUT' })
  })

  test('schedules without [output] carry no output key', async () => {
    const result = await compileInline(
      'schedules/job.toml',
      schedule('project = "agent-spaces"\nagent = "smokey"')
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resources[0]?.desiredJson).not.toHaveProperty('output')
  })
})
