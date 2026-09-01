import type { EvidenceAuthorityMatrix } from 'spaces-harness-broker-protocol'

/**
 * Declared per-event-family evidence authority for the in-process pi-sdk driver
 * (T-07853 §6; law `agent-spaces.harness-broker-local-commit-observation`).
 *
 * Unlike the tmux drivers there is no hook channel and no transcript file: the
 * driver holds the SDK session itself, so provider-observed families are
 * `native` (the SDK's own streamed events) and everything the broker decides
 * stays `broker`. The turn bracket is `broker` for the same reason
 * pi-tui-tmux's is: it is the bounded accepted risk
 * `agent-spaces.pi-delivery-asserted-turn-start`, minted at delivery rather
 * than from an acknowledgement.
 */
export const PI_SDK_AUTHORITY: EvidenceAuthorityMatrix = {
  'invocation-lifecycle': 'broker',
  'harness-lifecycle': 'broker',
  continuation: 'native',
  'input-admission': 'broker',
  'submission-disposition': 'broker',
  'turn-bracket': 'broker',
  'turn-supervision': 'broker',
  conversation: 'native',
  tool: 'native',
  usage: 'native',
  permission: 'native',
  diagnostic: 'broker',
  'terminal-surface': 'broker',
  'provider-artifact': 'broker',
}
