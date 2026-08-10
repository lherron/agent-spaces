import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BrokerExecutionProfile, RuntimeCompileResponse } from 'spaces-runtime-contracts'

import { createAgentSpacesClient } from '../packages/agent-spaces/src/index.js'
import {
  BROKER_MANAGED_MATRIX_ROWS,
  MATRIX_ROW_NAMES,
  SPARKY_CODEX_MATRIX_ROWS,
  createSparkyCodexMatrixCompileRequest,
  structuredOutputEvidenceFailures,
} from './pre-hrc-broker-matrix-e2e.ts'

type CompileClient = ReturnType<typeof createAgentSpacesClient> & {
  compileRuntimePlan(
    request: ReturnType<typeof createSparkyCodexMatrixCompileRequest>
  ): Promise<RuntimeCompileResponse>
}

function brokerProfile(response: RuntimeCompileResponse): BrokerExecutionProfile {
  expect(response.ok).toBe(true)
  if (!response.ok) throw new Error(JSON.stringify(response.diagnostics))
  const profile = response.plan.executionProfiles.find(
    (candidate): candidate is BrokerExecutionProfile => candidate.kind === 'harness-broker'
  )
  expect(profile).toBeDefined()
  if (profile === undefined) throw new Error('missing broker profile')
  return profile
}

describe('pre-HRC MATRIX fixture contracts', () => {
  const base = mkdtempSync(join(tmpdir(), 'matrix-fixture-contract-'))
  const agentRoot = join(base, 'agents', 'sparky')
  const projectRoot = join(base, 'agent-spaces')
  const aspHome = join(base, 'asp-home')
  const toolBin = join(agentRoot, 'tools', 'bin')
  const originalCodexPath = process.env['ASP_CODEX_PATH']
  const originalSkipCommon = process.env['ASP_CODEX_SKIP_COMMON_PATHS']

  beforeAll(() => {
    mkdirSync(toolBin, { recursive: true })
    mkdirSync(projectRoot, { recursive: true })
    mkdirSync(aspHome, { recursive: true })
    writeFileSync(
      join(agentRoot, 'agent-profile.toml'),
      `schemaVersion = 2

[identity]
display = "Sparky"
role = "smoke"
harness = "pi-sdk"

[spaces]
base = []

[harnessDefaults]
model = "openai-codex/gpt-5.5"
`,
      'utf8'
    )
    writeFileSync(join(toolBin, 'sparky-spark'), '#!/usr/bin/env bash\nexit 0\n', 'utf8')
    chmodSync(join(toolBin, 'sparky-spark'), 0o755)
    const codexPath = join(aspHome, 'codex')
    writeFileSync(
      codexPath,
      `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "codex 999.0.0"
  exit 0
fi
if [[ "$1" == "app-server" && "$2" == "--help" ]]; then
  echo "app-server"
  exit 0
fi
echo "codex shim"
`,
      'utf8'
    )
    chmodSync(codexPath, 0o755)
    process.env['ASP_CODEX_PATH'] = codexPath
    process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
  })

  afterAll(() => {
    if (originalCodexPath === undefined) process.env['ASP_CODEX_PATH'] = undefined
    else process.env['ASP_CODEX_PATH'] = originalCodexPath
    if (originalSkipCommon === undefined) process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = undefined
    else process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalSkipCommon
    rmSync(base, { recursive: true, force: true })
  })

  test('all three Sparky Codex rows override the Pi-qualified default with bare gpt-5.5', async () => {
    const client = createAgentSpacesClient({ aspHome }) as CompileClient

    for (const row of SPARKY_CODEX_MATRIX_ROWS) {
      const request = createSparkyCodexMatrixCompileRequest(row, {
        scopeRef: 'sparky@agent-spaces',
        agentRoot,
        projectRoot,
        cwd: projectRoot,
        prompt: `fixture prompt for ${row}`,
        marker: row.replaceAll('-', '_'),
        timeoutMs: 10_000,
      })

      expect(request.requested.model).toBe('gpt-5.5')
      expect(request.requested.preferredHarnessRuntime).toBe('codex-cli')
      expect(request.placement.agentRoot).toBe(agentRoot)

      const profile = brokerProfile(await client.compileRuntimePlan(request))
      expect(profile.brokerDriver).toBe(
        row === 'real-codex' ? 'codex-app-server' : 'codex-cli-tmux'
      )
      expect(profile.harnessInvocation.startRequest.spec.process.pathPrepend).toContain(toolBin)
    }
  })

  test('Pi-qualified gpt-5.5 remains rejected by the codex-cli frontend', async () => {
    const client = createAgentSpacesClient({ aspHome }) as CompileClient
    const request = createSparkyCodexMatrixCompileRequest('real-codex', {
      scopeRef: 'sparky@agent-spaces',
      agentRoot,
      projectRoot,
      cwd: projectRoot,
      prompt: 'reject the Pi-qualified model',
      marker: 'qualified_model_rejection',
      timeoutMs: 10_000,
    })

    await expect(
      client.compileRuntimePlan({
        ...request,
        requested: { ...request.requested, model: 'openai-codex/gpt-5.5' },
      })
    ).rejects.toThrow('Model not supported for frontend codex-cli: openai-codex/gpt-5.5')
  })

  test('every broker-managed row fails closed when structured-output evidence is omitted', () => {
    expect(new Set(BROKER_MANAGED_MATRIX_ROWS)).toEqual(new Set(MATRIX_ROW_NAMES))

    for (const name of BROKER_MANAGED_MATRIX_ROWS) {
      expect(structuredOutputEvidenceFailures({ name, notes: {} })).toEqual([
        {
          code: 'structured_output_evidence_missing',
          message: `${name} did not record structured-output scenario evidence`,
        },
      ])

      expect(
        structuredOutputEvidenceFailures({
          name,
          notes: {
            structuredOutput: {
              scenario: 'structured-output',
            },
          },
        })
      ).toEqual([])
    }
  })

  test('the pi-sdk driver row rejects structured-output as not applicable', () => {
    const disposition = {
      scenario: 'structured-output',
      disposition: 'not-applicable',
      reason: 'broker input/capability surface must produce a real structured result',
    }
    expect(
      structuredOutputEvidenceFailures({
        name: 'real-pi-sdk-driver',
        notes: {
          structuredOutput: disposition,
        },
      })
    ).toEqual([
      {
        code: 'structured_output_evidence_invalid',
        message:
          'real-pi-sdk-driver recorded structured-output as not applicable despite using the broker input/capability surface',
      },
    ])
  })
})
