export { ClaudeAdapter, claudeAdapter } from './adapters/claude-adapter.js'
export {
  ClaudeAgentSdkAdapter,
  claudeAgentSdkAdapter,
} from './adapters/claude-agent-sdk-adapter.js'
export { detectClaude, type ClaudeInfo } from './claude/index.js'
export {
  ensureClaudeWorkspaceTrust,
  resolveClaudeUserConfigPath,
  type EnsureWorkspaceTrustResult,
} from './claude/workspace-trust.js'
export { register } from './register.js'
