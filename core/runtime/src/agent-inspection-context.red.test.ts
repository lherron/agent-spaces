import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Runtime from './index.js'

type NormalizedInspectionContext = {
  resolverContext: Parameters<typeof Runtime.resolveContextTemplateDetailed>[1]
  compileContext: {
    nowIso: string
    idSalt: string
    toolchainManifest: Record<string, unknown>
  }
}

type NormalizeInspectionContext = (value: unknown) => NormalizedInspectionContext

const AMBIENT_SET = 'ASP_INSPECTION_AMBIENT_SET_T06328'
const AMBIENT_EQUALS = 'ASP_INSPECTION_AMBIENT_EQUALS_T06328'
const PINNED_VALUE = 'ASP_INSPECTION_PINNED_T06328'

let cleanupRoot: string | undefined
let originalCwd: string | undefined
const originalEnv = {
  [AMBIENT_SET]: process.env[AMBIENT_SET],
  [AMBIENT_EQUALS]: process.env[AMBIENT_EQUALS],
  [PINNED_VALUE]: process.env[PINNED_VALUE],
}

afterEach(async () => {
  if (originalCwd !== undefined) {
    process.chdir(originalCwd)
    originalCwd = undefined
  }
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
  if (cleanupRoot !== undefined) {
    await rm(cleanupRoot, { recursive: true, force: true })
    cleanupRoot = undefined
  }
})

describe('inspection evaluation context', () => {
  test('keeps Layer A output byte-identical across ambient cwd and env mutation', async () => {
    const normalize = (Runtime as Record<string, unknown>)[
      'normalizeAgentInspectionEvaluationContext'
    ]
    expect(
      normalize,
      'normalizeAgentInspectionEvaluationContext must be exported by spaces-runtime'
    ).toBeFunction()

    originalCwd = process.cwd()
    cleanupRoot = await mkdtemp(join(tmpdir(), 'agent-inspection-context-'))
    const agentRoot = join(cleanupRoot, 'agent')
    const agentsRoot = join(cleanupRoot, 'agents')
    const projectRoot = join(cleanupRoot, 'project')
    const ambientA = join(cleanupRoot, 'ambient-a')
    const ambientB = join(cleanupRoot, 'ambient-b')
    for (const directory of [agentRoot, agentsRoot, projectRoot, ambientA, ambientB]) {
      await mkdir(directory, { recursive: true })
    }
    await writeFile(join(projectRoot, 'inspection-enabled.flag'), 'enabled\n')

    const explicitContext = {
      schemaVersion: 'agent-inspection-evaluation-context/v1',
      identifiers: {
        agentId: 'room-tester',
        agentName: 'Room Tester',
        projectId: 'agent-spaces',
        mode: 'task',
        scope: 'room-tester@agent-spaces:T-06328',
        taskId: 'T-06328',
        lane: 'main',
        harness: 'codex',
        frontend: 'taskboard',
        interaction: 'headless',
      },
      paths: { agentRoot, agentsRoot, projectRoot, cwd: projectRoot },
      nowIso: '2026-07-18T12:34:56.000Z',
      environment: {
        [AMBIENT_SET]: 'explicit-set',
        [AMBIENT_EQUALS]: 'explicit-equal',
        [PINNED_VALUE]: 'explicit-template-value',
      },
      predicateInputs: {
        cwd: projectRoot,
        environment: {
          [AMBIENT_SET]: 'explicit-set',
          [AMBIENT_EQUALS]: 'explicit-equal',
        },
      },
      execInputs: { cwd: agentRoot, environment: {} },
      serviceProbeInputs: { responses: [] },
      scaffoldPackets: [],
      agentProfile: {},
      declaredOverrides: { modelId: 'gpt-5' },
      compileContext: {
        nowIso: '2026-07-18T12:34:56.000Z',
        idSalt: 'inspection-t06328',
        toolchainManifest: {
          schemaVersion: 'compile-toolchain/v1',
          tools: [{ name: 'agent-spaces', version: 'test' }],
        },
      },
    }
    const template = Runtime.parseContextTemplate(`
schema_version = 2
mode = "replace"

[[prompt]]
name = "exists"
type = "inline"
content = "exists={{dateUtc}}"
when = { exists = "inspection-enabled.flag" }

[[prompt]]
name = "env-set"
type = "inline"
content = "set={{env.${PINNED_VALUE}}}"
when = { envSet = "${AMBIENT_SET}" }

[[prompt]]
name = "env-equals"
type = "inline"
content = "equals"
when = { envEquals = { name = "${AMBIENT_EQUALS}", value = "explicit-equal" } }

[[prompt]]
name = "exec-cwd"
type = "exec"
command = "printf '%s' \\"$PWD\\""
`)

    const resolveUnderAmbient = async (ambientCwd: string, envValue: string) => {
      process.chdir(ambientCwd)
      process.env[AMBIENT_SET] = envValue
      process.env[AMBIENT_EQUALS] = envValue
      process.env[PINNED_VALUE] = envValue
      const pinned = (normalize as NormalizeInspectionContext)(explicitContext)
      expect(pinned.compileContext).toEqual(explicitContext.compileContext)
      return JSON.stringify(
        await Runtime.resolveContextTemplateDetailed(template, pinned.resolverContext)
      )
    }

    const first = await resolveUnderAmbient(ambientA, 'ambient-first')
    const second = await resolveUnderAmbient(ambientB, 'ambient-second')

    expect(first).toBe(second)
    expect(first).toContain('2026-07-18T12:34:56.000Z')
    expect(first).toContain('explicit-template-value')
    expect(first).toContain(agentRoot)
    expect(first).not.toContain('ambient-first')
    expect(first).not.toContain('ambient-second')
  })
})
