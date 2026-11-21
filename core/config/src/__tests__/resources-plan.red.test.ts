import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import expectedPlan from '../__fixtures__/resources/expected-plan.json'
import * as resourcesCompiler from '../resources/index.js'
import { type ResourcesPlan, compileResourcesPlan } from '../resources/index.js'

const fixturesRoot = fileURLToPath(new URL('../__fixtures__/resources/', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const workspaceRoots = ['apps', 'compiler', 'contracts', 'core', 'drivers', 'harness'] as const

const smokeyOwner = {
  projectId: 'agent-spaces',
  agentId: 'smokey',
  scopeRef: 'agent:smokey:project:agent-spaces',
}

type CompileResult =
  | { ok: true; plan: ResourcesPlan }
  | { ok: false; code: string; message: string }

async function compileFixture(agentRoot: string, includePaths?: string[]): Promise<CompileResult> {
  try {
    const plan = await compileResourcesPlan({
      agentRoot: `${fixturesRoot}${agentRoot}`,
      owner: smokeyOwner,
      includePaths,
    })
    return { ok: true, plan }
  } catch (error) {
    return {
      ok: false,
      code: error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

async function compileInlineAgent(files: Record<string, string>, includePaths?: string[]) {
  const agentRoot = mkdtempSync(join(tmpdir(), 'asp-resource-agent-'))
  for (const [relPath, content] of Object.entries(files)) {
    mkdirSync(dirname(join(agentRoot, relPath)), { recursive: true })
    writeFileSync(join(agentRoot, relPath), content)
  }
  try {
    const plan = await compileResourcesPlan({ agentRoot, owner: smokeyOwner, includePaths })
    return { ok: true, plan } as const
  } catch (error) {
    return {
      ok: false,
      code: error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN',
      message: error instanceof Error ? error.message : String(error),
    } as const
  } finally {
    rmSync(agentRoot, { recursive: true, force: true })
  }
}

const inlineSchedule = `
schema = 1
name = "kernel-owned"
enabled = true

[target]
project = "agent-spaces"
agent = "smokey"

[trigger]
cron = "0 * * * *"

[input]
content = "owned by the kernel schedule module"
`

function findByKind(plan: typeof expectedPlan, kind: string) {
  const resource = plan.resources.find((item) => item.resourceKind === kind)
  if (!resource) throw new Error(`missing fixture resource kind: ${kind}`)
  return resource
}

function collectTypeScriptFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(path))
      continue
    }
    if (entry.isFile() && path.endsWith('.ts')) files.push(path)
  }
  return files
}

describe('agent-authored runtime resources plan compiler', () => {
  test('emits deterministic versioned machine-readable plan JSON for channels and event hooks', async () => {
    // Test context: Phase A red. This must fail only because the resources compiler is unimplemented.
    const first = await compileFixture('agents/smokey')
    const second = await compileFixture('agents/smokey')

    expect<unknown>(first).toEqual({ ok: true, plan: expectedPlan })
    expect(second).toEqual(first)
    expect(JSON.stringify((first as { plan: unknown }).plan)).toBe(
      JSON.stringify((second as { plan: unknown }).plan)
    )
  })

  test('normalizes sourceHash across TOML formatting and comment-only changes', async () => {
    const canonical = await compileFixture('agents/smokey', ['channels/discord-smoke.toml'])
    const formatted = await compileFixture('../../variants', ['discord-smoke-comments.toml'])
    const sourceHash = findByKind(expectedPlan, 'interface-binding').sourceHash

    for (const result of [canonical, formatted]) {
      expect(result).toEqual({
        ok: true,
        plan: expect.objectContaining({ resources: [expect.objectContaining({ sourceHash })] }),
      })
    }
  })

  test('refuses schedules: the kernel schedule module owns them', async () => {
    const files = { 'schedules/job.toml': inlineSchedule, 'misc/job.toml': inlineSchedule }
    const walked = await compileInlineAgent(files)
    const byPath = await compileInlineAgent(files, ['schedules/absent.toml'])
    const byContent = await compileInlineAgent(files, ['misc/job.toml'])

    expect(walked).toEqual({ ok: true, plan: expect.objectContaining({ resources: [] }) })
    for (const result of [byPath, byContent]) {
      expect(result).toEqual({
        ok: false,
        code: 'SCHEDULE_MODULE_OWNED',
        message: expect.stringContaining('schedule module'),
      })
    }
  })

  test('rejects non-loopback event hook output webhooks before ACP apply', async () => {
    const result = await compileFixture('../../invalid', ['event-hook-output-nonloopback.toml'])
    expect(result).toEqual({
      ok: false,
      code: 'INVALID_OUTPUT_SINK_URL',
      message: expect.stringContaining('loopback'),
    })
  })

  test('rejects bare hooks directories because event hooks must live under event-hooks', async () => {
    const result = await compileFixture('agents/smokey', ['hooks/legacy-hook.toml'])
    expect(result).toEqual({
      ok: false,
      code: 'RESERVED_HOOKS_DIRECTORY',
      message: expect.stringContaining('event-hooks'),
    })
  })

  test('rejects cross-owner event hooks while accepting same-owner event hooks', async () => {
    const sameOwner = await compileFixture('agents/smokey', [
      'event-hooks/wrkq-needs-smoketest.toml',
    ])
    const foreignOwner = await compileFixture('agents/cody', [
      'event-hooks/cross-owner-smokey.toml',
    ])

    expect(sameOwner).toEqual({
      ok: true,
      plan: expect.objectContaining({
        resources: [findByKind(expectedPlan, 'event-hook')],
      }),
    })
    expect(foreignOwner).toEqual({
      ok: false,
      code: 'CROSS_OWNER_EVENT_HOOK',
      message: expect.stringContaining('smokey'),
    })
  })

  test('rejects cross-owner targets for channels in v1', async () => {
    const channel = await compileFixture('../../invalid', ['channel-cross-owner-target.toml'])

    expect(channel).toEqual({
      ok: false,
      code: 'CROSS_OWNER_TARGET',
      message: expect.stringContaining('cody'),
    })
  })

  test('rejects malformed cooldowns before apply', async () => {
    const result = await compileFixture('../../invalid', ['event-hook-cooldown-malformed.toml'])
    expect(result).toEqual({
      ok: false,
      code: 'INVALID_COOLDOWN',
      message: expect.stringContaining('cooldown'),
    })
  })

  test('rejects absent authored cooldown until ACP exposes a versioned conservative default', async () => {
    const result = await compileFixture('../../invalid', ['event-hook-cooldown-missing.toml'])
    expect(result).toEqual({
      ok: false,
      code: 'MISSING_COOLDOWN',
      message: expect.stringContaining('cooldown'),
    })
  })

  test('allows only wrkq structural target templates for project_scope_id and ticket_id', async () => {
    const result = await compileFixture('agents/smokey', ['event-hooks/wrkq-needs-smoketest.toml'])
    expect(result).toEqual({
      ok: true,
      plan: expect.objectContaining({
        resources: [
          expect.objectContaining({
            desiredJson: expect.objectContaining({
              trigger: expect.objectContaining({
                target: {
                  project: '{{ project_scope_id }}',
                  agent: 'smokey',
                  lane: 'main',
                  task: '{{ticket_id}}',
                },
              }),
            }),
          }),
        ],
      }),
    })
  })

  test('rejects templated targets on generic non-wrkq events', async () => {
    const result = await compileFixture('../../invalid', [
      'event-hook-generic-templated-target.toml',
    ])
    expect(result).toEqual({
      ok: false,
      code: 'GENERIC_EVENT_STATIC_TARGET_ONLY',
      message: expect.stringContaining('static target'),
    })
  })

  test('rejects lane templates because lanes are static in v1', async () => {
    const result = await compileFixture('../../invalid', ['event-hook-lane-template.toml'])
    expect(result).toEqual({
      ok: false,
      code: 'LANE_TEMPLATE_UNSUPPORTED',
      message: expect.stringContaining('lane'),
    })
  })

  test.each([
    ['payload.*', 'event-hook-payload-target.toml'],
    ['title', 'event-hook-title-target.toml'],
    ['labels', 'event-hook-labels-target.toml'],
    ['container', 'event-hook-container-target.toml'],
    ['arbitrary structural field', 'event-hook-arbitrary-target.toml'],
  ])('rejects %s structural target templating', async (_label, filename) => {
    const result = await compileFixture('../../invalid', [filename])
    expect(result).toEqual({
      ok: false,
      code: 'DISALLOWED_TARGET_TEMPLATE',
      message: expect.stringContaining('template'),
    })
  })

  test('rejects originPolicy.agent allow and accepts explicit deny-self, deny, and default deny-self policy', async () => {
    const deny = await compileFixture('agents/smokey', ['event-hooks/wrkq-needs-smoketest.toml'])
    const explicitDenySelf = await compileFixture('../../variants', [
      'event-hook-origin-deny-self.toml',
    ])
    const defaultDenySelf = await compileFixture('../../variants', ['event-hook-default-deny.toml'])
    const allow = await compileFixture('../../invalid', ['event-hook-origin-allow.toml'])

    expect(deny).toEqual({
      ok: true,
      plan: expect.objectContaining({
        resources: [
          expect.objectContaining({
            desiredJson: expect.objectContaining({
              trigger: expect.objectContaining({
                originPolicy: { agent: 'deny-self' },
              }),
            }),
          }),
        ],
      }),
    })
    expect(explicitDenySelf).toEqual({
      ok: true,
      plan: expect.objectContaining({
        resources: [
          expect.objectContaining({
            desiredJson: expect.objectContaining({
              trigger: expect.objectContaining({
                originPolicy: { agent: 'deny-self' },
              }),
            }),
          }),
        ],
      }),
    })
    expect(defaultDenySelf).toEqual({
      ok: true,
      plan: expect.objectContaining({
        resources: [
          expect.objectContaining({
            desiredJson: expect.objectContaining({
              trigger: expect.objectContaining({
                originPolicy: { agent: 'deny-self' },
              }),
            }),
          }),
        ],
      }),
    })
    expect(allow).toEqual({
      ok: false,
      code: 'ORIGIN_AGENT_ALLOW_UNSUPPORTED',
      message: expect.stringContaining('originPolicy.agent'),
    })
  })

  test('keeps ASP read-only: no ACP store imports and no ACP mutation compiler surface', async () => {
    const offenders = workspaceRoots
      .flatMap((root) => collectTypeScriptFiles(`${repoRoot}${root}`))
      .filter((path) => {
        const source = readFileSync(path, 'utf8')
        return /from ['"].*(acp-jobs-store|acp-interface-store|@praesidium\/acp)/.test(source)
      })
    expect(offenders).toEqual([])
    expect(resourcesCompiler).not.toHaveProperty('applyResourcesPlan')

    const result = await compileFixture('agents/smokey')
    expect<unknown>(result).toEqual({ ok: true, plan: expectedPlan })
  })
})
