/**
 * asp agent - placement-driven agent execution commands.
 *
 * Usage: asp agent <scope> <mode> [prompt] [options]
 *
 * Modes: query, heartbeat, task, maintenance, resolve
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseScopeRef, resolveScopeInput } from 'agent-scope'
import { type AgentEvent, createAgentSpacesClient } from 'agent-spaces'
import type { Command } from 'commander'
import {
  type RuntimePlacement,
  type TargetDefinition,
  buildRuntimeBundleRef,
  mergeAgentWithProjectTarget,
  parseAgentProfile,
  parseTargetsToml,
  resolveAgentPlacementPaths,
  resolveAgentPrimingPrompt,
  normalizeHarnessFrontend as resolveHarnessFrontendName,
  resolveHarnessProvider,
  resolvePlacement,
} from 'spaces-config'
import { parseEnvFlags } from './shared.js'

const VALID_MODES = ['query', 'heartbeat', 'task', 'maintenance', 'resolve'] as const
type RunMode = (typeof VALID_MODES)[number]
type ExecuteMode = Exclude<RunMode, 'resolve'>

/** Map display names and aliases to internal HarnessId values */
function normalizeHarness(input: string): { frontend: string; provider: 'anthropic' | 'openai' } {
  const frontend = resolveHarnessFrontendName(input)
  const provider = resolveHarnessProvider(input)
  if (!frontend || !provider) {
    throw new Error(
      `Invalid harness "${input}". Must be one of: claude-code, claude, codex-cli, codex, agent-sdk, claude-agent-sdk, pi-sdk`
    )
  }
  return { frontend, provider }
}

function normalizeConfiguredHarness(input: string | undefined): string | undefined {
  return resolveHarnessFrontendName(input)
}

function loadProjectTarget(
  projectRoot: string | undefined,
  targetName: string
): TargetDefinition | undefined {
  if (!projectRoot) {
    return undefined
  }

  const targetsPath = join(projectRoot, 'asp-targets.toml')
  if (!existsSync(targetsPath)) {
    return undefined
  }

  const parsed = parseTargetsToml(readFileSync(targetsPath, 'utf8'), targetsPath)
  return parsed.targets[targetName]
}

function loadAgentProfile(agentRoot: string): ReturnType<typeof parseAgentProfile> | undefined {
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) {
    return undefined
  }

  const source = readFileSync(profilePath, 'utf8').replace(
    /^(\s*)schema_version(\s*=)/m,
    '$1schemaVersion$2'
  )
  return parseAgentProfile(source, profilePath)
}

function resolveHarnessOption(
  scopeRef: string,
  runMode: ExecuteMode,
  options: AgentCommandOptions
): string {
  const explicitHarness = normalizeConfiguredHarness(options.harness)
  if (explicitHarness) {
    return explicitHarness
  }

  if (!options.agentRoot) {
    return 'claude-code'
  }

  const bundle = buildRuntimeBundleRef({
    ...options,
    agentName: parseScopeRef(scopeRef).agentId,
    agentRoot: options.agentRoot,
    projectRoot: options.projectRoot,
  })

  if (bundle.kind === 'compose') {
    return 'claude-code'
  }

  if (bundle.kind === 'project-target') {
    return (
      normalizeConfiguredHarness(loadProjectTarget(bundle.projectRoot, bundle.target)?.harness) ??
      'claude-code'
    )
  }

  const profile = loadAgentProfile(options.agentRoot)
  if (!profile) {
    return 'claude-code'
  }

  if (bundle.kind === 'agent-project') {
    const primingPrompt = resolveAgentPrimingPrompt(profile, options.agentRoot)
    const effective = mergeAgentWithProjectTarget(
      {
        ...profile,
        ...(primingPrompt !== undefined ? { priming_prompt: primingPrompt } : {}),
      },
      loadProjectTarget(bundle.projectRoot, bundle.agentName),
      runMode
    )
    return normalizeConfiguredHarness(effective.harness) ?? 'claude-code'
  }

  return normalizeConfiguredHarness(profile.identity?.harness) ?? 'claude-code'
}

