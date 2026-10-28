/**
 * T-12027: a compile's `when.exists` predicates check the placement's folder,
 * never the compiling process's cwd. aspd and raspd run from var/aspd, so a
 * justfile-gated section used to drop out of every daemon-compiled codex seat:
 * the shared AGENTS.md lost project-tooling and developerInstructions lost any
 * task section gated the same way.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { type V2CompileFixture, compileV2, createV2CompileFixture } from './v2-compile-fixture.js'

const TEMPLATE = `schema_version = 2

[[prompt]]
name = "soul"
type = "inline"
content = "static soul for {{agentId}}"

[[prompt]]
name = "task-tooling"
type = "inline"
when = { taskField = "id", exists = "justfile" }
content = "task {{task.id}} has a justfile"

[[reminder]]
name = "project-tooling"
type = "inline"
when = { exists = "justfile" }
content = "project has a justfile"
`

let fixture: V2CompileFixture
let originalCwd: string

beforeEach(() => {
  fixture = createV2CompileFixture()
  writeFileSync(join(fixture.agentRoot, 'context-template.toml'), TEMPLATE, 'utf8')
  writeFileSync(join(fixture.projectRoot, 'justfile'), 'info:\n\t@echo project\n', 'utf8')
  // The compiling process sits outside the project, as a daemon does.
  originalCwd = process.cwd()
  process.chdir(fixture.base)
})

afterEach(() => {
  process.chdir(originalCwd)
  fixture.cleanup()
})

describe('daemon compile resolves when.exists in the placement folder (T-12027)', () => {
  test('codex AGENTS.md and developerInstructions keep justfile-gated sections', async () => {
    const response = await compileV2(fixture, {
      namespace: 'when-exists-placement-cwd',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      scopeRef: 'agent:cody:project:agent-spaces:task:T-00042',
      laneRef: 'main',
      taskContext: null,
    })
    if (!response.ok) throw new Error(JSON.stringify(response.diagnostics))
    const spec = response.plan.execution.dispatchRequest.startRequest.spec

    expect(spec.driver).toMatchObject({ developerInstructions: 'task T-00042 has a justfile' })
    const agentsMd = readFileSync(
      join(fixture.aspHome, 'codex-homes', 'agent-spaces_cody', 'AGENTS.md'),
      'utf8'
    )
    expect(agentsMd).toContain('project has a justfile')
  })
})
