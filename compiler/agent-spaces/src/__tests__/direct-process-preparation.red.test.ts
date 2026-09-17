/**
 * T-08577 behavior reds for ASP-owned direct process preparation.
 *
 * The legacy builder is executed first as the green control. The new operation
 * is then reached through the existing `createAgentSpacesClient` object so this
 * file collects even before the additive method exists. Green requires byte
 * parity with the real builder, exact caller correlation behavior, structured
 * prompts, and no native harness launch.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimePlacement } from 'spaces-config'
import { compilerRuntime } from '../../../../integration-tests/tests/compiler-runtime.js'
import { createAgentSpacesClient } from '../index.js'
import type { BuildProcessInvocationSpecRequest } from '../types.js'

type UnknownRecord = Record<string, unknown>
type PrepareProcessInvocation = (request: UnknownRecord) => Promise<UnknownRecord>

type Fixture = {
  base: string
  agentRoot: string
  agentsRoot: string
  projectRoot: string
  aspHome: string
  processLog: string
  cleanup(): void
}

const fixtures: Fixture[] = []
const originalCodexPath = process.env['ASP_CODEX_PATH']
const originalSkipCommon = process.env['ASP_CODEX_SKIP_COMMON_PATHS']

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
  if (originalCodexPath === undefined) process.env['ASP_CODEX_PATH'] = undefined
  else process.env['ASP_CODEX_PATH'] = originalCodexPath
  if (originalSkipCommon === undefined) process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = undefined
  else process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalSkipCommon
})

function fixture(): Fixture {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 't08577-direct-')))
  const agentsRoot = join(base, 'agents')
  const agentRoot = join(agentsRoot, 'cody')
  const projectRoot = join(base, 'agent-spaces')
  const aspHome = join(base, 'asp-home')
  const processLog = join(base, 'codex-processes.log')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  writeFileSync(join(aspHome, 'config.toml'), `agents-root = ${JSON.stringify(agentsRoot)}\n`)
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    `version = 3
priming = "Agent {{handle}} works in {{projectId}} on {{lane}}."

[spaces]
base = []

[provisioning]
harness = "codex"

[provisioning.codex]
model = "gpt-5.3-codex"
model_reasoning_effort = "medium"
approval_policy = "on-failure"
sandbox_mode = "workspace-write"
`,
    'utf8'
  )
  writeFileSync(join(agentRoot, 'SOUL.md'), '# T08577 system\nSystem material is structured.\n')

  const codex = join(base, 'codex')
  writeFileSync(
    codex,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(processLog)}
if [[ "$1" == "--version" ]]; then
  echo "codex 999.0.0"
  exit 0
fi
if [[ "$1" == "app-server" && "$2" == "--help" ]]; then
  echo "app-server"
  exit 0
fi
echo "A preparation test must never execute the native harness" >&2
exit 97
`,
    { mode: 0o755 }
  )
  chmodSync(codex, 0o755)
  process.env['ASP_CODEX_PATH'] = codex
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'

  const created = {
    base,
    agentRoot,
    agentsRoot,
    projectRoot,
    aspHome,
    processLog,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
  fixtures.push(created)
  return created
}

function placement(f: Fixture, correlation: RuntimePlacement['correlation']): RuntimePlacement {
  return {
    agentRoot: f.agentRoot,
    projectRoot: f.projectRoot,
    cwd: f.projectRoot,
    runMode: 'task',
    bundle: { kind: 'agent-project', agentName: 'cody', projectRoot: f.projectRoot },
    correlation,
  }
}

function legacyRequest(
  f: Fixture,
  correlation: RuntimePlacement['correlation']
): BuildProcessInvocationSpecRequest {
  return {
    placement: placement(f, correlation),
    provider: 'openai',
    frontend: 'codex-cli',
    interactionMode: 'headless',
    ioMode: 'pipes',
    prompt: 'Caller asks from {{handle}}.',
    dispatchEnv: { CALLER_FLAG: 't08577' },
  } as unknown as BuildProcessInvocationSpecRequest
}

function preparationRequest(
  f: Fixture,
  preparationCorrelation: RuntimePlacement['correlation'],
  expected: UnknownRecord = { provider: 'openai', frontend: 'codex-cli' }
): UnknownRecord {
  return {
    schemaVersion: 'aspc-prepare-process-invocation-request/v1',
    context: {
      agentId: 'cody',
      agentRoot: f.agentRoot,
      project: { mode: 'root', projectRoot: f.projectRoot, projectId: 'agent-spaces' },
      cwd: f.projectRoot,
      runMode: 'task',
      taskId: 'T-08577',
      agentSources: { aspHome: f.aspHome, agentsRoot: f.agentsRoot },
    },
    preparationCorrelation,
    expected,
    launch: {
      interactionMode: 'headless',
      ioMode: 'pipes',
      prompt: 'Caller asks from {{handle}}.',
    },
    dispatchEnv: { CALLER_FLAG: 't08577' },
  }
}

function requirePreparation(client: object): PrepareProcessInvocation {
  const candidate = (client as UnknownRecord)['prepareProcessInvocation']
  expect(
    typeof candidate,
    'createAgentSpacesClient must expose the additive prepareProcessInvocation seam'
  ).toBe('function')
  return candidate as PrepareProcessInvocation
}

function processProbeLines(f: Fixture): string[] {
  if (!existsSync(f.processLog)) return []
  return readFileSync(f.processLog, 'utf8').split('\n').filter(Boolean)
}

function expectOnlyAvailabilityProbes(f: Fixture): void {
  const lines = processProbeLines(f)
  expect(lines.length).toBeGreaterThan(0)
  expect(
    lines.every((line) => line === '--version' || line === 'app-server --help'),
    `preparation executed a native command: ${lines.join(' | ')}`
  ).toBe(true)
}

describe('direct process preparation (T-08577)', () => {
  test('control: the real legacy builder consumes caller-authored correlation', async () => {
    const f = fixture()
    const correlation = {
      sessionRef: {
        scopeRef: 'agent:cody:project:agent-spaces:task:T-08577:role:tester',
        laneRef: 'lane:repair',
      },
      hostSessionId: 'hsid-t08577',
    }
    const client = createAgentSpacesClient({ aspHome: f.aspHome, runtime: compilerRuntime })
    const baseline = await client.buildProcessInvocationSpec(legacyRequest(f, correlation))

    expect(baseline.spec.env['AGENT_SCOPE_REF']).toBe(correlation.sessionRef.scopeRef)
    expect(baseline.spec.env['AGENT_LANE']).toBe('repair')
    expect(baseline.spec.env['AGENT_HOST_SESSION_ID']).toBe('hsid-t08577')
    expect(baseline.spec.env['CALLER_FLAG']).toBe('t08577')
    expectOnlyAvailabilityProbes(f)
  })

  test('B1/B2/B3: producer output is byte-equal to the correlated legacy builder and adds structured prompts', async () => {
    const f = fixture()
    const correlation = {
      sessionRef: {
        scopeRef: 'agent:cody:project:agent-spaces:task:T-08577:role:tester',
        laneRef: 'lane:repair',
      },
      hostSessionId: 'hsid-t08577',
    }
    const client = createAgentSpacesClient({ aspHome: f.aspHome, runtime: compilerRuntime })
    const baseline = await client.buildProcessInvocationSpec(legacyRequest(f, correlation))
    const prepare = requirePreparation(client)
    const response = await prepare.call(client, preparationRequest(f, correlation))

    expect(response['ok']).toBe(true)
    expect(response['spec']).toEqual(baseline.spec)
    expect(response['resolvedBundle']).toEqual(baseline.resolvedBundle)
    expect(response['warnings'] ?? []).toEqual(baseline.warnings ?? [])
    expect(response['declaration']).toMatchObject({
      provider: 'openai',
      frontend: 'codex-cli',
      agentSources: {
        aspHome: f.aspHome,
        agentsRoot: f.agentsRoot,
        provenance: 'caller-agent-root',
      },
    })
    expect((response['spec'] as UnknownRecord)['prompts']).toEqual({
      system: expect.objectContaining({
        content: expect.stringContaining('System material is structured.'),
        mode: expect.stringMatching(/append|replace/),
      }),
      priming: {
        content: baseline.spec.codexAppServer?.prompt,
      },
    })
    expect(Object.hasOwn(response, 'worker')).toBe(false)
    expectOnlyAvailabilityProbes(f)
  })

  test('B3: an empty required correlation stays empty and never derives an app identity', async () => {
    const f = fixture()
    const client = createAgentSpacesClient({ aspHome: f.aspHome, runtime: compilerRuntime })
    const prepare = requirePreparation(client)
    const response = await prepare.call(client, preparationRequest(f, {}))

    expect(response['ok']).toBe(true)
    const env = ((response['spec'] as UnknownRecord)['env'] ?? {}) as UnknownRecord
    expect(env['AGENT_SCOPE_REF']).toBeUndefined()
    expect(env['AGENT_SESSION_REF']).toBeUndefined()
    expect(env['AGENT_HOST_SESSION_ID']).toBeUndefined()
    expect(JSON.stringify(response)).not.toContain('app:')
    expectOnlyAvailabilityProbes(f)
  })

  test('B1/C3: a caller-supplied app scope is preserved literally rather than derived or rejected', async () => {
    const f = fixture()
    const correlation = {
      sessionRef: { scopeRef: 'app:caller-supplied', laneRef: 'lane:repair' },
    }
    const client = createAgentSpacesClient({ aspHome: f.aspHome, runtime: compilerRuntime })
    const baseline = await client.buildProcessInvocationSpec(legacyRequest(f, correlation))
    const prepare = requirePreparation(client)
    const response = await prepare.call(client, preparationRequest(f, correlation))

    expect(response['ok']).toBe(true)
    expect(response['spec']).toEqual(baseline.spec)
    const env = ((response['spec'] as UnknownRecord)['env'] ?? {}) as UnknownRecord
    expect(env['AGENT_SCOPE_REF']).toBe('app:caller-supplied')
    const structuredPrompts = JSON.stringify((response['spec'] as UnknownRecord)['prompts'])
    expect(structuredPrompts).toContain('app:caller-supplied')
    expect(structuredPrompts).toContain('repair')
    // HRC's unchanged final overlay rejects this scope later. The producer must
    // preserve today's builder result and must not turn it into supported app authority.
    expectOnlyAvailabilityProbes(f)
  })

  test('B7: provider/frontend declaration drift is a typed refusal with no partial spec', async () => {
    const f = fixture()
    const client = createAgentSpacesClient({ aspHome: f.aspHome, runtime: compilerRuntime })
    const prepare = requirePreparation(client)
    const response = await prepare.call(
      client,
      preparationRequest(f, {}, { provider: 'anthropic', frontend: 'claude-code' })
    )

    expect(response).toMatchObject({
      schemaVersion: 'aspc-prepare-process-invocation-response/v1',
      ok: false,
      failure: { kind: 'incompatible', code: 'declaration_changed' },
    })
    expect(Object.hasOwn(response, 'spec')).toBe(false)
    expectOnlyAvailabilityProbes(f)
  })
})
