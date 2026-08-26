import type { LoadAgentOptions } from 'agent-harness-runtime'
import { runBrokerCli } from 'spaces-harness-broker-pi-sdk'

import { createAgentHarnessDriver } from './broker/driver.js'
import { runAgentHarnessPrint } from './foreground/print.js'
import { runAgentHarnessTui } from './foreground/tui.js'

export interface ForegroundInvocation extends LoadAgentOptions {
  /** Selects the broker-owned interactive control path. */
  brokerControlSocket?: string | undefined
  prompt?: string | undefined
  /** `true` continues the most recent agent-scoped session; a string opens that session. */
  resume?: string | boolean | undefined
}

export interface AgentHarnessCliDependencies {
  runBrokerCli: () => Promise<void>
  runTui: (invocation: ForegroundInvocation) => Promise<void>
  runPrint: (invocation: ForegroundInvocation & { prompt: string }) => Promise<number>
  isInteractiveTerminal: () => boolean
  setExitCode: (code: number) => void
}

const productionDependencies: AgentHarnessCliDependencies = {
  runBrokerCli: () => runBrokerCli({ additionalDrivers: [createAgentHarnessDriver] }),
  runTui: runAgentHarnessTui,
  runPrint: runAgentHarnessPrint,
  isInteractiveTerminal: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  setExitCode: (code) => {
    process.exitCode = code
  },
}

export async function runAgentHarness(): Promise<void> {
  await dispatchAgentHarness(process.argv.slice(2))
}

/** Dispatch foreground modes while preserving every existing broker subcommand. */
export async function dispatchAgentHarness(
  args: string[],
  dependencies: AgentHarnessCliDependencies = productionDependencies
): Promise<void> {
  const [command, ...rest] = args
  if (command === 'tui') {
    if (!dependencies.isInteractiveTerminal())
      throw new Error('agent-harness tui requires an interactive terminal')
    await dependencies.runTui(parseForegroundInvocation(rest))
    return
  }
  if (command === 'print') {
    const invocation = parseForegroundInvocation(rest)
    if (invocation.prompt === undefined) throw new Error('agent-harness print requires a prompt')
    dependencies.setExitCode(
      await dependencies.runPrint(invocation as ForegroundInvocation & { prompt: string })
    )
    return
  }
  await dependencies.runBrokerCli()
}

export function parseForegroundInvocation(args: string[]): ForegroundInvocation {
  const invocation: ForegroundInvocation = { agentId: '' }
  const positional: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const value = args[index + 1]
    switch (arg) {
      case '--agent-id':
        invocation.agentId = requiredValue(arg, value)
        index += 1
        break
      case '--project-id':
        invocation.projectId = requiredValue(arg, value)
        index += 1
        break
      case '--agent-root':
        invocation.agentRoot = requiredValue(arg, value)
        index += 1
        break
      case '--project-root':
        invocation.projectRoot = requiredValue(arg, value)
        index += 1
        break
      case '--cwd':
        invocation.cwd = requiredValue(arg, value)
        index += 1
        break
      case '--asp-home':
        invocation.aspHome = requiredValue(arg, value)
        index += 1
        break
      case '--run-mode':
        invocation.runMode = requiredValue(arg, value) as ForegroundInvocation['runMode']
        index += 1
        break
      case '--scope-ref':
        invocation.scopeRef = requiredValue(arg, value)
        index += 1
        break
      case '--lane-ref':
        invocation.laneRef = requiredValue(arg, value)
        index += 1
        break
      case '--run-id':
        invocation.runId = requiredValue(arg, value)
        index += 1
        break
      case '--host-session-id':
        invocation.hostSessionId = requiredValue(arg, value)
        index += 1
        break
      case '--generation':
        invocation.generation = parseGeneration(requiredValue(arg, value))
        index += 1
        break
      case '--model':
        invocation.model = requiredValue(arg, value)
        index += 1
        break
      case '--provider':
        invocation.provider = parseProvider(requiredValue(arg, value))
        index += 1
        break
      case '--reasoning-effort':
        invocation.reasoningEffort = requiredValue(arg, value)
        index += 1
        break
      case '--resume':
        if (value !== undefined && !value.startsWith('--')) {
          invocation.resume = value
          index += 1
        } else {
          invocation.resume = true
        }
        break
      case '--broker-control-socket':
        invocation.brokerControlSocket = requiredValue(arg, value)
        index += 1
        break
      default:
        throw new Error(`Unknown agent-harness foreground option: ${arg}`)
    }
  }
  if (invocation.agentId.length === 0)
    throw new Error('agent-harness foreground modes require --agent-id')
  if (positional.length > 1)
    throw new Error('agent-harness foreground modes accept at most one prompt')
  if (positional[0] !== undefined) invocation.prompt = positional[0]
  return invocation
}

function requiredValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function parseGeneration(value: string): number {
  const generation = Number(value)
  if (!Number.isInteger(generation) || generation < 0)
    throw new Error('--generation requires a non-negative integer')
  return generation
}

function parseProvider(value: string): 'anthropic' | 'openai' {
  if (value !== 'anthropic' && value !== 'openai')
    throw new Error('--provider must be anthropic or openai')
  return value
}
