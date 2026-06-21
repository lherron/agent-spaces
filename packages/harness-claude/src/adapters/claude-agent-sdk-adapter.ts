/**
 * ClaudeAgentSdkAdapter - Harness adapter for Claude Agent SDK
 *
 * Identical to the Claude adapter in every behavior; differs only in harness
 * identity (id/name). Extending ClaudeAdapter means the harnessId rewrite on
 * composed/loaded bundles and the output subdir are parameterized through
 * `this.id`, so the 9 previously-verbatim delegations are inherited unchanged.
 */

import type { HarnessId } from 'spaces-config'
import { ClaudeAdapter } from './claude-adapter.js'

export class ClaudeAgentSdkAdapter extends ClaudeAdapter {
  override readonly id: HarnessId = 'claude-agent-sdk'
  override readonly name: string = 'Claude Agent SDK'
}

export const claudeAgentSdkAdapter = new ClaudeAgentSdkAdapter()
