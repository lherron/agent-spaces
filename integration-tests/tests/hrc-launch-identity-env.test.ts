/**
 * T-09271 (prerequisite for HRC T-08207): compile→spawn-env readback for the
 * launch identity keys. A format-1 request (runId present) keeps HRC_RUN_ID /
 * AGENT_RUN_ID; a format-2 request (runId absent) exports neither, and nothing
 * synthesizes one. Both formats export HRC_RUNTIME_ID / HRC_INVOCATION_ID /
 * HRC_INITIAL_INPUT_ID from the request's own values, and a caller dispatchEnv
 * can never spoof them.
 *
 * The readback runs the real broker session factory over the compiled spec, so
 * the env asserted here is the one the agent-harness worker hands its tools.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { HarnessInvocationSpec } from 'spaces-harness-broker-protocol'
import type { RuntimeCompileRequest } from 'spaces-runtime-contracts'

import { createResolvedAgentSession } from '../../harness/agent-harness/src/broker/invocation-session-factory.js'
import {
  type V2CompileFixture,
  buildV2CompileRequest,
  compileV2Request,
  createV2CompileFixture,
} from './v2-compile-fixture.js'

const LAUNCH_KEYS = [
  'HRC_RUN_ID',
  'AGENT_RUN_ID',
  'HRC_RUNTIME_ID',
  'HRC_INVOCATION_ID',
  'HRC_INITIAL_INPUT_ID',
] as const

const fixtures: V2CompileFixture[] = []
// This suite may itself run inside an HRC seat, whose own launch keys would
// otherwise reach the readback through the ambient base environment.
const ambient: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const key of LAUNCH_KEYS) {
    ambient[key] = process.env[key]
    delete process.env[key]
  }
})
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
  for (const key of LAUNCH_KEYS) {
    if (ambient[key] === undefined) delete process.env[key]
    else process.env[key] = ambient[key]
  }
})

type Format = 'format-1' | 'format-2'

function request(
  fixture: V2CompileFixture,
  format: Format,
  dispatchEnv?: Record<string, string>
): RuntimeCompileRequest {
  const req = buildV2CompileRequest(fixture, {
    namespace: `launch-env-${format}`,
    harness: 'agent-harness',
    modelProvider: 'openai-codex',
    model: 'gpt-5.5',
    presentation: false,
    ...(dispatchEnv !== undefined ? { dispatchEnv } : {}),
  })
  req.correlation.inputId = req.identity.initialInputId
  if (format === 'format-2') {
    req.identity.runId = undefined
    req.correlation.runId = undefined
  }
  return req
}

async function compileAndReadEnv(
  req: RuntimeCompileRequest,
  fixture: V2CompileFixture
): Promise<{ spec: HarnessInvocationSpec; env: Record<string, string | undefined> }> {
  const response = await compileV2Request(fixture, req)
  if (!response.ok) throw new Error(JSON.stringify(response.diagnostics))
  const dispatch = response.plan.execution.dispatchRequest
  const spec = dispatch.startRequest.spec
  let env: Record<string, string | undefined> | undefined
  await createResolvedAgentSession(
    {
      spec,
      environment: { ...(dispatch.dispatchEnv ?? {}) },
      auth: {} as never,
      permissionExtension: (() => undefined) as never,
      structuredTool: { name: 'structured_output' } as never,
    },
    {
      loadAgent: async (options) => {
        const { loadAgent } = await import('agent-harness-runtime')
        const agent = await loadAgent(options)
        env = agent.environment
        return agent
      },
      createRuntime: async () => ({ session: {}, dispose: async () => {} }) as never,
    }
  )
  if (env === undefined) throw new Error('broker session factory never loaded the agent')
  return { spec, env }
}

function launchEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(LAUNCH_KEYS.map((key) => [key, env[key]]))
}

describe('HRC launch identity env (T-09271)', () => {
  test('format 1: runId present exports run keys and the three launch keys', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const req = request(fixture, 'format-1')

    const { spec, env } = await compileAndReadEnv(req, fixture)

    expect(spec.agent?.runId).toBe(req.identity.runId)
    expect(spec.correlation?.['runId']).toBe(req.correlation.runId)
    expect(launchEnv(env)).toEqual({
      HRC_RUN_ID: req.identity.runId,
      AGENT_RUN_ID: req.identity.runId,
      HRC_RUNTIME_ID: req.correlation.runtimeId,
      HRC_INVOCATION_ID: req.identity.invocationId,
      HRC_INITIAL_INPUT_ID: req.identity.initialInputId,
    })
  })

  test('format 2: runId absent exports no run keys and never synthesizes one', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const req = request(fixture, 'format-2')

    const { spec, env } = await compileAndReadEnv(req, fixture)

    expect(spec.agent).not.toHaveProperty('runId')
    expect(spec.correlation).not.toHaveProperty('runId')
    expect(env).not.toHaveProperty('HRC_RUN_ID')
    expect(env).not.toHaveProperty('AGENT_RUN_ID')
    expect(launchEnv(env)).toEqual({
      HRC_RUN_ID: undefined,
      AGENT_RUN_ID: undefined,
      HRC_RUNTIME_ID: req.correlation.runtimeId,
      HRC_INVOCATION_ID: req.identity.invocationId,
      HRC_INITIAL_INPUT_ID: req.identity.initialInputId,
    })
  })

  test('format 2: an absent launch source leaves its key absent, even under a spoof', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const spoof = Object.fromEntries(LAUNCH_KEYS.map((key) => [key, `spoofed-${key}`]))
    const req = request(fixture, 'format-2', spoof)
    req.identity.invocationId = undefined
    req.correlation.invocationId = undefined
    req.correlation.inputId = undefined
    req.correlation.runtimeId = undefined

    const { env } = await compileAndReadEnv(req, fixture)

    for (const key of LAUNCH_KEYS) expect(env).not.toHaveProperty(key)
  })

  test.each<Format>(['format-1', 'format-2'])(
    '%s: caller dispatchEnv cannot spoof the launch keys',
    async (format) => {
      const fixture = createV2CompileFixture()
      fixtures.push(fixture)
      const spoof = Object.fromEntries(LAUNCH_KEYS.map((key) => [key, `spoofed-${key}`]))
      const req = request(fixture, format, { ...spoof, KEEP_ME: 'yes' })

      const { env } = await compileAndReadEnv(req, fixture)

      expect(env['KEEP_ME']).toBe('yes')
      expect(launchEnv(env)).toEqual({
        HRC_RUN_ID: format === 'format-1' ? req.identity.runId : undefined,
        AGENT_RUN_ID: format === 'format-1' ? req.identity.runId : undefined,
        HRC_RUNTIME_ID: req.correlation.runtimeId,
        HRC_INVOCATION_ID: req.identity.invocationId,
        HRC_INITIAL_INPUT_ID: req.identity.initialInputId,
      })
    }
  )
})
