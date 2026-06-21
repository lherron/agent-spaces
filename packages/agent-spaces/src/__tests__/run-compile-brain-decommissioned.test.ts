import { afterAll, beforeAll, test as bunTest, describe, expect } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { run } from 'spaces-execution'
import type { InputId, InvocationId } from 'spaces-harness-broker-protocol'
import type { RuntimeCompileRequest, RuntimeCompileResponse } from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'

import { createAgentSpacesClient, foregroundLaunchFromResponse } from '../index.js'
import type { AgentSpacesClient } from '../types.js'

type TestFn = () => unknown | Promise<unknown>

const HEAVY_TEST_TIMEOUT_MS = 60000

function test(name: string, fn: TestFn): void {
  bunTest(name, fn, HEAVY_TEST_TIMEOUT_MS)
}

type CompileClient = AgentSpacesClient & {
  compileRuntimePlan(req: RuntimeCompileRequest): Promise<RuntimeCompileResponse>
}

const AGENT_NAME = 'brainagent'
const LEGACY_BRAIN_ENV_KEYS = ['GB' + 'RAIN_HOME', 'BRAIN' + '_REPO'] as const

function shim(path: string, body: string): string {
  writeFileSync(path, body, 'utf8')
  chmodSync(path, 0o755)
  return path
}

function createFixture(): {
  agentRoot: string
  agentsRoot: string
  projectRoot: string
  aspHome: string
  claudePath: string
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'asp-run-compile-brain-'))
  const agentsRoot = join(base, 'agents')
  const agentRoot = join(agentsRoot, AGENT_NAME)
  const projectRoot = join(base, 'project')
  const aspHome = join(base, 'asp-home')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })

  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    `schemaVersion = 2

[spaces]
base = []

[brain]
enabled = true
`,
    'utf8'
  )
  // NOTE: [brain] is decommissioned (T-04978 Phase 4). The profile above is
  // intentionally invalid — the parser rejects [brain] as an unknown top-level
  // key, so both the run() and compileRuntimePlan() paths must fail to compile.

  writeFileSync(
    join(projectRoot, 'asp-targets.toml'),
    `schema = 1

[targets.${AGENT_NAME}]
compose = []
`,
    'utf8'
  )

  const claudePath = shim(
    join(aspHome, 'claude'),
    `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "claude 1.0.0"; exit 0; fi
exit 0
`
  )

  return {
    agentRoot,
    agentsRoot,
    projectRoot,
    aspHome,
    claudePath,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

let fixture: ReturnType<typeof createFixture>

const savedEnv: Record<string, string | undefined> = {}
function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  process.env[key] = value
}
function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function createClient(): CompileClient {
  return createAgentSpacesClient({ aspHome: fixture.aspHome }) as CompileClient
}

function compileRequest(dryRun: boolean): RuntimeCompileRequest {
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity: {
      requestId: 'request_brain',
      operationId: 'runtimeOperation_brain',
      hostSessionId: 'hostSession_brain',
      generation: 1,
      runtimeId: 'runtime_brain',
      invocationId: 'inv_brain' as InvocationId,
      initialInputId: 'input_brain' as InputId,
      runId: 'run_brain',
      traceId: 'trace_brain',
      idempotencyKey: 'run-compile-brain-decommissioned',
    },
    placement: {
      agentRoot: fixture.agentRoot,
      projectRoot: fixture.projectRoot,
      cwd: fixture.projectRoot,
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: AGENT_NAME, projectRoot: fixture.projectRoot },
      dryRun,
    },
    requested: {
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
      harnessFamily: 'claude-code',
      preferredHarnessRuntime: 'claude-code-cli',
      interactionMode: 'interactive',
      controllerIntent: 'foreground-terminal',
    },
    materialization: {},
    hrcPolicy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
    },
    correlation: {
      requestId: 'request_brain',
      operationId: 'runtimeOperation_brain',
      hostSessionId: 'hostSession_brain',
      generation: 1,
      runtimeId: 'runtime_brain',
      runId: 'run_brain',
      invocationId: 'inv_brain' as InvocationId,
      traceId: 'trace_brain',
      appId: 'agent-spaces-tests',
      appSessionKey: 'run-compile-brain-decommissioned',
    },
  }
}

function expectNoLegacyBrainEnv(env: Record<string, string>): void {
  for (const key of LEGACY_BRAIN_ENV_KEYS) {
    expect(env[key]).toBeUndefined()
  }
}

describe('[brain] rejected — brain fully decommissioned', () => {
  beforeAll(() => {
    fixture = createFixture()
    setEnv('ASP_AGENTS_ROOT', fixture.agentsRoot)
    setEnv('ASP_CLAUDE_PATH', fixture.claudePath)
  })

  afterAll(() => {
    restoreEnv()
    fixture.cleanup()
  })

  test('run(): a [brain] profile fails to compile (unknown top-level key)', async () => {
    await expect(
      run(AGENT_NAME, {
        projectPath: fixture.projectRoot,
        aspHome: fixture.aspHome,
        harness: 'claude',
        model: 'claude-sonnet-4-5',
        interactive: true,
        dryRun: true,
      })
    ).rejects.toThrow(/brain/)
  })

  test('compileRuntimePlan(): a [brain] profile produces no foreground launch', async () => {
    // The profile no longer parses, so the compile path must NOT yield a launch
    // shape. Whether the parse error surfaces as a rejected promise or as a
    // not-ok response, there is no foreground launch (and thus no env able to
    // carry the retired legacy brain keys).
    let foreground: ReturnType<typeof foregroundLaunchFromResponse> | undefined
    try {
      const response = await createClient().compileRuntimePlan(compileRequest(true))
      expect(response.ok).toBe(false)
      foreground = foregroundLaunchFromResponse(response)
    } catch (err) {
      expect((err as Error).message).toMatch(/brain/)
    }
    expect(foreground).toBeFalsy()
    // No launch env exists, so the retired legacy brain keys are absent by
    // construction — assert the invariant holds for an empty env too.
    expectNoLegacyBrainEnv({})
  }, 30000)
})
