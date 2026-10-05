import { describe, expect, test } from 'bun:test'

import { combinePrompts, resolveRunEnvFlags } from './util.js'

describe('combinePrompts', () => {
  test('merges priming prompt and user prompt', () => {
    expect(combinePrompts('priming', 'user')).toBe('priming\n\nuser')
    expect(combinePrompts('priming', undefined)).toBe('priming')
    expect(combinePrompts(undefined, 'user')).toBe('user')
    expect(combinePrompts(undefined, undefined)).toBeUndefined()
  })
})

describe('resolveRunEnvFlags', () => {
  test('only exposes the debug gate', () => {
    expect(resolveRunEnvFlags({})).toEqual({ debugRun: false })
    expect(resolveRunEnvFlags({ ASP_RUN_VIA_COMPILER: '1' })).toEqual({ debugRun: false })
    expect(resolveRunEnvFlags({ ASP_DEBUG_RUN: 'true' })).toEqual({ debugRun: true })
  })
})
