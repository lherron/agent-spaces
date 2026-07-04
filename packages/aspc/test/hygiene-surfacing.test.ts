/**
 * ASPC surfacing of the compose-time hygiene cache-admission block (T-05574,
 * Cond 1). The real `compileRuntimePlan` converts a `MaterializationHygieneError`
 * to an `ok: false` response carrying `materialization_hygiene_error`
 * `CompileDiagnostic[]` BEFORE it reaches the aspc facade — so the facade's generic
 * `compiler_exception` catch never sees it. These tests inject a compiler that
 * returns that converted response and assert all three aspc entry points surface
 * the typed diagnostics unchanged (not degraded to `compiler_exception`).
 */

import { describe, expect, test } from 'bun:test'
import type { AspcCompileHarnessInvocationRequest } from 'spaces-aspc-protocol'
import type { Broker } from 'spaces-harness-broker'
import type { CompileDiagnostic, RuntimeCompileRequest } from 'spaces-runtime-contracts'
import type { AspcCompiler } from '../src/service.js'
import { createAspcService } from '../src/service.js'

const COMPILE_REQUEST = {
  schemaVersion: 'agent-runtime-compile-request/v1',
  placement: {},
} as unknown as RuntimeCompileRequest

function buildRequest(): AspcCompileHarnessInvocationRequest {
  return { compileRequest: COMPILE_REQUEST }
}

const HYGIENE_DIAGNOSTIC: CompileDiagnostic = {
  level: 'error',
  code: 'materialization_hygiene_error',
  message: 'broken pointer to ./does-not-exist.md',
  plane: 'asp-compiler',
  details: {
    spaceKey: 'probe@b1b2b3b',
    pluginPath: '/tmp/staging/probe',
    code: 'W421',
    severity: 'error',
    path: 'skills/probe-skill/SKILL.md',
  },
}

/** A compiler that returns the CONVERTED hygiene-block response (ok:false). */
const hygieneBlockingCompiler: AspcCompiler = async () => ({
  schemaVersion: 'agent-runtime-compile-response/v1',
  ok: false,
  diagnostics: [HYGIENE_DIAGNOSTIC],
})

describe('ASPC surfaces materialization_hygiene_error (not compiler_exception)', () => {
  test('compileRuntimePlan surfaces the typed hygiene diagnostics', async () => {
    const service = createAspcService({ compiler: hygieneBlockingCompiler })
    const response = await service.compileRuntimePlan({ compileRequest: COMPILE_REQUEST })
    expect(response.ok).toBe(false)
    if (response.ok) return
    const codes = response.diagnostics.map((d) => d.code)
    expect(codes).toContain('materialization_hygiene_error')
    expect(codes).not.toContain('compiler_exception')
    expect(response.diagnostics[0]?.details).toMatchObject({ code: 'W421', severity: 'error' })
  })

  test('compileHarnessInvocation surfaces the typed hygiene diagnostics', async () => {
    const service = createAspcService({ compiler: hygieneBlockingCompiler })
    const response = await service.compileHarnessInvocation(buildRequest())
    expect(response.ok).toBe(false)
    if (response.ok) return
    const codes = response.diagnostics.map((d) => d.code)
    expect(codes).toContain('materialization_hygiene_error')
    expect(codes).not.toContain('compiler_exception')
    expect(response.compileResponse.ok).toBe(false)
  })

  test('compileAndStart short-circuits with the typed hygiene diagnostics; broker.start not called', async () => {
    let startCalled = false
    const broker = {
      start: async () => {
        startCalled = true
        return {} as never
      },
    } as unknown as Broker

    const service = createAspcService({ broker, compiler: hygieneBlockingCompiler })
    const response = await service.compileAndStart(buildRequest())
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.compile.ok).toBe(false)
    const codes = response.diagnostics.map((d) => d.code)
    expect(codes).toContain('materialization_hygiene_error')
    expect(codes).not.toContain('compiler_exception')
    expect(startCalled).toBe(false)
  })
})
