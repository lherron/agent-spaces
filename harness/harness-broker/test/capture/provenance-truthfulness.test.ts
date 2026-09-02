import { describe, expect, test } from 'bun:test'
import type {
  EventFamily,
  EvidenceAuthorityMatrix,
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationEventType,
} from 'spaces-harness-broker-protocol'
import { EVENT_FAMILY_BY_TYPE } from 'spaces-harness-broker-protocol'
import { PI_SDK_AUTHORITY } from '../../../harness-broker-pi-sdk/src/evidence-authority'
import { createBroker } from '../../src/broker'
import type { Driver } from '../../src/drivers/driver'
import {
  AGENT_HARNESS_TMUX_AUTHORITY,
  CLAUDE_CODE_TMUX_AUTHORITY,
  CODEX_APP_SERVER_AUTHORITY,
  CODEX_CLI_TMUX_AUTHORITY,
  PI_TUI_TMUX_AUTHORITY,
} from '../../src/drivers/evidence-authority'
import { createTestDriver } from '../../src/testing/test-driver'

/**
 * Provenance truthfulness — a MECHANICAL cross-driver rule (T-07870 §4,
 * T-07853 §7.2).
 *
 * An event whose `provenance.sourceKind` is `provider-*` claims the provider's
 * own transcript or protocol stream reported it, and §7.1 makes the committed
 * raw record the only thing that can substantiate that claim. An envelope that
 * claims a provider source and names no record is UNFALSIFIABLE: there is
 * nothing on disk to open. T-07868's in-memory-journal defect survived a green
 * suite for exactly that reason, and T-07868 left seven codex-app-server events
 * in that state (C-18202).
 *
 * The rule is enforced at `buildEventExtra`, the one seam every event passes
 * through, so no driver can opt out of it — which is what makes it cross-driver
 * rather than per-driver. This test drives EVERY shipped driver's real
 * declaration through that seam.
 */

const DECLARED: Record<
  string,
  { authority: EvidenceAuthorityMatrix; native: Driver['nativeSourceKind'] }
> = {
  'claude-code-tmux': { authority: CLAUDE_CODE_TMUX_AUTHORITY, native: 'provider-jsonl' },
  'codex-cli-tmux': { authority: CODEX_CLI_TMUX_AUTHORITY, native: 'provider-jsonl' },
  'codex-app-server': { authority: CODEX_APP_SERVER_AUTHORITY, native: 'provider-jsonrpc' },
  'pi-tui-tmux': { authority: PI_TUI_TMUX_AUTHORITY, native: 'provider-jsonl' },
  'agent-harness-tmux': { authority: AGENT_HARNESS_TMUX_AUTHORITY, native: 'provider-jsonrpc' },
  'pi-sdk': { authority: PI_SDK_AUTHORITY, native: 'provider-jsonl' },
}

/**
 * One event type per family whose payload the manager will accept unvalidated
 * enough to reach the seam. The families that matter here are the ones a
 * declaration can mark `native`; the rest are exercised anyway so the sweep is
 * total over {@link EVENT_FAMILY_BY_TYPE}.
 */
const PROBE_BY_FAMILY: Partial<
  Record<EventFamily, { type: InvocationEventType; payload: unknown }>
> = {
  'harness-lifecycle': {
    type: 'harness.started',
    payload: { generation: 1, mode: 'initial', mechanism: 'direct-child' },
  },
  continuation: {
    type: 'continuation.updated',
    payload: { provider: 'openai', kind: 'session', key: 'k' },
  },
  'submission-disposition': {
    type: 'submission.absorbed',
    payload: { submissionId: 'submission_probe', turnId: 'turn_probe' },
  },
  conversation: { type: 'user.message', payload: { content: 'hi' } },
  tool: {
    type: 'tool.call.started',
    payload: { toolCallId: 'tool_probe', name: 'probe' },
  },
  usage: { type: 'usage.updated', payload: { usage: { inputTokens: 1, outputTokens: 1 } } },
  diagnostic: {
    type: 'diagnostic',
    payload: { level: 'info', source: 'driver', message: 'probe' },
  },
}

/**
 * The seam reads the DRIVER'S DECLARATION, never its name, so every row runs on
 * one `test-driver` carrying the declaration under test. Registering the real
 * driver kinds instead would drag their spec validation and process launch into
 * a test about provenance.
 */
const spec = (invocationId: string): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId,
  harness: { frontend: 'test', provider: 'test', driver: 'test-driver' },
  process: {
    command: 'test-driver',
    args: [],
    cwd: process.cwd(),
    harnessTransport: { kind: 'pipes' },
  },
  interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'fifo' },
  driver: { kind: 'test-driver' },
})

