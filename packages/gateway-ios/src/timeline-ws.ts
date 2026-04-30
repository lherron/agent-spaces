/**
 * WS /v1/timeline — projected timeline frames + control messages.
 *
 * Accepts query: ?sessionRef=<encoded>&fromHrcSeq=<n>&fromMessageSeq=<n>&raw=<bool>
 *
 * Open sequence:
 * 1. Parse query params, validate sessionRef.
 * 2. Start both async iterator pumps BEFORE snapshot (via event-pump).
 * 3. Build snapshot: project replay through reducer → SnapshotMessage with HistoryPage.
 * 4. Send snapshot.
 * 5. Drain buffers, then forward live events+messages as FrameMessage and optionally HrcEventMessage.
 * 6. On close: cancel both iterators via AbortController.
 */

import type { ServerWebSocket } from 'bun'
import type { HrcLifecycleEvent, HrcMessageRecord } from 'hrc-core'

import type {
  FrameMessage,
  GatewayWsMessage,
  HrcEventMessage,
  MobileSessionSummary,
  SnapshotHighWater,
  SnapshotMessage,
  TimelineFrame,
} from './contracts.js'
import type { EventPumpHrcClient } from './event-pump.js'
import { runEventPump } from './event-pump.js'
import { createReducerState, reduce } from './event-reducer.js'
import { createLogger } from './logger.js'
import type { ReducerInput } from './types.js'

const log = createLogger({ component: 'timeline-ws' })

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Data attached to each WebSocket connection for the timeline route. */
export type TimelineWsData = {
  sessionRef: string
  fromHrcSeq: number
  fromMessageSeq: number
  raw: boolean
  abortController: AbortController
}

/** Dependencies injected into the timeline WS handler. */
export type TimelineWsDeps = {
  hrcClient: EventPumpHrcClient
  /** Resolve a session summary from sessionRef. */
  resolveSession: (sessionRef: string) => Promise<MobileSessionSummary>
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create the timeline WebSocket handler functions for Bun.serve.
 */
export function createTimelineWsHandler(deps: TimelineWsDeps) {
  return {
    /**
     * Called on WS upgrade. Parse query params and attach data.
     * Returns the TimelineWsData to attach, or null to reject.
     */
    parseUpgrade(url: URL): TimelineWsData | null {
      const sessionRef = url.searchParams.get('sessionRef')
      if (!sessionRef) return null

      const fromHrcSeq = Number.parseInt(url.searchParams.get('fromHrcSeq') ?? '0', 10)
      const fromMessageSeq = Number.parseInt(url.searchParams.get('fromMessageSeq') ?? '0', 10)
      const raw = url.searchParams.get('raw') === 'true'

      return {
        sessionRef,
        fromHrcSeq: Number.isFinite(fromHrcSeq) ? fromHrcSeq : 0,
        fromMessageSeq: Number.isFinite(fromMessageSeq) ? fromMessageSeq : 0,
        raw,
        abortController: new AbortController(),
      }
    },

    /**
     * Called when the WebSocket opens. Starts the event pump.
     */
    async open(ws: ServerWebSocket<TimelineWsData>): Promise<void> {
      const { sessionRef, fromHrcSeq, fromMessageSeq, raw, abortController } = ws.data

      log.info('timeline_ws.open', {
        data: { sessionRef, fromHrcSeq, fromMessageSeq, raw },
      })

      // Track reducer state for incremental projection
      let reducerState = createReducerState()
      let frameSeqCounter = 1

      // Helper: send a message to the WebSocket
      const send = (msg: GatewayWsMessage): void => {
        if (abortController.signal.aborted) return
        try {
          ws.send(JSON.stringify(msg))
        } catch {
          // WS may have closed between check and send
        }
      }

      try {
        // Resolve session info
        const session = await deps.resolveSession(sessionRef)

        await runEventPump({
          hrcClient: deps.hrcClient,
          sessionRef,
          fromHrcSeq,
          fromMessageSeq,
          signal: abortController.signal,

          // Build snapshot: project replay events+messages through reducer
          async buildSnapshot(_replay) {
            // For now the snapshot builds an empty frame list starting from the
            // requested cursors. The actual replay data would come from the
            // HRC store (out of scope for the pump — the pump starts live
            // iterators and the snapshot builder queries the store separately).
            // In this implementation, we send an empty snapshot and let
            // the live pump fill in frames.

            const snapshotHighWater: SnapshotHighWater = {
              hrcSeq: fromHrcSeq,
              messageSeq: fromMessageSeq,
            }

            const snapshotMsg: SnapshotMessage = {
              type: 'snapshot',
              session,
              snapshotHighWater,
              history: {
                frames: [],
                oldestCursor: { hrcSeq: fromHrcSeq, messageSeq: fromMessageSeq },
                newestCursor: { hrcSeq: fromHrcSeq, messageSeq: fromMessageSeq },
                hasMoreBefore: fromHrcSeq > 0,
              },
            }

            send(snapshotMsg)

            return snapshotHighWater
          },

          // Emit live HRC event: project through reducer → FrameMessage
          onEvent(event: HrcLifecycleEvent) {
            const input: ReducerInput = { kind: 'event', event }
            const result = reduce(reducerState, input)
            reducerState = result.state

            for (const update of result.frameUpdates) {
              if (update.action === 'create' || update.action === 'update') {
                // Override frameSeq with wire delivery order
                const frame: TimelineFrame = {
                  ...update.frame,
                  frameSeq: frameSeqCounter++,
                }

                const frameMsg: FrameMessage = {
                  type: 'frame',
                  frame,
                }
                send(frameMsg)
              }
            }

            // If raw mode, also send the raw event
            if (raw) {
              const hrcEventMsg: HrcEventMessage = {
                type: 'hrc_event',
                hrcSeq: event.hrcSeq,
                streamSeq: event.streamSeq,
                eventKind: event.eventKind,
                category: event.category,
                ts: event.ts,
                payload: event.payload,
              }
              send(hrcEventMsg)
            }
          },

          // Emit live message: project through reducer → FrameMessage
          onMessage(message: HrcMessageRecord) {
            const input: ReducerInput = { kind: 'message', message }
            const result = reduce(reducerState, input)
            reducerState = result.state

            for (const update of result.frameUpdates) {
              if (update.action === 'create' || update.action === 'update') {
                const frame: TimelineFrame = {
                  ...update.frame,
                  frameSeq: frameSeqCounter++,
                }

                const frameMsg: FrameMessage = {
                  type: 'frame',
                  frame,
                }
                send(frameMsg)
              }
            }
          },
        })
      } catch (err: unknown) {
        if (!abortController.signal.aborted) {
          const msg = err instanceof Error ? err.message : String(err)
          log.error('timeline_ws.error', { message: msg })
          send({ type: 'error', code: 'INTERNAL_ERROR', message: msg })
        }
      }
    },

    /**
     * Called when the WebSocket closes. Cancel all pumps.
     */
    close(ws: ServerWebSocket<TimelineWsData>): void {
      log.info('timeline_ws.close', {
        data: { sessionRef: ws.data.sessionRef },
      })
      ws.data.abortController.abort()
    },

    /**
     * Called when a message is received from the client.
     * Timeline WS is server→client only; client messages are ignored
     * except for pong responses.
     */
    message(ws: ServerWebSocket<TimelineWsData>, message: string | Buffer): void {
      try {
        const text = typeof message === 'string' ? message : message.toString()
        const parsed = JSON.parse(text)
        if (parsed?.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }))
        }
      } catch {
        // Ignore malformed client messages
      }
    },
  }
}
