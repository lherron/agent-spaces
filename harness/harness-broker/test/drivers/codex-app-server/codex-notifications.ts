/** Native Codex JSON-RPC notification builders and a per-test notification mapper. */
import { beforeEach } from 'bun:test'
import { createCodexNotificationMapper } from '../../../src/drivers/codex-app-server/event-map'
import type { JsonRpcNotification } from '../../../src/drivers/codex-app-server/rpc-client'

export function note(method: string, params: unknown) {
  return { jsonrpc: '2.0' as const, method, params }
}

export function agentMessageCompleted(
  id: string,
  text: string,
  extra: Record<string, unknown> = {}
) {
  return note('item/completed', {
    turnId: 'turn_1',
    item: {
      type: 'agentMessage',
      id,
      text,
      ...extra,
    },
  })
}

/** A fresh stateful mapper for every test in the calling file. */
export function codexMapperPerTest() {
  let mapper = createCodexNotificationMapper()
  beforeEach(() => {
    mapper = createCodexNotificationMapper()
  })
  return {
    map: (notification: JsonRpcNotification) => mapper(notification),
    sequence: (notes: JsonRpcNotification[]) =>
      notes.flatMap((notification) => mapper(notification)),
  }
}
