import type { ArrisHostDescriptor } from 'spaces-harness-broker-protocol'
import type { DriverContext } from '../driver'
import { ARRIS_RESIDENT_DRIVER_KIND } from './driver-spec'

/**
 * Surfaces the two host-state facts a driver consumer cannot otherwise see:
 * that the host is blocked on a human, and whether it can answer mail at all.
 *
 * `awaiting_approval` is a real state, not a flavour of `ready` (arris
 * T-08520). A native Codex approval was offered to an attached client and is
 * unanswered; the turn that raised it cannot end, so anything queued behind it
 * waits on a turn that will never finish. The host publishes
 * `accepts_input: false` with it, so this driver already withholds
 * `invocation.ready` -- what was missing is anyone SAYING so. A consumer
 * watching a silent, not-ready invocation cannot tell "waiting on a person"
 * from "wedged".
 *
 * `control.mail_reply` (arris T-08521) says whether the host publishes
 * `arris.mail.reply` to its resident. False means no participant identity was
 * configured and the capability is absent, not merely refusing -- so a
 * resident asked to answer mail has no route and will say so. That is a
 * deployment fact worth one notice, not a capability this driver negotiates.
 */
export interface HostStateAnnouncer {
  /** Emits a notice for each host-state fact that changed since the last announcement. */
  announce(emit: DriverContext['emit'] | undefined, next: ArrisHostDescriptor): void
  /** Starts announcing; held off until `invocation.started` has been emitted. */
  begin(): void
  /** Stops announcing, keeping what was already announced. */
  silence(): void
  /** Forgets every announcement, for a fresh start. */
  reset(): void
}

export function createHostStateAnnouncer(): HostStateAnnouncer {
  /**
   * Last readiness state and mail-reply declaration this driver has ANNOUNCED,
   * so the descriptor poll emits a notice on a transition rather than once per
   * poll interval. `undefined` means nothing has been announced yet -- which is
   * also what a pre-T-08521 host leaves `mail_reply` as, so such a host stays
   * silent on the subject instead of being described as unable to answer mail.
   */
  let announcedReadinessState: string | undefined
  let announcedMailReply: boolean | undefined
  /**
   * Held false until `invocation.started` has been emitted. `start` refreshes
   * the descriptor before it announces the invocation, and a `driver.notice`
   * about a host not yet declared started is a notice about nothing. The first
   * announcement is made explicitly, right after that event.
   */
  let announcing = false

  function announce(emit: DriverContext['emit'] | undefined, next: ArrisHostDescriptor): void {
    if (emit === undefined || !announcing) return
    const extra = { driver: { kind: ARRIS_RESIDENT_DRIVER_KIND, rawType: 'host-descriptor' } }

    const state = next.readiness.state
    if (state !== announcedReadinessState) {
      const previous = announcedReadinessState
      announcedReadinessState = state
      if (state === 'awaiting_approval') {
        const pending = next.control.pending_approvals ?? []
        emit(
          'driver.notice',
          {
            code: 'ARRIS_AWAITING_APPROVAL',
            message: [
              'Arris host is awaiting a native approval and is not ready',
              pending.length > 0 ? ` (${pending.map((entry) => entry.class).join(', ')})` : '',
              `; the responder is ${next.control.approval_responder ?? 'unknown'}`,
            ].join(''),
            data: {
              readiness: next.readiness,
              pending_approvals: pending,
              approval_responder: next.control.approval_responder ?? null,
              accepts_input: next.readiness.accepts_input,
            },
          },
          extra
        )
      } else if (previous === 'awaiting_approval') {
        emit(
          'driver.notice',
          {
            code: 'ARRIS_APPROVAL_CLEARED',
            message: `Arris host left awaiting_approval for ${state}`,
            data: {
              readiness: next.readiness,
              pending_approvals: next.control.pending_approvals ?? [],
            },
          },
          extra
        )
      }
    }

    const mailReply = next.control.mail_reply
    if (mailReply !== undefined && mailReply !== announcedMailReply) {
      announcedMailReply = mailReply
      const participant = next.identity?.participant ?? null
      emit(
        'driver.notice',
        {
          code: 'ARRIS_MAIL_REPLY',
          message: mailReply
            ? `Arris host publishes arris.mail.reply as ${participant?.principal_ref ?? 'an unnamed participant'}`
            : 'Arris host has no participant identity; arris.mail.reply is not published to the resident',
          data: { mail_reply: mailReply, participant },
        },
        extra
      )
    }
  }

  return {
    announce,
    begin: () => {
      announcing = true
    },
    silence: () => {
      announcing = false
    },
    reset: () => {
      announcedReadinessState = undefined
      announcedMailReply = undefined
      announcing = false
    },
  }
}
