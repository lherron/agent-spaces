import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAspcService } from '../src/index.js'

// T-12027: runtime-placement inspection (HRC's dry-run path) checks
// `when.exists` against the placement's folder, not the daemon's process cwd.

type Fixture = { root: string; agentsRoot: string; projectRoot: string }

let fixture: Fixture
let originalCwd: string

beforeEach(async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aspc-when-cwd-')))
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
type = "inline"
content = "project has a justfile"
when = { exists = "justfile" }
`
  )
  fixture = { root, agentsRoot, projectRoot }
  // The inspecting process sits outside the project, as a daemon does.
  originalCwd = process.cwd()
  process.chdir(root)
})

afterEach(async () => {
  process.chdir(originalCwd)
  await rm(fixture.root, { recursive: true, force: true })
})

describe('runtime placement inspection resolves when.exists in the placement folder (T-12027)', () => {
  test('a justfile-gated reminder renders though the process cwd has no justfile', async () => {
    const service = createAspcService({ agentsRoot: fixture.agentsRoot })
    const response = await service.inspectRuntimePlacement({
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

    if (!response.ok) throw new Error(JSON.stringify(response))
    expect(JSON.stringify(response.inspection)).toContain('project has a justfile')
  })
})