async function emitProbes(
  kind: string,
  declaration: { authority: EvidenceAuthorityMatrix; native: Driver['nativeSourceKind'] },
  extraEmits?: (
    emit: (type: InvocationEventType, payload: unknown, extra?: unknown) => void
  ) => void
): Promise<InvocationEventEnvelope[]> {
  const events: InvocationEventEnvelope[] = []
  const { driver, controller } = createTestDriver({
    evidenceAuthority: declaration.authority,
    nativeSourceKind: declaration.native,
  })
  const broker = createBroker({ drivers: [driver], onEvent: (event) => events.push(event) })
  const invocationId = `inv_provenance_${kind.replace(/-/g, '_')}`
  const started = await broker.start({ spec: spec(invocationId) })
  for (const probe of Object.values(PROBE_BY_FAMILY)) {
    if (probe === undefined) continue
    controller.emitRaw(probe.type, probe.payload)
  }
  extraEmits?.((type, payload, extra) => controller.emitRaw(type, payload, extra))
  expect(started.invocationId).toBe(invocationId)
  return events
}

function offenders(events: InvocationEventEnvelope[]): string[] {
  return events
    .filter(
      (event) =>
        event.provenance?.sourceKind.startsWith('provider-') === true &&
        event.provenance.rawRecordId === undefined
    )
    .map((event) => `${event.type} (${event.provenance?.sourceKind})`)
}

describe('provenance truthfulness (cross-driver)', () => {
  for (const [kind, declaration] of Object.entries(DECLARED)) {
    test(`${kind}: no event claims a provider source without naming a record`, async () => {
      const events = await emitProbes(kind, declaration)
      // The sweep must actually cover the driver's native-declared families,
      // or a green result would only mean nothing was emitted.
      const nativeFamilies = Object.entries(declaration.authority)
        .filter(
          ([family, authority]) =>
            authority === 'native' && PROBE_BY_FAMILY[family as EventFamily] !== undefined
        )
        .map(([family]) => family)
      const covered = events.filter(
        (event) => nativeFamilies.includes(EVENT_FAMILY_BY_TYPE[event.type]) === true
      )
      if (nativeFamilies.length > 0) expect(covered.length).toBeGreaterThan(0)
      expect(offenders(events)).toEqual([])
    })
  }

  test('an explicit provider-tagged provenance with no record is degraded, not published', async () => {
    // The seam is the enforcement point, so a DRIVER that supplies the false
    // claim directly must be corrected too — otherwise the rule would only
    // constrain the manager's own default.
    const events = await emitProbes(
      'codex-app-server',
      DECLARED['codex-app-server'] as (typeof DECLARED)[string],
      (emit) => {
        emit(
          'tool.call.started',
          { toolCallId: 'tool_explicit', name: 'probe' },
          {
            provenance: {
              sourceKind: 'provider-jsonrpc',
              nativeType: 'item/started',
              normalizer: { name: 'codex-app-server', version: '0.1.0' },
            },
          }
        )
      }
    )
    const explicit = events.filter(
      (event) =>
        event.type === 'tool.call.started' &&
        (event.payload as { toolCallId?: string }).toolCallId === 'tool_explicit'
    )
    expect(explicit).toHaveLength(1)
    expect(explicit[0]?.provenance?.sourceKind).toBe('broker')
    // The parts that WERE known survive the degrade.
    expect(explicit[0]?.provenance?.nativeType).toBe('item/started')
    expect(offenders(events)).toEqual([])
  })

  test('a provider claim that DOES name a record is published unchanged', async () => {
    const events = await emitProbes(
      'codex-app-server',
      DECLARED['codex-app-server'] as (typeof DECLARED)[string],
      (emit) => {
        emit(
          'tool.call.started',
          { toolCallId: 'tool_recorded', name: 'probe' },
          {
            provenance: {
              rawRecordId: 'raw_000007',
              sourceKind: 'provider-jsonrpc',
              nativeType: 'item/started',
              normalizer: { name: 'codex-app-server', version: '0.1.0' },
            },
          }
        )
      }
    )
    const recorded = events.find(
      (event) =>
        event.type === 'tool.call.started' &&
        (event.payload as { toolCallId?: string }).toolCallId === 'tool_recorded'
    )
    expect(recorded?.provenance?.sourceKind).toBe('provider-jsonrpc')
    expect(recorded?.provenance?.rawRecordId).toBe('raw_000007')
  })
})
