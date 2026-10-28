import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentInspectionRequest } from 'spaces-runtime-contracts'

import { createAspcService } from '../src/index.js'

// T-12023: both inspection producers run exec sections in the project root,
// the same folder their `when.exists` predicates check. A template gated on a
// project-only justfile must render its exec and leave the inspection complete.

type Fixture = { root: string; agentsRoot: string; projectRoot: string }

let fixture: Fixture

beforeEach(async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aspc-exec-cwd-')))
  const agentsRoot = join(root, 'agents')
  const projectRoot = join(root, 'project')
  const agentRoot = join(agentsRoot, 'cody')
  await mkdir(agentRoot, { recursive: true })
  await mkdir(projectRoot, { recursive: true })
  await writeFile(join(projectRoot, 'justfile'), 'info:\n\t@echo project\n')
  await writeFile(
    join(agentRoot, 'agent-profile.toml'),
    'version = 4\n\n[provisioning]\nharness = "codex"\n\n[spaces]\nbase = []\n\n[instructions]\ntemplate = "context-template.toml"\n'
  )
  await writeFile(
    join(agentRoot, 'context-template.toml'),
    `schema_version = 2
mode = "replace"

[[prompt]]
name = "soul"
type = "inline"
content = "Cody soul"

[[reminder]]
name = "project-tooling"
type = "exec"
command = "test -f justfile && printf 'cwd=%s' \\"$(pwd -P)\\""
when = { exists = "justfile" }
`
  )
  fixture = { root, agentsRoot, projectRoot }
})

afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true })
})

describe('inspection exec sections run in the project root (T-12023)', () => {
  test('agent selection inspection renders the project-gated exec', async () => {
    const service = createAspcService({
      agentsRoot: fixture.agentsRoot,
      resolveProjectRoot: (projectId) =>
        projectId === 'agent-spaces' ? fixture.projectRoot : undefined,
    })
    const request: AgentInspectionRequest = {
      schemaVersion: 'agent-inspection-request/v2',
      identifiers: {
        agentId: 'cody',
        projectId: 'agent-spaces',
        mode: 'task',
        scope: 'agent:cody:project:agent-spaces',
        lane: 'main',
        harness: 'codex',
        presentation: false,
      },
      declaredOverrides: {},
    }

    const outcome = await service.inspectAgentSelection({ agentId: 'cody', request })

    if (!outcome.ok) throw new Error(JSON.stringify(outcome.diagnostics))
    expect(outcome.inspection.completeness).toEqual({ kind: 'complete' })
    expect(JSON.stringify(outcome.inspection)).toContain(`cwd=${fixture.projectRoot}`)
  })

  test('runtime placement inspection renders the project-gated exec', async () => {
    const service = createAspcService({ agentsRoot: fixture.agentsRoot })
    // This producer's predicates read the process cwd; launch from the project.
    const originalCwd = process.cwd()
    process.chdir(fixture.projectRoot)

    const response = await service
      .inspectRuntimePlacement({
        schemaVersion: 'aspc-inspect-runtime-placement-request/v1',
        context: {
          agentId: 'cody',
          agentRoot: join(fixture.agentsRoot, 'cody'),
          project: { mode: 'root', projectRoot: fixture.projectRoot, projectId: 'agent-spaces' },
          cwd: fixture.projectRoot,
          runMode: 'task',
          agentSources: { agentsRoot: fixture.agentsRoot },
        },
      })
      .finally(() => process.chdir(originalCwd))

    if (!response.ok) throw new Error(JSON.stringify(response))
    expect(response.inspection.completeness).toEqual({ kind: 'complete' })
    expect(JSON.stringify(response.inspection)).toContain(`cwd=${fixture.projectRoot}`)
  })
})
