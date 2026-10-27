/**
 * Tests for PI_EVENT_MAP canonical event-name coverage.
 *
 * WHY (T-04645): The lowercased compensation entries (sessionstart/pretooluse/
 * posttooluse) defended against an upstream producer bug where
 * readHooksWithPrecedence lowercased Claude event names. That producer is now
 * fixed (T-04983: claudeEventToCanonical inserts an underscore at each
 * lower→upper boundary then lowercases), so multi-word Claude events arrive
 * underscored and are covered by the abstract entries. `Stop` is single-word
 * with no case boundary, so it normalizes to plain `stop` and STILL needs its
 * own map entry. These tests pin that the canonical names emitted by the
 * producer continue to register the correct Pi events after deleting the three
 * dead lowercased entries.
 */

import { describe, expect, test } from 'bun:test'

import { generateHookBridgeCode } from './hook-bridge.js'

function piEventFor(event: string): string | undefined {
  const code = generateHookBridgeCode([{ event, script: 'h.sh' }], ['space-a'])
  // generateHookBridgeCode emits `pi.on('<piEvent>', async ...)` per hook.
  const match = code.match(/pi\.on\('([^']+)', async/)
  return match?.[1]
}

describe('PI_EVENT_MAP canonical event-name coverage (T-04645)', () => {
  // Names exactly as the fixed producer (claudeEventToCanonical) emits them
  // for Claude native hooks.json, plus abstract hooks.toml names.
  const cases: Array<[string, string]> = [
    ['session_start', 'session_start'], // SessionStart -> session_start
    ['pre_tool_use', 'tool_call'], // PreToolUse -> pre_tool_use
    ['post_tool_use', 'tool_result'], // PostToolUse -> post_tool_use
    ['stop', 'session_shutdown'], // Stop -> stop (single word, kept entry)
    ['session_end', 'session_shutdown'], // abstract hooks.toml name
    ['Stop', 'session_shutdown'], // PascalCase Stop (simple-array hooks.json)
    ['SessionStart', 'session_start'],
    // The dead lowercased compensation entries are gone: an unmapped name now
    // falls back to registering under its raw event string.
    ['pretooluse', 'pretooluse'],
    ['posttooluse', 'posttooluse'],
    ['sessionstart', 'sessionstart'],
  ]

  for (const [event, expected] of cases) {
    test(`hook event '${event}' registers Pi event '${expected}' in the generated bridge`, () => {
      expect(piEventFor(event)).toBe(expected)
    })
  }
})
