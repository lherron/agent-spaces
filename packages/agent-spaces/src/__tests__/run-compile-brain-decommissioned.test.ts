import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type RunResult, run } from 'spaces-execution'
import type { InputId, InvocationId } from 'spaces-harness-broker-protocol'
import type { RuntimeCompileRequest, RuntimeCompileResponse } from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'

import { createAgentSpacesClient, foregroundLaunchFromResponse } from '../index.js'
import type { AgentSpacesClient } from '../types.js'

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

async function runSilently(fn: () => Promise<RunResult>): Promise<RunResult> {
  const outOrig = process.stdout.write.bind(process.stdout)
  const errOrig = process.stderr.write.bind(process.stderr)
  ;(process.stdout as unknown as { write: (c: unknown) => boolean }).write = () => true
  ;(process.stderr as unknown as { write: (c: unknown) => boolean }).write = () => true
  try {
    return await fn()
  } finally {
    ;(process.stdout as unknown as { write: typeof outOrig }).write = outOrig
    ;(process.stderr as unknown as { write: typeof errOrig }).write = errOrig
  }
}

function expectNoLegacyBrainEnv(env: Record<string, string>): void {
  for (const key of LEGACY_BRAIN_ENV_KEYS) {
    expect(env[key]).toBeUndefined()
  }
}

describe('decommissioned brain runtime', () => {
  beforeAll(() => {
    fixture = createFixture()
    setEnv('ASP_AGENTS_ROOT', fixture.agentsRoot)
    setEnv('ASP_CLAUDE_PATH', fixture.claudePath)
  })

  afterAll(() => {
    restoreEnv()
    fixture.cleanup()
  })

  test('dry-run: enabled brain profile does not advertise legacy env', async () => {
    const legacy = await run(AGENT_NAME, {
      projectPath: fixture.projectRoot,
      aspHome: fixture.aspHome,
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      interactive: true,
      dryRun: true,
    })
    expect(legacy.launch).toBeDefined()
    expectNoLegacyBrainEnv(legacy.launch!.env)

    const response = await createClient().compileRuntimePlan(compileRequest(true))
    const foreground = foregroundLaunchFromResponse(response)
    if (!foreground) {
      throw new Error(
        `compileRuntimePlan produced no foreground launch: ${
          response.ok
            ? 'ok but no terminal profile'
            : response.diagnostics.map((d) => d.code).join(', ')
        }`
      )
    }
    expectNoLegacyBrainEnv(foreground.env)
  })

  test('real launch: enabled brain profile still does not advertise legacy env', async () => {
    const legacy = await runSilently(() =>
      run(AGENT_NAME, {
        projectPath: fixture.projectRoot,
        aspHome: fixture.aspHome,
        harness: 'claude',
        model: 'claude-sonnet-4-5',
        interactive: true,
        dryRun: false,
      })
    )
    expect(legacy.launch).toBeDefined()
    expectNoLegacyBrainEnv(legacy.launch!.env)

    const response = await createClient().compileRuntimePlan(compileRequest(false))
    const foreground = foregroundLaunchFromResponse(response)
    if (!foreground) {
      throw new Error(
        `compileRuntimePlan produced no foreground launch: ${
          response.ok
            ? 'ok but no terminal profile'
            : response.diagnostics.map((d) => d.code).join(', ')
        }`
      )
    }
    expectNoLegacyBrainEnv(foreground.env)
  }, 30000)
})
