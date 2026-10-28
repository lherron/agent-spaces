import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentInspectionRequest } from 'spaces-runtime-contracts'

import { createAspcService } from '../src/index.js'

// T-12016: ACP builds the service in-process with only `resolveProjectRoot`.
// A bare service must compile with real execution dependencies, and a template
// with a services section must resolve from live probes the authority pins.

type Fixture = { root: string; agentsRoot: string; projectRoot: string }

let fixture: Fixture
let server: ReturnType<typeof Bun.serve>

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'aspc-in-process-inspection-'))
  const agentsRoot = join(root, 'agents')
  const projectRoot = join(root, 'project')
  const agentRoot = join(agentsRoot, 'cody')
  await mkdir(agentRoot, { recursive: true })
  await mkdir(projectRoot, { recursive: true })
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') })
  await writeFile(
    join(agentRoot, 'agent-profile.toml'),
    'version = 4\n\n[provisioning]\nharness = "codex"\n\n[spaces]\nbase = []\n'
  )
  await writeFile(join(agentRoot, 'SOUL.md'), 'Cody soul\n')
  await writeFile(
    join(agentRoot, 'context-template.toml'),
    `schema_version = 2
mode = "replace"

[[prompt]]
name = "soul"
type = "inline"
content = "Cody soul"

[[reminder]]
name = "services"
type = "service-probe"
header = "Services:"
services = [
  { name = "live", endpoint = "http://127.0.0.1:${server.port}" },
  { name = "dead", endpoint = "unix://${join(root, 'absent.sock')}" },
]

[[reminder]]
name = "skipped-services"
type = "service-probe"
when = { runMode = "heartbeat" }
services = [{ name = "never", endpoint = "http://127.0.0.1:1" }]
`
  )
  fixture = { root, agentsRoot, projectRoot }
})

afterEach(async () => {
  server.stop(true)
  await rm(fixture.root, { recursive: true, force: true })
})

describe('in-process ASPC agent inspection (T-12016)', () => {
  test('a bare service inspects a codex agent whose template probes services', async () => {
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

    expect(outcome.ok ? outcome.inspection.diagnostics : outcome.diagnostics).toEqual([])
    const rendered = JSON.stringify(outcome)
    expect(rendered).toContain('✅ live')
    expect(rendered).toContain('❌ dead')
    expect(rendered).not.toMatch(/[✅❌] never/)
  })
})
