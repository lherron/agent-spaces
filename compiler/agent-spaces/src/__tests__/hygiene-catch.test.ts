/**
 * `hygieneBlockResponse` — the conversion `compileRuntimePlan` runs in its catch —
 * turns a `MaterializationHygieneError` into an `ok: false` response carrying
 * `materialization_hygiene_error` diagnostics, at/below the compiler boundary, so
 * the aspc facade never degrades it to `compiler_exception` (T-05574 Cond 1). The
 * routing that throws the error into the catch is exercised e2e (installed smoke).
 */

import { describe, expect, test } from 'bun:test'
import { MaterializationHygieneError } from 'spaces-config'

import { hygieneBlockResponse } from '../compile-runtime-plan.js'

describe('hygieneBlockResponse', () => {
  test('converts a MaterializationHygieneError to ok:false hygiene diagnostics', () => {
    const err = new MaterializationHygieneError('probe@b1b2b3b', '/tmp/staging/probe', [
      {
        spaceKey: 'probe@b1b2b3b',
        pluginPath: '/tmp/staging/probe',
        code: 'W421',
        severity: 'error',
        path: 'skills/probe-skill/SKILL.md',
        message: 'broken pointer to ./does-not-exist.md',
      },
    ])

    const response = hygieneBlockResponse(err)
    expect(response).toBeDefined()
    if (!response || response.ok) throw new Error('expected ok:false response')
    const codes = response.diagnostics.map((d) => d.code)
    expect(codes).toEqual(['materialization_hygiene_error'])
    expect(codes).not.toContain('compiler_exception')
    expect(response.diagnostics.every((d) => d.level === 'error')).toBe(true)
    expect(response.diagnostics[0]?.plane).toBe('asp-compiler')
    expect(response.diagnostics[0]?.details).toMatchObject({
      code: 'W421',
      severity: 'error',
      spaceKey: 'probe@b1b2b3b',
      pluginPath: '/tmp/staging/probe',
      path: 'skills/probe-skill/SKILL.md',
    })
  })

  test('deterministic diagnostic order — sorted by code then path', () => {
    const err = new MaterializationHygieneError('s@c', '/p', [
      { spaceKey: 's@c', pluginPath: '/p', code: 'W430', severity: 'error', message: 'b' },
      {
        spaceKey: 's@c',
        pluginPath: '/p',
        code: 'W421',
        severity: 'error',
        path: 'skills/z/SKILL.md',
        message: 'a2',
      },
      {
        spaceKey: 's@c',
        pluginPath: '/p',
        code: 'W421',
        severity: 'error',
        path: 'skills/a/SKILL.md',
        message: 'a1',
      },
    ])
    const response = hygieneBlockResponse(err)
    if (!response || response.ok) throw new Error('expected ok:false response')
    expect(response.diagnostics.map((d) => (d.details as { path?: string }).path)).toEqual([
      'skills/a/SKILL.md',
      'skills/z/SKILL.md',
      undefined,
    ])
  })

  test('returns undefined for a non-hygiene error (propagates unchanged)', () => {
    expect(hygieneBlockResponse(new Error('boom'))).toBeUndefined()
    expect(hygieneBlockResponse('not even an error')).toBeUndefined()
  })
})
