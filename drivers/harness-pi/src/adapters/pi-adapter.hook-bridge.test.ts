import { describe, expect, test } from 'bun:test'
import { type HookDefinition, generateHookBridgeCode } from './pi-adapter.js'

describe('Hook bridge generation', () => {
  describe('generateHookBridgeCode', () => {
    test('generates valid JavaScript code', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'pre_tool_use',
          script: '/path/to/validate.sh',
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1'])

      expect(code).toContain('module.exports = function')
      expect(code).toContain('pi.on(')
    })

    test('translates pre_tool_use to tool_call', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'pre_tool_use',
          script: '/path/to/script.sh',
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1'])

      expect(code).toContain("'tool_call'")
    })

    test('translates post_tool_use to tool_result', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'post_tool_use',
          script: '/path/to/script.sh',
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1'])

      expect(code).toContain("'tool_result'")
    })

    test('includes ASP environment variables', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'pre_tool_use',
          script: '/path/to/script.sh',
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1', 'space2'])

      expect(code).toContain('ASP_TOOL_NAME')
      expect(code).toContain('ASP_TOOL_ARGS')
      expect(code).toContain('ASP_TOOL_RESULT')
      expect(code).toContain('ASP_HARNESS')
      expect(code).toContain('ASP_SPACES')
    })

    test('includes space IDs in ASP_SPACES', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'pre_tool_use',
          script: '/path/to/script.sh',
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1', 'space2'])

      expect(code).toContain('space1,space2')
    })

    test('filters hooks by harness', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'pre_tool_use',
          script: '/path/to/pi-hook.sh',
          harness: 'pi',
        },
        {
          event: 'pre_tool_use',
          script: '/path/to/claude-hook.sh',
          harness: 'claude',
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1'])

      // Pi hook should be included
      expect(code).toContain('pi-hook.sh')
      // Claude hook should NOT be included
      expect(code).not.toContain('claude-hook.sh')
    })

    test('includes hooks without harness filter', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'pre_tool_use',
          script: '/path/to/universal-hook.sh',
          // No harness specified - should be included for all
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1'])

      expect(code).toContain('universal-hook.sh')
    })

    test('generates tool filter when tools specified', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'pre_tool_use',
          script: '/path/to/script.sh',
          tools: ['Read', 'Write'],
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1'])

      expect(code).toContain('toolsFilter')
      expect(code).toContain('"Read"')
      expect(code).toContain('"Write"')
    })

    test('generates comment for empty hooks', () => {
      const hooks: HookDefinition[] = []

      const code = generateHookBridgeCode(hooks, ['space1'])

      expect(code).toContain('No hooks configured')
    })

    test('includes blocking warning in generated code', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'pre_tool_use',
          script: '/path/to/script.sh',
          blocking: true,
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1'])

      // Blocking hooks still generate code, logging handles exit codes
      expect(code).toContain('/path/to/script.sh')
      expect(code).toContain('log(')
    })

    test('handles multiple hooks', () => {
      const hooks: HookDefinition[] = [
        {
          event: 'pre_tool_use',
          script: '/path/to/pre.sh',
        },
        {
          event: 'post_tool_use',
          script: '/path/to/post.sh',
        },
        {
          event: 'session_start',
          script: '/path/to/start.sh',
        },
      ]

      const code = generateHookBridgeCode(hooks, ['space1'])

      expect(code).toContain('pre.sh')
      expect(code).toContain('post.sh')
      expect(code).toContain('start.sh')
      // Count pi.on() calls
      const hookCount = (code.match(/pi\.on\(/g) || []).length
      expect(hookCount).toBe(3)
    })
  })
})

describe('Hook bridge generation — codegen injection hazard', () => {
  test('escapes hook.script and hook.event quotes/newlines so generated code stays valid', () => {
    const script = "/path/to/it's a script\n.sh; rm -rf /"
    const event = "pre_tool_use');\nthrow new Error('injected event"
    const code = generateHookBridgeCode(
      [
        {
          event,
          script,
        },
      ],
      ['space1']
    )

    // T-04644: generated bridge source is the executable artifact. Adversarial
    // hook values must be serialized as data, never spliced raw into JS code.
    expect(() => new Function('require', 'module', 'exports', code)).not.toThrow()
    expect(code).not.toContain(`pi.on('${event}'`)
    expect(code).not.toContain(`spawn('${script}'`)
    expect(code).not.toContain(`event: '${event}'`)
    expect(code).not.toContain(`script: '${script}'`)
  })
})
