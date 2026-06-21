import { describe, expect, test } from 'bun:test'
import { durableUnixBrokerRuntimeState } from './fixtures/compile-fixtures'

describe('BrokerRuntimeState durable IPC contract', () => {
  test('round-trips unix broker endpoint, attachment mode, tmux panes, and high-water metadata', () => {
    // T-01791 Phase A fixture: this shape is what HRC persists before reattaching
    // to a surviving broker over Unix JSON-RPC NDJSON after controller restart.
    const roundTripped = JSON.parse(JSON.stringify(durableUnixBrokerRuntimeState))

    expect(roundTripped.broker.endpoint).toEqual({
      kind: 'unix-jsonrpc-ndjson',
      socketPath: '/tmp/praesidium/runtime/broker-ipc/runtime-1/broker.sock',
      attachTokenRef: {
        kind: 'file',
        path: '/tmp/praesidium/runtime/broker-ipc/runtime-1/attach-token',
        redacted: true,
      },
    })
    expect(roundTripped.control).toMatchObject({
      mode: 'broker-ipc',
      brokerAttached: true,
      lastAttachError: null,
    })
    expect(roundTripped.broker.tmux).toMatchObject({ windowName: 'broker', paneId: '%1' })
    expect(roundTripped.tui).toMatchObject({
      windowName: 'tui',
      paneId: '%2',
      operatorAttachTarget: true,
    })
    expect(roundTripped.eventHighWater).toBe(123)
  })
})
