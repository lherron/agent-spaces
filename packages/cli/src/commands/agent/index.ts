/**
 * asp agent - placement-driven agent execution commands.
 *
 * Handles two patterns:
 * - asp agent resolve <scope-ref> [options]   → resolve without executing
 * - asp agent <scope-ref> <mode> [prompt] [options] → execute agent
 *
 * Dispatches based on whether the first positional is "resolve".
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { validateScopeRef } from 'agent-scope'
import { type AgentEvent, createAgentSpacesClient } from 'agent-spaces'
import type { Command } from 'commander'
import { type RuntimePlacement, resolvePlacement } from 'spaces-config'
import { buildBundleRef, parseEnvFlags } from './shared.js'

const VALID_MODES = ['query', 'heartbeat', 'task', 'maintenance'] as const
type RunMode = (typeof VALID_MODES)[number]

const SDK_FRONTENDS = new Set(['agent-sdk', 'pi-sdk'])
const CLI_FRONTENDS = new Set(['claude-code', 'codex-cli'])

interface AgentCommandOptions {
  agentRoot?: string
  frontend?: string
  mode?: string
  projectRoot?: string
  cwd?: string
  hostSessionId?: string
  runId?: string
  laneRef?: string
  scaffoldFile?: string
  model?: string
  prompt?: string
  promptFile?: string
  attachment?: string[]
  continueProvider?: string
  continueKey?: string
  interaction?: string
  io?: string
  env?: string[]
  dryRun?: boolean
  printCommand?: boolean
  json?: boolean
  bundle?: string
  agentTarget?: string
  projectTarget?: string
  compose?: string[]
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

export function registerAgentCommands(program: Command): void {
  program
    .command('agent')
    .description('Placement-driven agent execution')
    .argument('<first>', 'ScopeRef or "resolve"')
    .argument('[second]', 'Mode (query/heartbeat/task/maintenance) or ScopeRef for resolve')
    .argument('[third]', 'Prompt text')
    .option('--agent-root <path>', 'Absolute path to agent root')
    .option('--frontend <frontend>', 'Frontend: agent-sdk, pi-sdk, claude-code, codex-cli')
    .option('--mode <mode>', 'Run mode (for resolve)')
    .option('--project-root <path>', 'Absolute path to project root')
    .option('--cwd <path>', 'Override working directory')
    .option('--host-session-id <id>', 'Host session ID for correlation')
    .option('--run-id <id>', 'Run ID for correlation')
    .option('--lane-ref <ref>', 'Lane reference (default: main)')
    .option('--scaffold-file <path>', 'JSON file with scaffold packets')
    .option('--model <model>', 'Model override')
    .option('--prompt <text>', 'Prompt text (alternative to positional)')
    .option('--prompt-file <path>', 'Read prompt from file')
    .option('--attachment <path>', 'Attachment path (repeatable)', collect, [])
    .option('--continue-provider <provider>', 'Continuation provider: anthropic, openai')
    .option('--continue-key <key>', 'Continuation key for resume')
    .option('--interaction <mode>', 'Interaction mode: interactive, headless')
    .option('--io <mode>', 'I/O mode: pty, pipes, inherit')
    .option('--env <KEY=VALUE>', 'Environment variable (repeatable)', collect, [])
    .option('--dry-run', 'Print invocation without spawning')
    .option('--print-command', 'Print the command that would be run')
    .option('--json', 'Output as JSON')
    .option('--bundle <kind>', 'Bundle kind: agent-default')
    .option('--agent-target <name>', 'Named target from agent-profile.toml')
    .option('--project-target <name>', 'Named target from asp-targets.toml')
    .option('--compose <ref>', 'Space ref for composition (repeatable)', collect, [])
    .action(
      async (
        first: string,
        second: string | undefined,
        third: string | undefined,
        options: AgentCommandOptions
      ) => {
        if (first === 'resolve') {
          // asp agent resolve <scope-ref> [options]
          await handleResolve(second, options)
        } else {
          // asp agent <scope-ref> <mode> [prompt] [options]
          await handleExecute(first, second, third, options)
        }
      }
    )
}

async function handleResolve(
  scopeRef: string | undefined,
  options: AgentCommandOptions
): Promise<void> {
  if (!scopeRef) throw new Error('ScopeRef is required: asp agent resolve <scope-ref>')
  if (!options.agentRoot) throw new Error('--agent-root is required')
  if (!options.mode) throw new Error('--mode is required')

  const validation = validateScopeRef(scopeRef)
  if (!validation.ok) throw new Error(`Invalid ScopeRef "${scopeRef}": ${validation.error}`)

  const placement = buildPlacement(scopeRef, options.mode, options)
  const resolved = await resolvePlacement(placement)

  if (options.json) {
    console.log(JSON.stringify({ placement, resolved }, null, 2))
  } else {
    console.log('Placement:')
    console.log(`  agentRoot: ${placement.agentRoot}`)
    console.log(`  runMode:   ${placement.runMode}`)
    console.log(`  bundle:    ${placement.bundle.kind}`)
    if (placement.projectRoot) console.log(`  projectRoot: ${placement.projectRoot}`)
    console.log('')
    console.log('Resolved Bundle:')
    console.log(`  identity:     ${resolved.bundleIdentity}`)
    console.log(`  runMode:      ${resolved.runMode}`)
    console.log(`  cwd:          ${resolved.cwd}`)
    console.log(`  instructions: ${resolved.instructions.length}`)
    console.log(`  spaces:       ${resolved.spaces.length}`)
    for (const inst of resolved.instructions) {
      console.log(`    [${inst.slot}] ${inst.ref}`)
    }
    for (const space of resolved.spaces) {
      console.log(`    ${space.ref} -> ${space.resolvedKey}`)
    }
  }
}

async function handleExecute(
  scopeRef: string,
  mode: string | undefined,
  positionalPrompt: string | undefined,
  options: AgentCommandOptions
): Promise<void> {
  if (!options.agentRoot) throw new Error('--agent-root is required')
  if (!options.frontend) throw new Error('--frontend is required')
  if (!mode) throw new Error('Mode is required: query, heartbeat, task, maintenance')

  const validation = validateScopeRef(scopeRef)
  if (!validation.ok) throw new Error(`Invalid ScopeRef "${scopeRef}": ${validation.error}`)

  if (!VALID_MODES.includes(mode as RunMode)) {
    throw new Error(`Invalid mode "${mode}". Must be one of: ${VALID_MODES.join(', ')}`)
  }
  const runMode = mode as RunMode
  const frontend: string = options.frontend

  if (!SDK_FRONTENDS.has(frontend) && !CLI_FRONTENDS.has(frontend)) {
    throw new Error(
      `Invalid frontend "${frontend}". Must be one of: agent-sdk, pi-sdk, claude-code, codex-cli`
    )
  }

  // Resolve prompt
  const prompt = resolvePrompt(positionalPrompt, options)

  if ((runMode === 'query' || runMode === 'task') && !prompt) {
    throw new Error(
      `Prompt required: ${runMode} mode needs a prompt (positional, --prompt, or --prompt-file)`
    )
  }

  const placement = buildPlacement(scopeRef, runMode, options)
  const continuation =
    options.continueProvider && options.continueKey
      ? { provider: options.continueProvider as 'anthropic' | 'openai', key: options.continueKey }
      : undefined
  const envVars = parseEnvFlags(options.env)

  if (CLI_FRONTENDS.has(frontend)) {
    const client = createAgentSpacesClient()
    const provider = frontend === 'claude-code' ? 'anthropic' : 'openai'
    const response = await client.buildProcessInvocationSpec({
      placement,
      provider: provider as 'anthropic' | 'openai',
      frontend: frontend as 'claude-code' | 'codex-cli',
      model: options.model,
      interactionMode: (options.interaction ?? 'headless') as 'interactive' | 'headless',
      ioMode: (options.io ?? 'pipes') as 'pty' | 'pipes' | 'inherit',
      continuation,
      env: envVars,
      cpSessionId: '',
      aspHome: '',
      spec: { spaces: [] },
      cwd: '',
    } as Parameters<typeof client.buildProcessInvocationSpec>[0])

    if (options.dryRun || options.printCommand) {
      if (options.json) {
        console.log(
          JSON.stringify({ spec: response.spec, resolvedBundle: response.resolvedBundle }, null, 2)
        )
      } else {
        if (options.printCommand) {
          console.log(response.spec.displayCommand ?? response.spec.argv.join(' '))
        }
        if (options.dryRun) {
          console.log('Dry run — would execute:')
          console.log(`  argv: ${JSON.stringify(response.spec.argv)}`)
          console.log(`  cwd:  ${response.spec.cwd}`)
          if (response.resolvedBundle) {
            console.log('Resolved Bundle:')
            console.log(`  identity: ${response.resolvedBundle.bundleIdentity}`)
          }
        }
      }
      return
    }

    const [command, ...args] = response.spec.argv
    if (!command) throw new Error('Empty argv')
    const child = spawn(command, args, {
      cwd: response.spec.cwd,
      env: { ...process.env, ...response.spec.env },
      stdio: response.spec.ioMode === 'pty' ? 'inherit' : 'pipe',
    })
    if (child.stdout) child.stdout.pipe(process.stdout)
    if (child.stderr) child.stderr.pipe(process.stderr)
    const exitCode = await new Promise<number>((r) => child.on('close', (c) => r(c ?? 1)))
    process.exit(exitCode)
  } else {
    const client = createAgentSpacesClient()
    const response = await client.runTurnNonInteractive({
      placement,
      frontend: frontend as 'agent-sdk' | 'pi-sdk',
      model: options.model,
      continuation,
      env: envVars,
      prompt: prompt ?? '',
      attachments: options.attachment,
      callbacks: {
        onEvent: (event: AgentEvent) => {
          if (options.json) console.log(JSON.stringify(event))
          else if (event.type === 'message' && event.role === 'assistant')
            process.stdout.write(event.content)
          else if (event.type === 'message_delta') process.stdout.write(event.delta)
        },
      },
      cpSessionId: '',
      runId: options.runId ?? '',
      aspHome: '',
      spec: { spaces: [] },
      cwd: '',
    } as Parameters<typeof client.runTurnNonInteractive>[0])
    if (!response.result.success) process.exit(1)
  }
}

function resolvePrompt(
  positional: string | undefined,
  options: AgentCommandOptions
): string | undefined {
  const sources = [positional, options.prompt, options.promptFile ? 'file' : undefined].filter(
    Boolean
  )
  if (sources.length > 1)
    throw new Error('Positional prompt, --prompt, and --prompt-file are mutually exclusive')
  if (positional) return positional
  if (options.prompt) return options.prompt
  if (options.promptFile) return readFileSync(options.promptFile, 'utf8')
  return undefined
}

function buildPlacement(
  scopeRef: string,
  runMode: string,
  options: AgentCommandOptions
): RuntimePlacement {
  const bundle = buildBundleRef(options)
  const scaffoldPackets = options.scaffoldFile
    ? JSON.parse(readFileSync(options.scaffoldFile, 'utf8'))
    : undefined
  const correlation =
    options.hostSessionId || options.laneRef
      ? {
          hostSessionId: options.hostSessionId,
          runId: options.runId,
          sessionRef: { scopeRef, laneRef: options.laneRef ?? 'main' },
        }
      : undefined
  return {
    agentRoot: options.agentRoot as string,
    projectRoot: options.projectRoot,
    cwd: options.cwd,
    runMode: runMode as RuntimePlacement['runMode'],
    bundle,
    scaffoldPackets,
    correlation,
  }
}
