/**
 * Compiled initial-input / priming-composition coverage.
 *
 * Migrated from the former client-broker-priming-composition.test.ts
 * direct-builder suite (C4 / Stream 1). Prompt expansion and initial-input
 * shaping is compiler-owned: the assertions run through compileRuntimePlan and
 * inspect the broker profile's start request rather than calling
 * buildHarnessBrokerInvocation directly.
 */
import { afterEach, test as bunTest, describe, expect } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { InputId, InvocationId } from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'

import { createAgentSpacesClient } from '../index.js'
import type { AgentSpacesClient } from '../types.js'

type TestFn = () => unknown | Promise<unknown>

const HEAVY_TEST_TIMEOUT_MS = 60000

function test(name: string, fn: TestFn): void {
  bunTest(name, fn, HEAVY_TEST_TIMEOUT_MS)
}

type CompileClient = AgentSpacesClient & {
  compileRuntimePlan(req: RuntimeCompileRequest): Promise<RuntimeCompileResponse>
}

function createCodexShim(dir: string): string {
  const shimPath = join(dir, 'codex')
  writeFileSync(
    shimPath,
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
  chmodSync(shimPath, 0o755)
  return shimPath
}

function createFixture(options: { primingPrompt?: string | undefined } = {}): {
  agentRoot: string
  projectRoot: string
  aspHome: string
  imagePath: string
  imagePath2: string
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'asp-compiler-broker-initial-input-'))
  const agentRoot = join(base, 'agents', 'cody')
  const projectRoot = join(base, 'agent-spaces')
  const aspHome = join(base, 'asp-home')
  const imagePath = join(base, 'diagram.png')
  const imagePath2 = join(base, 'diagram-two.png')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  writeFileSync(imagePath, 'not-really-a-png', 'utf8')
  writeFileSync(imagePath2, 'also-not-really-a-png', 'utf8')
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    `schemaVersion = 2
${options.primingPrompt !== undefined ? `priming_prompt = "${options.primingPrompt}"\n` : ''}
[spaces]
base = []

[brain]
enabled = false
`,
    'utf8'
  )
  createCodexShim(aspHome)
  return {
    agentRoot,
    projectRoot,
    aspHome,
    imagePath,
    imagePath2,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

type Fixture = ReturnType<typeof createFixture>

function compileRequest(
  fixture: Fixture,
  materialization: Partial<RuntimeCompileRequest['materialization']> = {},
  identityOverrides: Partial<RuntimeCompileRequest['identity']> = {}
): RuntimeCompileRequest {
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity: {
      requestId: 'request_T01610',
      operationId: 'runtimeOperation_T01610',
      hostSessionId: 'hostSession_T01610',
      generation: 1,
      runtimeId: 'runtime_T01610',
      invocationId: 'inv_T01610' as InvocationId,
      initialInputId: 'input_T01610' as InputId,
      ...identityOverrides,
    },
    placement: {
      agentRoot: fixture.agentRoot,
      projectRoot: fixture.projectRoot,
      cwd: fixture.projectRoot,
      runMode: 'task',
      bundle: { kind: 'agent-project', agentName: 'cody', projectRoot: fixture.projectRoot },
      correlation: {
        sessionRef: {
          scopeRef: 'agent:cody:project:agent-spaces:task:T-01610',
          laneRef: 'repair',
        },
        hostSessionId: 'host-01610',
      },
    } as RuntimeCompileRequest['placement'],
    requested: {
      modelProvider: 'openai',
      model: 'gpt-5.5',
      harnessFamily: 'codex',
      preferredHarnessRuntime: 'codex-cli',
      interactionMode: 'headless',
    },
    materialization: { ...materialization },
    hrcPolicy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
    },
    correlation: {
      requestId: 'request_T01610',
      hostSessionId: 'hostSession_T01610',
      generation: 1,
      scopeRef: 'agent:cody:project:agent-spaces:task:T-01610',
      laneRef: 'repair',
    },
  }
}

function brokerProfile(response: RuntimeCompileResponse): BrokerExecutionProfile {
  expect(response.ok).toBe(true)
  if (!response.ok) {
    throw new Error('compileRuntimePlan returned diagnostics instead of a plan')
  }
  const profiles = response.plan.executionProfiles.filter(
    (profile): profile is BrokerExecutionProfile => profile.kind === 'harness-broker'
  )
  expect(profiles).toHaveLength(1)
  return profiles[0]
}

async function compile(
  fixture: Fixture,
  materialization: Partial<RuntimeCompileRequest['materialization']> = {},
  identityOverrides: Partial<RuntimeCompileRequest['identity']> = {}
): Promise<BrokerExecutionProfile> {
  process.env['ASP_CODEX_PATH'] = join(fixture.aspHome, 'codex')
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
  const client = createAgentSpacesClient({ aspHome: fixture.aspHome }) as CompileClient
  return brokerProfile(
    await client.compileRuntimePlan(compileRequest(fixture, materialization, identityOverrides))
  )
}

function initialInput(profile: BrokerExecutionProfile) {
  return profile.harnessInvocation.startRequest.initialInput
}

