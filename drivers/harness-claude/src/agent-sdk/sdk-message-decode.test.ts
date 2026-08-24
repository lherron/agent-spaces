import { describe, expect, it } from 'bun:test'
import { isSynthesizableUserToolResult } from './sdk-message-decode.js'

describe('isSynthesizableUserToolResult', () => {
  const eligible = (): Record<string, unknown> => ({
    parent_tool_use_id: 'tool-123',
    tool_use_result: { content: [] },
  })

  it('returns true for a parent-task user message carrying a tool_use_result', () => {
    expect(isSynthesizableUserToolResult(eligible(), 'user', false)).toBe(true)
  })

  it('returns false when the message type is not user', () => {
    expect(isSynthesizableUserToolResult(eligible(), 'assistant', false)).toBe(false)
  })

  it('returns false when a tool_result block was already seen', () => {
    expect(isSynthesizableUserToolResult(eligible(), 'user', true)).toBe(false)
  })

  it('returns false when parent_tool_use_id is missing/non-string', () => {
    const msg: Record<string, unknown> = { tool_use_result: { content: [] } }
    expect(isSynthesizableUserToolResult(msg, 'user', false)).toBe(false)
  })

  it('returns false when tool_use_result is undefined', () => {
    const msg: Record<string, unknown> = { parent_tool_use_id: 'tool-123' }
    expect(isSynthesizableUserToolResult(msg, 'user', false)).toBe(false)
  })
})
