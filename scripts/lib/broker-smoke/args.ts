/**
 * CLI argument parsing and scenario routing for the broker smoke test.
 */
import { join } from 'node:path'

import type { ParsedArgs, ScenarioName, ScenarioSelection } from './types.ts'

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const DEFAULT_PROMPT =
  'Execute the shell command `pwd`. Do not execute any other shell commands. After it completes, reply with exactly two tokens separated by a space: ASP_BROKER_OK and the full runtime scope handle from your priming context. Use the shorthand handle form such as <agent>@<project>:<task>; do not use the colon-separated scopeRef form such as agent:<agent>:project:<project>:task:<task>.'
export const QUEUE_POLICY_PROMPT =
  'Execute the shell command `sleep 6 && pwd`. Do not execute any other shell commands. After it completes, reply with exactly two tokens separated by a space: QUEUE_HOLDER_OK and the full runtime scope handle from your priming context. Use the shorthand handle form such as <agent>@<project>:<task>; do not use the colon-separated scopeRef form such as agent:<agent>:project:<project>:task:<task>.'

const DEFAULT_TIMEOUT_S = 120

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

export function printUsage(): void {
  console.log(
    [
      'Usage:',
      '  bun scripts/smoke-asp-broker-real-codex.ts [options]',
      '',
      'Options:',
      '  --scope-ref <handle>    Scope handle, e.g. cody@agent-spaces (default: cody@agent-spaces)',
      '  --agent-root <path>     Explicit agent root directory',
      '  --project-root <path>   Explicit project root directory',
      '  --cwd <path>            Working directory for execution',
      '  --asp-home <path>       ASP home for materialization (default: /tmp/asp-broker-smoke)',
      '  --invocation-id <id>    Invocation ID (default: smoke-<unix-timestamp>)',
      `  --timeout <seconds>     Overall timeout in seconds (default: ${DEFAULT_TIMEOUT_S})`,
      '  --transcript <path>     JSONL transcript output path (default: <asp-home>/transcript-<ts>.jsonl)',
      `  --prompt <text>         Prompt text (default: "${DEFAULT_PROMPT}")`,
      '  --scenario <name>       Scenario to run: happy, queue-policy, all (default: happy)',
      '  --help                  Show this message',
      '',
      'Exit codes:',
      '  0  All required events observed, turn completed successfully',
      '  1  Assertion failure (missing events, turn failed/interrupted)',
      '  2  Broker/Codex startup failure',
      '',
      'Example:',
      '  bun scripts/smoke-asp-broker-real-codex.ts \\',
      '    --scope-ref cody@agent-spaces \\',
      '    --asp-home /tmp/asp-broker-smoke',
    ].join('\n')
  )
}

export function parseArgs(argv: string[]): ParsedArgs {
  const now = Math.floor(Date.now() / 1000)
  const args: ParsedArgs = {
    scopeRef: 'cody@agent-spaces',
    aspHome: '/tmp/asp-broker-smoke',
    invocationId: `smoke-${now}`,
    timeout: DEFAULT_TIMEOUT_S,
    transcript: '', // filled after aspHome is known
    prompt: DEFAULT_PROMPT,
    scenario: 'happy',
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue
    if (arg === '--help') {
      args.help = true
      return args
    }
    switch (arg) {
      case '--scope-ref':
        args.scopeRef = argv[++i] ?? ''
        if (!args.scopeRef) throw new Error('Missing value for --scope-ref')
        break
      case '--agent-root':
        args.agentRoot = argv[++i]
        if (!args.agentRoot) throw new Error('Missing value for --agent-root')
        break
      case '--project-root':
        args.projectRoot = argv[++i]
        if (!args.projectRoot) throw new Error('Missing value for --project-root')
        break
      case '--cwd':
        args.cwd = argv[++i]
        if (!args.cwd) throw new Error('Missing value for --cwd')
        break
      case '--asp-home':
        args.aspHome = argv[++i] ?? ''
        if (!args.aspHome) throw new Error('Missing value for --asp-home')
        break
      case '--invocation-id':
        args.invocationId = argv[++i] ?? ''
        if (!args.invocationId) throw new Error('Missing value for --invocation-id')
        break
      case '--timeout':
        args.timeout = Number(argv[++i])
        if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
          throw new Error('--timeout must be a positive number')
        }
        break
      case '--transcript':
        args.transcript = argv[++i] ?? ''
        if (!args.transcript) throw new Error('Missing value for --transcript')
        break
      case '--prompt':
        args.prompt = argv[++i] ?? ''
        if (!args.prompt) throw new Error('Missing value for --prompt')
        break
      case '--scenario': {
        const scenario = argv[++i] ?? ''
        if (scenario !== 'happy' && scenario !== 'queue-policy' && scenario !== 'all') {
          throw new Error('--scenario must be one of: happy, queue-policy, all')
        }
        args.scenario = scenario
        break
      }
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  // Default transcript path
  if (!args.transcript) {
    args.transcript = join(args.aspHome, `transcript-${now}.jsonl`)
  }

  return args
}

// ---------------------------------------------------------------------------
// Scenario routing helpers
// ---------------------------------------------------------------------------

export function selectedScenarios(selection: ScenarioSelection): ScenarioName[] {
  return selection === 'all' ? ['happy', 'queue-policy'] : [selection]
}

export function scenarioArgs(
  args: ParsedArgs,
  scenario: ScenarioName,
  multiScenario: boolean
): ParsedArgs {
  const invocationId = multiScenario ? `${args.invocationId}-${scenario}` : args.invocationId
  const transcript = !multiScenario
    ? args.transcript
    : args.transcript.endsWith('.jsonl')
      ? args.transcript.replace(/\.jsonl$/, `-${scenario}.jsonl`)
      : `${args.transcript}-${scenario}`

  return {
    ...args,
    invocationId,
    transcript,
    prompt: scenario === 'queue-policy' ? QUEUE_POLICY_PROMPT : args.prompt,
  }
}