function textContent(profile: BrokerExecutionProfile): string | undefined {
  const item = initialInput(profile)?.content.find((content) => content.type === 'text')
  return item?.type === 'text' ? item.text : undefined
}

describe('compiled broker initial input composition', () => {
  const originalCodexPath = process.env['ASP_CODEX_PATH']
  const originalSkipCommon = process.env['ASP_CODEX_SKIP_COMMON_PATHS']

  afterEach(() => {
    if (originalCodexPath === undefined) {
      process.env['ASP_CODEX_PATH'] = undefined
    } else {
      process.env['ASP_CODEX_PATH'] = originalCodexPath
    }
    if (originalSkipCommon === undefined) {
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = undefined
    } else {
      process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalSkipCommon
    }
  })

  test('expands the priming prompt when no caller prompt is supplied', async () => {
    const fixture = createFixture({
      primingPrompt: 'Agent {{agentId}} handles {{projectId}} task {{taskId}} on {{lane}}.',
    })
    try {
      const profile = await compile(fixture, {})
      expect(textContent(profile)).toBe('Agent cody handles agent-spaces task T-01610 on repair.')
    } finally {
      fixture.cleanup()
    }
  })

  test('combines the expanded priming prompt and the expanded caller prompt', async () => {
    const fixture = createFixture({
      primingPrompt: 'Agent {{agentId}} handles {{projectId}} task {{taskId}} on {{lane}}.',
    })
    try {
      const profile = await compile(fixture, {
        initialPrompt: 'Inspect {{projectId}} as {{agentId}} for {{taskId}} on {{lane}}.',
      })
      expect(textContent(profile)).toBe(
        [
          'Agent cody handles agent-spaces task T-01610 on repair.',
          'Inspect agent-spaces as cody for T-01610 on repair.',
        ].join('\n\n')
      )
    } finally {
      fixture.cleanup()
    }
  })

  test('expands the caller prompt with no leading gap when priming is absent', async () => {
    const fixture = createFixture()
    try {
      const profile = await compile(fixture, {
        initialPrompt: 'Inspect {{projectId}} as {{agentId}} for {{taskId}} on {{lane}}.',
      })
      expect(textContent(profile)).toBe('Inspect agent-spaces as cody for T-01610 on repair.')
    } finally {
      fixture.cleanup()
    }
  })

  test('suppresses text input when the caller prompt is an empty string', async () => {
    const fixture = createFixture({
      primingPrompt: 'Agent {{agentId}} handles {{projectId}} task {{taskId}} on {{lane}}.',
    })
    try {
      const profile = await compile(fixture, { initialPrompt: '' })
      expect(initialInput(profile)).toBeUndefined()
    } finally {
      fixture.cleanup()
    }
  })

  test('keeps image-only input image-only and suppresses priming text on empty prompt', async () => {
    const fixture = createFixture({
      primingPrompt: 'Agent {{agentId}} handles {{projectId}} task {{taskId}} on {{lane}}.',
    })
    try {
      const profile = await compile(fixture, {
        initialPrompt: '',
        attachments: [{ kind: 'image', path: fixture.imagePath, mimeType: 'image/png' }],
      })
      expect(initialInput(profile)?.content).toEqual([
        { type: 'local_image', path: fixture.imagePath },
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test('keeps image-only input when there is no prompt and no priming', async () => {
    const fixture = createFixture()
    try {
      const profile = await compile(fixture, {
        attachments: [{ kind: 'image', path: fixture.imagePath, mimeType: 'image/png' }],
      })
      expect(initialInput(profile)?.content).toEqual([
        { type: 'local_image', path: fixture.imagePath },
      ])
    } finally {
      fixture.cleanup()
    }
  })

  test('stamps the compiled initial input with the supplied identity.initialInputId', async () => {
    const fixture = createFixture()
    try {
      const profile = await compile(
        fixture,
        { initialPrompt: 'first turn text' },
        { initialInputId: 'input_supplied_T01610' as InputId }
      )
      expect(initialInput(profile)?.inputId).toBe('input_supplied_T01610')
    } finally {
      fixture.cleanup()
    }
  })

  test('changes initialInputHash when the prompt text changes', async () => {
    const fixture = createFixture()
    try {
      const first = await compile(fixture, { initialPrompt: 'first turn text' })
      const second = await compile(fixture, { initialPrompt: 'different first turn text' })
      expect(first.harnessInvocation.initialInputHash).toEqual(expect.any(String))
      expect(second.harnessInvocation.initialInputHash).not.toBe(
        first.harnessInvocation.initialInputHash
      )
    } finally {
      fixture.cleanup()
    }
  })

  test('changes initialInputHash when the attachment content changes', async () => {
    const fixture = createFixture()
    try {
      const first = await compile(fixture, {
        initialPrompt: 'same text',
        attachments: [{ kind: 'image', path: fixture.imagePath, mimeType: 'image/png' }],
      })
      const second = await compile(fixture, {
        initialPrompt: 'same text',
        attachments: [{ kind: 'image', path: fixture.imagePath2, mimeType: 'image/png' }],
      })
      expect(second.harnessInvocation.initialInputHash).not.toBe(
        first.harnessInvocation.initialInputHash
      )
    } finally {
      fixture.cleanup()
    }
  })
})
