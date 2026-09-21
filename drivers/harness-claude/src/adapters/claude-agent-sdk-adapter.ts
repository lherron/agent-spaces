/**
 * ClaudeAgentSdkAdapter - Harness adapter for Claude Agent SDK
 *
 * Identical to the Claude adapter in every behavior; differs only in harness
 * identity (id/name). Extending ClaudeAdapter means the harnessId rewrite on
 * composed/loaded bundles and the output subdir are parameterized through
 * `this.id`, so the 9 previously-verbatim delegations are inherited unchanged.
 */

import { ClaudeAdapter } from './claude-adapter.js'

export class ClaudeAgentSdkAdapter extends ClaudeAdapter {
  // Legacy adapter id (retired from selection; package deleted in T-08698).
  override readonly id: string = 'claude-agent-sdk'
  override readonly name: string = 'Claude Agent SDK'
}

export const claudeAgentSdkAdapter = new ClaudeAgentSdkAdapter()
