import { describe, expect, test } from 'bun:test'
import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseJsonRpcMessage,
} from '../src/jsonrpc'

describe('JSON-RPC 2.0 message parsing and discrimination', () => {
  test('parses and discriminates requests', () => {
    const message = parseJsonRpcMessage(
      '{"jsonrpc":"2.0","id":"1","method":"broker.hello","params":{"clientInfo":{"name":"example-client"},"protocolVersions":["harness-broker/0.1"]}}'
    )

    expect(isJsonRpcRequest(message)).toBe(true)
    expect(isJsonRpcNotification(message)).toBe(false)
    expect(isJsonRpcResponse(message)).toBe(false)
    expect(message).toMatchObject({
      jsonrpc: '2.0',
      id: '1',
      method: 'broker.hello',
    })
  })

  test('parses and discriminates notifications', () => {
    const message = parseJsonRpcMessage(
      '{"jsonrpc":"2.0","method":"invocation.event","params":{"invocationId":"inv_1","seq":1,"time":"2026-05-20T18:00:00.000Z","type":"invocation.ready","payload":{}}}'
    )

    expect(isJsonRpcNotification(message)).toBe(true)
    expect(isJsonRpcRequest(message)).toBe(false)
    expect(isJsonRpcResponse(message)).toBe(false)
    expect(message).toMatchObject({
      jsonrpc: '2.0',
      method: 'invocation.event',
    })
  })

  test('parses and discriminates result responses', () => {
    const message = parseJsonRpcMessage(
      '{"jsonrpc":"2.0","id":"2","result":{"invocationId":"inv_1","status":"starting"}}'
    )

    expect(isJsonRpcResponse(message)).toBe(true)
    expect(isJsonRpcRequest(message)).toBe(false)
    expect(isJsonRpcNotification(message)).toBe(false)
    expect(message).toMatchObject({
      jsonrpc: '2.0',
      id: '2',
      result: { invocationId: 'inv_1' },
    })
  })

  test('parses and discriminates error responses', () => {
    const message = parseJsonRpcMessage(
      '{"jsonrpc":"2.0","id":"req_7","error":{"code":-32003,"message":"unsupported input","data":{"capability":"input.steer"}}}'
    )

    expect(isJsonRpcResponse(message)).toBe(true)
    expect(isJsonRpcRequest(message)).toBe(false)
    expect(isJsonRpcNotification(message)).toBe(false)
    expect(message).toMatchObject({
      jsonrpc: '2.0',
      id: 'req_7',
      error: {
        code: -32003,
        message: 'unsupported input',
      },
    })
  })

  test('supports responses interleaved with event notifications', () => {
    const messages = [
      parseJsonRpcMessage('{"jsonrpc":"2.0","id":"1","result":{"ok":true}}'),
      parseJsonRpcMessage(
        '{"jsonrpc":"2.0","method":"invocation.event","params":{"invocationId":"inv_1","seq":1,"time":"2026-05-20T18:00:00.000Z","type":"invocation.started","payload":{}}}'
      ),
      parseJsonRpcMessage('{"jsonrpc":"2.0","id":"2","result":{"ok":true}}'),
    ]

    expect(messages.map(isJsonRpcResponse)).toEqual([true, false, true])
    expect(messages.map(isJsonRpcNotification)).toEqual([false, true, false])
  })

  test('rejects malformed shapes with a stable parse code', () => {
    expect(() => parseJsonRpcMessage('{"id":"1","method":"broker.hello"}')).toThrow(
      expect.objectContaining({ code: 'INVALID_JSON_RPC' })
    )

    expect(() => parseJsonRpcMessage('{"jsonrpc":"2.0","id":"1"}')).toThrow(
      expect.objectContaining({ code: 'INVALID_JSON_RPC' })
    )
  })

  // BUGS.md harness-broker-protocol A4: `isJsonRpcResponse` keys off
  // `Object.hasOwn(value, 'result')` without checking the value is non-undefined,
  // so an in-memory object carrying `result: undefined` (which JSON parsing can
  // never produce, but a standalone guard call can) is wrongly classified as a
  // valid result-response. Likewise an empty-string `method` is accepted. These
  // assert the tightened contract and must be un-skipped once A4 is fixed.
  test.todo(
    'isJsonRpcResponse rejects an in-memory object with result: undefined (BUGS A4)',
    () => {
      expect(isJsonRpcResponse({ jsonrpc: '2.0', id: '1', result: undefined })).toBe(false)
    }
  )

  test.todo('isJsonRpcRequest rejects an empty-string method (BUGS A4)', () => {
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: '1', method: '' })).toBe(false)
  })
})
