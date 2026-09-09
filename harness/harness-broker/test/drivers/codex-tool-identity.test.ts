import { describe, expect, test } from 'bun:test'
import { mapCodexNotification } from '../../src/drivers/codex-app-server/event-map'
import { codexNativeToolIdentity } from '../../src/drivers/codex-tool-identity'

describe('Codex cross-adapter tool identity conformance', () => {
  test('equivalent command item evidence shares native identity and semantic name', () => {
    const rpc = mapCodexNotification({
      method: 'item/started',
      params: {
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'exec-native-1',
          command: 'pwd',
          cwd: '/tmp/work',
        },
      },
    })
    const jsonl = codexNativeToolIdentity(
      'CommandExecution',
      { type: 'CommandExecution', id: 'exec-native-1' },
      'CommandExecution'
    )

    expect(rpc).toEqual([
      {
        type: 'tool.call.started',
        payload: {
          toolCallId: 'exec-native-1',
          name: 'command',
          input: { command: 'pwd', cwd: '/tmp/work' },
        },
        extra: {
          turnId: 'turn-1',
          itemId: 'exec-native-1',
          driver: { kind: 'codex-app-server', rawType: 'item/started' },
        },
      },
    ])
    expect(jsonl).toEqual({
      itemId: 'exec-native-1',
      toolCallId: 'exec-native-1',
      name: 'command',
    })
  })

  test('shared identity mapping does not invent lifecycle or erase adapter-specific aliases', () => {
    expect(
      codexNativeToolIdentity(
        'DynamicToolCall',
        { type: 'DynamicToolCall', id: 'dynamic-1' },
        'DynamicToolCall'
      )
    ).toEqual({
      itemId: 'dynamic-1',
      toolCallId: 'dynamic-1',
      name: 'DynamicToolCall',
    })
    expect(codexNativeToolIdentity('CommandExecution', {}, 'CommandExecution')).toBeUndefined()
  })

  test('RPC command completion keeps its native identity and rich result unchanged', () => {
    const rpc = mapCodexNotification({
      method: 'item/completed',
      params: {
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'exec-native-1',
          command: 'pwd',
          cwd: '/tmp/work',
          aggregatedOutput: '/tmp/work\n',
          exitCode: 0,
          durationMs: 12,
        },
      },
    })

    expect(rpc).toEqual([
      {
        type: 'tool.call.completed',
        payload: {
          toolCallId: 'exec-native-1',
          name: 'command',
          result: { output: '/tmp/work\n', exitCode: 0 },
          isError: false,
          durationMs: 12,
        },
        extra: {
          turnId: 'turn-1',
          itemId: 'exec-native-1',
          driver: { kind: 'codex-app-server', rawType: 'item/completed' },
        },
      },
    ])
  })
})
