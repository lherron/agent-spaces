import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

interface RecordedEvent {
  seq: number
  type: string
  inputId: string | null
  turnId: string | null
  payload: Record<string, unknown>
  evidence: {
    sourceKind: string
    rawRecordId?: string
    nativeType?: string
  }
}

interface CodexTuiRecordedLedger {
  source: {
    host: string
    codexVersion: string
    matrixMarker: string
    recordedAt: string
    captureDir: string
    note: string
  }
  events: RecordedEvent[]
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures/codex-tui-live-race-0.153.4.events.json'), 'utf8')
) as CodexTuiRecordedLedger

const at = (seq: number): RecordedEvent => {
  const event = fixture.events.find((candidate) => candidate.seq === seq)
  if (event === undefined) throw new Error(`recorded event ${seq} is missing`)
  return event
}

describe('recorded codex-tui 0.153.4 admission ledger (T-08097)', () => {
  test('preserves the live idle-observation race without borrowing broker identity', () => {
    expect(fixture.source).toMatchObject({
      host: 'hrcdev',
      codexVersion: '0.153.4',
      matrixMarker: 'ASP_MATRIX_CODEX_TUI_MTP2LCJH',
    })
    expect(fixture.events.map((event) => event.seq)).toEqual(
      [...fixture.events].map((event) => event.seq).sort((left, right) => left - right)
    )

    const accepted = at(148)
    const foreignStarted = at(149)
    const queueAcknowledged = at(150)
    const foreignAttributed = at(151)
    const foreignUser = at(152)
    const foreignCompleted = at(175)
    const ownStarted = at(176)
    const ownAttributed = at(177)
    const executed = at(179)

    expect([accepted.type, foreignStarted.type, queueAcknowledged.type]).toEqual([
      'input.accepted',
      'turn.started',
      'driver.notice',
    ])
    expect(foreignStarted.payload).toMatchObject({ source: 'observed' })
    expect(foreignAttributed.payload).toMatchObject({ ownership: 'foreign', origin: 'human' })
    expect(foreignAttributed.inputId).toBeNull()
    expect(foreignUser.inputId).toBeNull()
    expect(foreignCompleted.inputId).toBeNull()
    expect(ownStarted.turnId).not.toBe(foreignStarted.turnId)
    expect(ownAttributed.payload).toMatchObject({
      ownership: 'own',
      origin: 'broker',
      inputId: accepted.inputId,
    })
    expect(executed.payload).toMatchObject({
      submissionId: accepted.inputId,
      turnId: ownStarted.turnId,
    })
    expect(fixture.events.some((event) => event.type === 'submission.lost')).toBe(false)
  })

  test('preserves steer, interrupt, and two consecutive queue dispositions', () => {
    const controlTurn = at(208).turnId
    expect(at(209).payload).toMatchObject({ ownership: 'own', inputId: at(206).inputId })
    expect(at(211).payload).toMatchObject({ submissionId: at(206).inputId, turnId: controlTurn })
    expect(at(216).payload).toMatchObject({ submissionId: at(215).inputId, turnId: controlTurn })
    expect([at(217).type, at(218).type, at(219).type]).toEqual([
      'interrupt.requested',
      'interrupt.landed',
      'turn.interrupted',
    ])
    expect(at(219)).toMatchObject({ turnId: controlTurn, inputId: at(206).inputId })

    for (const sequence of [
      { accepted: 223, started: 225, attributed: 226, executed: 228, final: 289, terminal: 290 },
      { accepted: 294, started: 296, attributed: 297, executed: 299, final: 328, terminal: 329 },
    ]) {
      const accepted = at(sequence.accepted)
      const started = at(sequence.started)
      expect(at(sequence.attributed).payload).toMatchObject({
        ownership: 'own',
        inputId: accepted.inputId,
      })
      expect(at(sequence.executed).payload).toMatchObject({
        submissionId: accepted.inputId,
        turnId: started.turnId,
      })
      expect(at(sequence.final).payload).toMatchObject({ final: true })
      expect(at(sequence.terminal)).toMatchObject({
        type: 'turn.completed',
        inputId: accepted.inputId,
        turnId: started.turnId,
      })
    }
  })

  test('keeps every retained provider fact tied to its committed raw row', () => {
    const providerEvents = fixture.events.filter(
      (event) => event.evidence.sourceKind === 'provider-jsonrpc'
    )
    expect(providerEvents.length).toBeGreaterThan(0)
    for (const event of providerEvents) {
      expect(event.evidence.rawRecordId).toMatch(/^raw_\d+$/)
      expect(event.evidence.nativeType?.length).toBeGreaterThan(0)
    }
  })
})
