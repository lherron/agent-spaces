import type { ResolvedRecipeBuilder } from './compile-plan-types.js'
import { compileTerminalBrokerPlan } from './compile-tmux-broker-plan.js'

/** Carry the prepared launch to the supervisor driver's spawn, never a tmux paste. */
export const compileClaudeHrcptyPlan: ResolvedRecipeBuilder = (req, placement, resolved, options) =>
  compileTerminalBrokerPlan(
    req,
    placement,
    resolved,
    {
      driverKind: 'claude-code-hrcpty',
      terminalHost: 'hrcpty',
      provider: 'anthropic',
      frontend: 'claude-code',
      honorDisallowedTools: true,
    },
    options
  )
