/**
 * P2 enables this suite by changing describe.skip to describe after
 * buildHarnessBrokerInvocation is implemented.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  HarnessInvocationSpec,
  InvocationInput,
  InvocationStartRequest,
} from 'spaces-harness-broker-protocol'
import { validateCommand, validateInvocationSpec } from 'spaces-harness-broker-protocol'

import { createAgentSpacesClient } from '../index.js'
import type { AgentSpacesClient, BuildProcessInvocationSpecRequest } from '../types.js'

type BuildHarnessBrokerInvocationRequest = Omit<
  BuildProcessInvocationSpecRequest,
  'hostSessionId' | 'cpSessionId' | 'spec' | 'ioMode' | 'cwd' | 'artifactDir'
> & {
  invocationId?: string | undefined
  labels?: Record<string, string> | undefined
  correlation?: Record<string, string> | undefined
  permissionPolicy?: { mode: 'deny' | 'allow' | 'ask-client' } | undefined
  limits?: HarnessInvocationSpec['process']['limits'] | undefined
  resumeFallback?: 'start-fresh' | 'fail' | undefined
}

type BuildHarnessBrokerInvocationResponse = {
  startRequest: InvocationStartRequest
  spec: HarnessInvocationSpec
  initialInput?: InvocationInput | undefined
  resolvedBundle?: unknown
  warnings?: string[] | undefined
}

type BrokerClient = AgentSpacesClient & {
  buildHarnessBrokerInvocation(
    req: BuildHarnessBrokerInvocationRequest
  ): Promise<BuildHarnessBrokerInvocationResponse>
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

function createFixture(): {
  agentRoot: string
  projectRoot: string
  aspHome: string
  imagePath: string
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'asp-broker-invocation-'))
  const agentRoot = join(base, 'agents', 'cody')
  const projectRoot = join(base, 'agent-spaces')
  const aspHome = join(base, 'asp-home')
  const imagePath = join(base, 'diagram.png')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  writeFileSync(imagePath, 'not-really-a-png', 'utf8')
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    `schemaVersion = 2

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
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

let fixture: ReturnType<typeof createFixture>
const originalCodexPath = process.env['ASP_CODEX_PATH']
const originalSkipCommon = process.env['ASP_CODEX_SKIP_COMMON_PATHS']

function placement(): BuildHarnessBrokerInvocationRequest['placement'] {
  return {
    agentRoot: fixture.agentRoot,
    projectRoot: fixture.projectRoot,
    cwd: fixture.projectRoot,
    runMode: 'task',
    bundle: { kind: 'agent-project', agentName: 'cody', projectRoot: fixture.projectRoot },
    correlation: {
      sessionRef: {
        scopeRef: 'agent:cody:project:agent-spaces:task:T-01558',
        laneRef: 'main',
      },
      hostSessionId: 'host-01558',
    },
  }
}

function createClient(): BrokerClient {
  return createAgentSpacesClient({ aspHome: fixture.aspHome }) as BrokerClient
}

function baseRequest(): BuildHarnessBrokerInvocationRequest {
  return {
    placement: placement(),
    provider: 'openai',
    frontend: 'codex-cli',
    interactionMode: 'headless',
    continuation: { provider: 'openai', key: 'thread_01558' },
    prompt: 'hello broker',
    attachments: [{ kind: 'file', path: fixture.imagePath, contentType: 'image/png' }],
    env: { EXTRA_FLAG: '1' },
    invocationId: 'inv_01558',
    labels: { task: 'T-01558' },
    permissionPolicy: { mode: 'deny' },
    limits: { startupTimeoutMs: 10_000, turnTimeoutMs: 20_000 },
    resumeFallback: 'fail',
  }
}

describe('buildHarnessBrokerInvocation broker contract', () => {
  beforeAll(() => {
    fixture = createFixture()
    process.env['ASP_CODEX_PATH'] = join(fixture.aspHome, 'codex')
    process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
  })

  afterAll(() => {
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
    fixture.cleanup()
  })

  test('happy path returns a validating InvocationStartRequest', async () => {
    const response = await createClient().buildHarnessBrokerInvocation(baseRequest())

    expect(response.startRequest.spec).toBe(response.spec)
    expect(response.startRequest.initialInput).toBe(response.initialInput)
    expect(validateInvocationSpec(response.startRequest.spec)).toEqual(response.startRequest.spec)
    expect(() =>
      validateCommand({
        jsonrpc: '2.0',
        id: 'cmd_1',
        method: 'invocation.start',
        params: response.startRequest,
      })
    ).not.toThrow()
  })

  test('omits HRC and ACP launch metadata from the broker invocation spec', async () => {
    const { spec } = await createClient().buildHarnessBrokerInvocation(baseRequest())
    const serialized = JSON.stringify(spec)

    for (const forbidden of [
      'runtimeId',
      'runId',
      'launchId',
      'tmuxId',
      'callbackSocket',
      'spoolPath',
      'persistence',
      'hrc',
      'acp',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  test('maps prepared Codex process fields with jsonrpc stdio transport', async () => {
    const { spec } = await createClient().buildHarnessBrokerInvocation(baseRequest())

    expect(spec.process.command).toBeTruthy()
    expect(spec.process.args).toContain('app-server')
    expect(spec.process.cwd).toBe(fixture.projectRoot)
    expect(spec.process.env).toEqual(expect.objectContaining({ EXTRA_FLAG: '1' }))
    expect(spec.process.harnessTransport).toEqual({ kind: 'jsonrpc-stdio' })
    expect(spec.process.limits).toEqual({ startupTimeoutMs: 10_000, turnTimeoutMs: 20_000 })
  })

  test('maps Codex app-server driver fields from the prepared launch descriptor', async () => {
    const { spec } = await createClient().buildHarnessBrokerInvocation(baseRequest())

    expect(spec.harness).toEqual({
      frontend: 'codex',
      provider: 'openai',
      driver: 'codex-app-server',
    })
    expect(spec.driver).toEqual(
      expect.objectContaining({
        kind: 'codex-app-server',
        resumeThreadId: 'thread_01558',
        approvalPolicy: 'never',
        permissionPolicy: { mode: 'deny' },
        resumeFallback: 'fail',
      })
    )
  })

  test('translates openai continuation to a broker Codex thread continuation', async () => {
    const { spec } = await createClient().buildHarnessBrokerInvocation(baseRequest())

    expect(spec.continuation).toEqual({
      provider: 'codex',
      kind: 'thread',
      key: 'thread_01558',
    })
  })

  test('correlation is a flat string map with no nested sessionRef', async () => {
    const { spec } = await createClient().buildHarnessBrokerInvocation(baseRequest())

    expect(spec.correlation).toBeDefined()
    expect(spec.correlation?.['sessionRef']).toBeUndefined()
    for (const value of Object.values(spec.correlation ?? {})) {
      expect(typeof value).toBe('string')
    }
  })

  test('caller correlation override is preserved as flat strings', async () => {
    const { spec } = await createClient().buildHarnessBrokerInvocation({
      ...baseRequest(),
      correlation: { task: 'T-01558', lane: 'main' },
    })

    expect(spec.correlation).toEqual({ task: 'T-01558', lane: 'main' })
  })

  test.each([
    ['prompt-only', { prompt: 'text', attachments: undefined }, [{ type: 'text', text: 'text' }]],
    [
      'image-only',
      { prompt: undefined, attachments: [{ kind: 'file', path: '/tmp/one.png' }] },
      [{ type: 'local_image', path: '/tmp/one.png' }],
    ],
    [
      'both',
      { prompt: 'text', attachments: [{ kind: 'file', path: '/tmp/one.png' }] },
      [
        { type: 'text', text: 'text' },
        { type: 'local_image', path: '/tmp/one.png' },
      ],
    ],
    ['neither', { prompt: undefined, attachments: undefined }, undefined],
  ])('composes initialInput for %s', async (_name, input, expectedContent) => {
    const response = await createClient().buildHarnessBrokerInvocation({
      ...baseRequest(),
      prompt: input.prompt,
      attachments: input.attachments,
    })

    if (expectedContent === undefined) {
      expect(response.initialInput).toBeUndefined()
      expect(response.startRequest.initialInput).toBeUndefined()
    } else {
      expect(response.initialInput).toEqual(
        expect.objectContaining({ kind: 'user', content: expectedContent })
      )
      expect(response.initialInput?.inputId).toMatch(/^input_/)
    }
  })

  test('does not duplicate one-turn prompt or images into driver defaults', async () => {
    const { spec } = await createClient().buildHarnessBrokerInvocation(baseRequest())

    expect(spec.driver).toEqual(
      expect.not.objectContaining({
        prompt: expect.any(String),
        defaultImageAttachments: expect.any(Array),
      })
    )
  })

  test.each([
    ['provider', { provider: 'anthropic' }],
    ['frontend', { frontend: 'claude-code' }],
    ['sdk frontend', { frontend: 'agent-sdk' }],
    ['interactive mode', { interactionMode: 'interactive' }],
    ['non-headless mode', { interactionMode: 'nonInteractive' }],
  ])('rejects unsupported %s before materialization', async (_name, override) => {
    await expect(
      createClient().buildHarnessBrokerInvocation({
        ...baseRequest(),
        placement: { ...placement(), agentRoot: '/path/that/must/not/be/materialized' },
        ...override,
      } as BuildHarnessBrokerInvocationRequest)
    ).rejects.toThrow(/unsupported|provider|frontend|headless/i)
  })
})