interface AgentCommandOptions {
  agentRoot?: string
  harness?: string
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
  yolo?: boolean
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
    .argument('<scope>', 'Scope (alice@demo:t1 or agent:alice:project:demo)')
    .argument('<mode>', 'Mode: query, heartbeat, task, maintenance, resolve')
    .argument('[prompt]', 'Prompt text')
    .option('--agent-root <path>', 'Absolute path to agent root')
    .option(
      '--harness <harness>',
      'Harness: claude-code, codex-cli, agent-sdk, pi-sdk (also accepts: claude, codex, claude-agent-sdk)'
    )
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
    .option('--yolo', 'Skip all permission prompts (--dangerously-skip-permissions)')
    .option('--print-command', 'Print the command that would be run')
    .option('--json', 'Output as JSON')
    .option('--bundle <kind>', 'Bundle kind: agent-default')
    .option('--agent-target <name>', 'Named target from agent-profile.toml')
    .option('--project-target <name>', 'Named target from asp-targets.toml')
    .option('--compose <ref>', 'Space ref for composition (repeatable)', collect, [])
    .action(
      async (
        scope: string,
        mode: string,
        prompt: string | undefined,
        options: AgentCommandOptions
      ) => {
        const { parsed, scopeRef: canonicalRef, laneId } = resolveScopeInput(scope, options.laneRef)
        options.laneRef = laneId

        const paths = resolveAgentPlacementPaths({
          agentId: parsed.agentId,
          projectId: parsed.projectId,
          agentRoot: options.agentRoot,
          projectRoot: options.projectRoot,
        })
        if (paths.agentRoot) {
          options.agentRoot = paths.agentRoot
        }
        if (paths.projectRoot) {
          options.projectRoot = paths.projectRoot
        }

        if (mode === 'resolve') {
          await handleResolve(canonicalRef, options)
        } else {
          await handleExecute(canonicalRef, mode, prompt, options)
        }
      }
    )
}

async function handleResolve(scopeRef: string, options: AgentCommandOptions): Promise<void> {
  if (!options.agentRoot) {
    throw new Error(
      '--agent-root is required (or set ASP_AGENTS_ROOT env var / agents-root in $ASP_HOME/config.toml)'
    )
  }

  const { scopeRef: canonicalRef, laneRef } = resolveScopeInput(scopeRef, options.laneRef)
  const placement = buildPlacement(canonicalRef, 'resolve', options, laneRef)
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
  mode: string,
  positionalPrompt: string | undefined,
  options: AgentCommandOptions
): Promise<void> {
  if (!options.agentRoot) {
    throw new Error(
      '--agent-root is required (or set ASP_AGENTS_ROOT env var / agents-root in $ASP_HOME/config.toml)'
    )
  }

  const { scopeRef: canonicalRef, laneId } = resolveScopeInput(scopeRef, options.laneRef)

  if (!VALID_MODES.includes(mode as RunMode)) {
    throw new Error(`Invalid mode "${mode}". Must be one of: ${VALID_MODES.join(', ')}`)
  }
  if (mode === 'resolve') {
    throw new Error('resolve mode must be handled by handleResolve')
  }
  const runMode = mode as ExecuteMode
  const harness = resolveHarnessOption(canonicalRef, runMode, options)
  const { frontend, provider } = normalizeHarness(harness)

  // Resolve prompt
  const prompt = resolvePrompt(positionalPrompt, options)

  if ((runMode === 'query' || runMode === 'task') && !prompt) {
    throw new Error(
      `Prompt required: ${runMode} mode needs a prompt (positional, --prompt, or --prompt-file)`
    )
  }

  const placement = buildPlacement(canonicalRef, runMode, options, laneId)
  const continuation =
    options.continueProvider && options.continueKey
      ? { provider: options.continueProvider as 'anthropic' | 'openai', key: options.continueKey }
      : undefined
  const envVars = parseEnvFlags(options.env)

  if (frontend === 'claude-code' || frontend === 'codex-cli') {
    const client = createAgentSpacesClient()
    const response = await client.buildProcessInvocationSpec({
      placement,
      provider,
      frontend,
      model: options.model,
      interactionMode: (options.interaction ?? 'headless') as 'interactive' | 'headless',
      ioMode: (options.io ?? 'pipes') as 'pty' | 'pipes' | 'inherit',
      continuation,
      env: envVars,
      prompt,
      yolo: options.yolo,
      hostSessionId: options.hostSessionId || `cli-${Date.now()}`,
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
    const stdinMode =
      response.spec.ioMode === 'pty'
        ? 'inherit'
        : response.spec.interactionMode === 'headless'
          ? 'ignore'
          : 'pipe'
    const child = spawn(command, args, {
      cwd: response.spec.cwd,
      env: { ...process.env, ...response.spec.env },
      stdio: [stdinMode, response.spec.ioMode === 'pty' ? 'inherit' : 'pipe', 'pipe'],
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
      yolo: options.yolo,
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
      hostSessionId: options.hostSessionId || `cli-${Date.now()}`,
      runId: options.runId ?? '',
    } as unknown as Parameters<typeof client.runTurnNonInteractive>[0])
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
  options: AgentCommandOptions,
  laneRef: string
): RuntimePlacement {
  const bundle = buildRuntimeBundleRef({
    ...options,
    agentName: parseScopeRef(scopeRef).agentId,
    agentRoot: options.agentRoot,
  })
  const scaffoldPackets = options.scaffoldFile
    ? JSON.parse(readFileSync(options.scaffoldFile, 'utf8'))
    : undefined
  const correlation = {
    hostSessionId: options.hostSessionId,
    runId: options.runId,
    sessionRef: { scopeRef, laneRef },
  }
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
