/**
 * T-09860 (amendment r2, EN-20230; codex delivery ruling EN-20252).
 *
 * Every compile route renders typed task prompt facts from real inputs only:
 * - claude-code-tmux: the per-launch system prompt file carries the section.
 * - codex-app-server (both presentations): the SHARED codex home AGENTS.md
 *   stays byte-identical to a task-free render; the task-scoped section rides
 *   per invocation as driver.developerInstructions.
 * - agent-harness (native): the hash-covered agent block carries taskContext
 *   so the worker re-materializes with the same facts.
 * - HRC_TASK_* in dispatchEnv never produces facts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { RuntimeCompileRequest } from 'spaces-runtime-contracts'
import { type V2CompileFixture, compileV2, createV2CompileFixture } from './v2-compile-fixture.js'

const TEMPLATE = `schema_version = 2

[[prompt]]
name = "soul"
type = "inline"
content = "static soul for {{agentId}}"

[[prompt]]
name = "current-task-context"
type = "inline"
when = { taskField = "id" }
parts = [
  { content = "## Current task context" },
  { content = "- Task ID: {{task.id}}" },
  { content = "- Phase: {{task.phase}}", when = { taskField = "phase" } },
  { content = "- Role: {{task.role}}", when = { taskField = "role" } },
  { content = "- Required evidence: {{task.requiredEvidence}}", when = { taskField = "requiredEvidence" } },
  { content = "\\n### Hints\\n{{task.hints}}", when = { taskField = "hints" } },
]
`

const ROLE: NonNullable<RuntimeCompileRequest['materialization']['taskContext']> = {
  taskId: 'T-00042',
  phase: 'implement',
  role: 'implementer',
  requiredEvidenceKinds: ['test-run'],
  hintsText: 'Keep it small.',
}

const ROLE_SECTION = [
  '## Current task context',
  '- Task ID: T-00042',
  '- Phase: implement',
  '- Role: implementer',
  '- Required evidence: test-run',
  '',
  '### Hints',
  'Keep it small.',
].join('\n')

let fixture: V2CompileFixture

beforeEach(() => {
  fixture = createV2CompileFixture()
  writeFileSync(join(fixture.agentRoot, 'context-template.toml'), TEMPLATE, 'utf8')
})

afterEach(() => fixture.cleanup())

async function compile(options: {
  namespace: string
  harness: 'claude' | 'codex' | 'agent-harness'
  presentation: boolean
  scopeRef: string
  taskContext?: typeof ROLE | undefined
  dispatchEnv?: Record<string, string> | undefined
}) {
  const route = {
    claude: { modelProvider: 'anthropic', model: 'claude-sonnet-4-5' },
    codex: { modelProvider: 'openai-codex', model: 'gpt-5.6-terra' },
    'agent-harness': { modelProvider: 'openai-codex', model: 'gpt-5.6-terra' },
  }[options.harness]
  const response = await compileV2(fixture, {
    ...route,
    namespace: options.namespace,
    harness: options.harness,
    presentation: options.presentation,
    scopeRef: options.scopeRef,
    laneRef: 'main',
    // null = no taskContext; the fixture otherwise defaults one.
    taskContext: options.taskContext ?? null,
    ...(options.dispatchEnv !== undefined ? { dispatchEnv: options.dispatchEnv } : {}),
  } as Parameters<typeof compileV2>[1])
  if (!response.ok) throw new Error(JSON.stringify(response.diagnostics))
  return response.plan.execution.dispatchRequest.startRequest.spec
}

function codexAgentsMd(): string {
  return readFileSync(
    join(fixture.aspHome, 'codex-homes', 'agent-spaces_cody', 'AGENTS.md'),
    'utf8'
  )
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

describe('claude-code-tmux', () => {
  test('role launch renders every real field in the per-launch prompt file', async () => {
    const spec = await compile({
      namespace: 'claude-role',
      harness: 'claude',
      presentation: true,
      scopeRef: 'agent:cody:project:agent-spaces:task:T-00042',
      taskContext: ROLE,
    })
    const prompt = readFileSync(spec.launch?.systemPromptFile as string, 'utf8')
    expect(prompt).toContain(ROLE_SECTION)
  })

  test('ordinary task seat renders the Task ID only; standing seat renders nothing', async () => {
    const task = await compile({
      namespace: 'claude-task',
      harness: 'claude',
      presentation: true,
      scopeRef: 'agent:cody:project:agent-spaces:task:T-00043',
    })
    expect(readFileSync(task.launch?.systemPromptFile as string, 'utf8')).toContain(
      '## Current task context\n- Task ID: T-00043'
    )
    expect(readFileSync(task.launch?.systemPromptFile as string, 'utf8')).not.toContain('- Phase')

    const standing = await compile({
      namespace: 'claude-standing',
      harness: 'claude',
      presentation: true,
      scopeRef: 'agent:cody:project:agent-spaces:task:primary',
      dispatchEnv: { HRC_TASK_ID: 'T-11111', HRC_TASK_ROLE: 'leak' },
    })
    const standingPrompt = readFileSync(standing.launch?.systemPromptFile as string, 'utf8')
    expect(standingPrompt).not.toContain('Current task context')
    expect(standingPrompt).not.toContain('T-11111')
  })
})

describe('codex-app-server', () => {
  test.each([false, true])(
    'presentation=%s: shared AGENTS.md stays task-free; the section rides developerInstructions',
    async (presentation) => {
      const standing = await compile({
        namespace: `codex-standing-${presentation}`,
        harness: 'codex',
        presentation,
        scopeRef: 'agent:cody:project:agent-spaces:task:primary',
      })
      expect(standing.driver).not.toHaveProperty('developerInstructions')
      const standingHome = codexAgentsMd()

      const role = await compile({
        namespace: `codex-role-${presentation}`,
        harness: 'codex',
        presentation,
        scopeRef: 'agent:cody:project:agent-spaces:task:T-00042',
        taskContext: ROLE,
      })
      expect(role.driver).toMatchObject({ developerInstructions: ROLE_SECTION })
      expect(sha(codexAgentsMd())).toBe(sha(standingHome))
      expect(codexAgentsMd()).not.toContain('T-00042')

      const other = await compile({
        namespace: `codex-other-${presentation}`,
        harness: 'codex',
        presentation,
        scopeRef: 'agent:cody:project:agent-spaces:task:T-00099',
      })
      expect(other.driver).toMatchObject({
        developerInstructions: '## Current task context\n- Task ID: T-00099',
      })
      expect(sha(codexAgentsMd())).toBe(sha(standingHome))
    }
  )
})

describe('agent-harness (native worker)', () => {
  test('the hash-covered agent block carries the real taskContext only', async () => {
    const role = await compile({
      namespace: 'native-role',
      harness: 'agent-harness',
      presentation: false,
      scopeRef: 'agent:cody:project:agent-spaces:role:implementer',
      taskContext: ROLE,
    })
    expect(role.agent).toMatchObject({
      scopeRef: 'agent:cody:project:agent-spaces:role:implementer',
      taskContext: ROLE,
    })
    const plain = await compile({
      namespace: 'native-plain',
      harness: 'agent-harness',
      presentation: false,
      scopeRef: 'agent:cody:project:agent-spaces:task:T-00043',
    })
    expect(plain.agent).not.toHaveProperty('taskContext')
  })
})
