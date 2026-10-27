import { describe, expect, test } from 'bun:test'
import { isJsonRpcRequest, isJsonRpcResponse, parseJsonRpcMessage } from '../src/jsonrpc'

describe('JSON-RPC 2.0 message parsing and discrimination', () => {
  test('rejects malformed shapes with a stable parse code', () => {
    expect(() => parseJsonRpcMessage('{"id":"1","method":"broker.hello"}')).toThrow(
      expect.objectContaining({ code: 'INVALID_JSON_RPC' })
    )

    expect(() => parseJsonRpcMessage('{"jsonrpc":"2.0","id":"1"}')).toThrow(
      expect.objectContaining({ code: 'INVALID_JSON_RPC' })
    )
  })

  // wrkq T-10129 attachment BUGS.md (ATT-00153) harness-broker-protocol A4: `isJsonRpcResponse` keys off
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
