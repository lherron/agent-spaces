/**
 * Brain-env parity: GBRAIN_HOME / BRAIN_REPO must be composed and advertised on
 * the SAME terms as the legacy `asp run` adapter path — i.e. ONLY at the real
 * (non-dry) spawn.
 *
 * The legacy adapter path gates brain env on `!options.dryRun` (execute.ts):
 * prepareAgentBrainRuntime is not a pure compose — it ensureDirectory()s, may
 * `gbrain init`, and registers sources. So a dry-run / --print-command MUST NOT
 * compose brain env, MUST NOT advertise GBRAIN_HOME/BRAIN_REPO, and MUST NOT
 * trigger any gbrain side effect. The compiler foreground profile must match:
 * absent on dry-run, present (== legacy) on a real launch.
 *
 * This regression was masked by the original byte-parity fixture having brain
 * DISABLED — so this fixture enables brain and stubs gbrain via a shim that logs
 * every invocation, letting us assert "no side effects on dry-run" directly.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
  gbrainPath: string
  gbrainLog: string
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'asp-run-compile-brain-'))
  const agentsRoot = join(base, 'agents')
  const agentRoot = join(agentsRoot, AGENT_NAME)
  const projectRoot = join(base, 'project')
  const aspHome = join(base, 'asp-home')
  const gbrainLog = join(base, 'gbrain-invocations.log')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })

  // Agent profile with brain ENABLED (the axis the original fixture could not see).
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

  // gbrain shim: logs every invocation (so we can prove a dry-run does NOT
  // invoke it), emits empty `sources list` so the brain runtime proceeds to add.
  const gbrainPath = shim(
    join(aspHome, 'gbrain'),
    `#!/usr/bin/env bash
echo "$@" >> "$GBRAIN_INVOCATION_LOG"
exit 0
`
  )

  return {
    agentRoot,
    agentsRoot,
    projectRoot,
    aspHome,
    claudePath,
    gbrainPath,
    gbrainLog,
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
      idempotencyKey: 'run-compile-brain-env-parity',
    },
    placement: {
      agentRoot: fixture.agentRoot,
      projectRoot: fixture.projectRoot,
      cwd: fixture.projectRoot,
      runMode: 'query',
      bundle: { kind: 'agent-project', agentName: AGENT_NAME, projectRoot: fixture.projectRoot },
      // The dry-run signal the compiler must honor: skip brain composition/side
      // effects (matches legacy execute.ts `!options.dryRun`).
      dryRun,
    },
    requested: {
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
      harnessFamily: 'claude-code',
      preferredHarnessRuntime: 'claude-code-cli',
      interactionMode: 'interactive',
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
      appSessionKey: 'run-compile-brain-env-parity',
    },
  }
}

/** Run with stdout/stderr swallowed (legacy non-dry path renders + spawns the shim). */
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

const BRAIN_KEYS = ['GBRAIN_HOME', 'BRAIN_REPO'] as const

describe('asp run <-> compiler brain-env parity', () => {
  beforeAll(() => {
    fixture = createFixture()
    setEnv('ASP_AGENTS_ROOT', fixture.agentsRoot)
    setEnv('ASP_CLAUDE_PATH', fixture.claudePath)
    setEnv('GBRAIN_BIN', fixture.gbrainPath)
    setEnv('GBRAIN_INVOCATION_LOG', fixture.gbrainLog)
  })

  afterAll(() => {
    restoreEnv()
    fixture.cleanup()
  })

  test('dry-run: neither legacy nor compiler advertises brain env, and no gbrain side effects', async () => {
    if (existsSync(fixture.gbrainLog)) rmSync(fixture.gbrainLog)

    // Legacy adapter path, dry-run.
    const legacy = await run(AGENT_NAME, {
      projectPath: fixture.projectRoot,
      aspHome: fixture.aspHome,
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      interactive: true,
      dryRun: true,
    })
    expect(legacy.launch).toBeDefined()
    for (const key of BRAIN_KEYS) {
      expect(legacy.launch!.env[key]).toBeUndefined()
    }

    // Compiler foreground path, dry-run.
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
    for (const key of BRAIN_KEYS) {
      expect(foreground.env[key]).toBeUndefined()
    }

    // A dry-run / --print-command MUST NOT mutate: the gbrain shim was never invoked.
    expect(existsSync(fixture.gbrainLog)).toBe(false)
  })

  test('real (non-dry) launch: compiler composes brain env == legacy', async () => {
    if (existsSync(fixture.gbrainLog)) rmSync(fixture.gbrainLog)

    // Legacy adapter path, real (non-dry) launch — spawns the (silent) claude shim.
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
    for (const key of BRAIN_KEYS) {
      expect(legacy.launch!.env[key]).toBeDefined()
    }

    // Compiler foreground path, real (non-dry) compile.
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

    // Brain env present AND byte-equal to the legacy adapter path.
    for (const key of BRAIN_KEYS) {
      expect(foreground.env[key]).toBeDefined()
      expect(foreground.env[key]).toBe(legacy.launch!.env[key])
    }

    // The real launch DID exercise gbrain (init + sources registration).
    expect(existsSync(fixture.gbrainLog)).toBe(true)
    const log = readFileSync(fixture.gbrainLog, 'utf8')
    expect(log).toContain('sources add')
  })
})
