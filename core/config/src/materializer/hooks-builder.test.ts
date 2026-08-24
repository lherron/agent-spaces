/**
 * Tests for hooks-builder module.
 *
 * WHY: Hook validation ensures scripts work correctly at runtime.
 * These tests verify path checking logic.
 */

import { describe, expect, it } from 'bun:test'
import { type HooksConfig, checkHookPaths } from './hooks-builder.js'

describe('checkHookPaths', () => {
  it('should return no warnings for simple paths', () => {
    const config: HooksConfig = {
      hooks: [
        { event: 'test', script: 'hook.sh' },
        { event: 'test2', script: 'subfolder/hook.py' },
      ],
    }
    const warnings = checkHookPaths(config)
    expect(warnings.length).toBe(0)
  })

  it('should warn about relative parent paths', () => {
    const config: HooksConfig = {
      hooks: [{ event: 'test', script: '../outside/hook.sh' }],
    }
    const warnings = checkHookPaths(config)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('..')
  })

  it('should return empty for empty hooks', () => {
    const config: HooksConfig = {
      hooks: [],
    }
    const warnings = checkHookPaths(config)
    expect(warnings.length).toBe(0)
  })
})
