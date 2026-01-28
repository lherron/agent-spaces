#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import { marked } from 'marked'
import TerminalRenderer from 'marked-terminal'

import { createAgentSpacesClient } from '../packages/agent-spaces/src/index.ts'
import type {
  AgentEvent,
  HarnessContinuationRef,
  HarnessFrontend,
  SpaceSpec,
} from '../packages/agent-spaces/src/types.ts'

interface ParsedArgs {
  spaces: string[]
  targetName?: string | undefined
  targetDir?: string | undefined
  aspHome?: string | undefined
  cwd?: string | undefined
  frontend: HarnessFrontend
  model?: string | undefined
  continuationKey?: string | undefined
  cpSessionId?: string | undefined
  runId?: string | undefined
  env: Record<string, string>
  verbose: boolean
  help: boolean
  prompt?: string | undefined
}

function printUsage(): void {
  console.log(
    [
      'Usage:',
      '  bun scripts/cp-interface-test.ts --space <space-ref> [--space <space-ref> ...]',
      '  bun scripts/cp-interface-test.ts --target <target-name> --target-dir <abs-path>',
      '',
      'Options:',
      '  --asp-home <path>           ASP_HOME for materialization (default: $ASP_HOME or /tmp/asp-test)',
      '  --cwd <path>                Working directory for the run (default: targetDir or cwd)',
      '  --frontend <id>             Frontend id (default: agent-sdk)',
      '  --model <id>                Model id (optional)',
      '  --continuation-key <key>    Resume with continuation key (optional)',
      '  --cp-session-id <id>        CP session id (optional)',
      '  --run-id <id>               Run id (optional)',
      '  --env KEY=VALUE             Environment variable (repeatable)',
      '  --verbose                   Log full event payloads',
      '  --help                      Show this message',
      '  [prompt]                    Optional prompt as the last argument',
      '',
      'Example:',
      '  ASP_HOME=/tmp/asp-test bun scripts/cp-interface-test.ts --space space:base@dev',
      '  bun scripts/cp-interface-test.ts --target default --target-dir /abs/path "List skills"',
    ].join('\n')
  )
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    spaces: [],
    frontend: 'agent-sdk',
    env: {},
    verbose: false,
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
      case '--space': {
        const value = argv[i + 1]
        if (!value) throw new Error('Missing value for --space')
        args.spaces.push(value)
        i += 1
        break
      }
      case '--spaces': {
        const value = argv[i + 1]
        if (!value) throw new Error('Missing value for --spaces')
        args.spaces.push(
          ...value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        )
        i += 1
        break
      }
      case '--target':
        args.targetName = argv[i + 1]
        if (!args.targetName) throw new Error('Missing value for --target')
        i += 1
        break
      case '--target-dir':
        args.targetDir = argv[i + 1]
        if (!args.targetDir) throw new Error('Missing value for --target-dir')
        i += 1
        break
      case '--asp-home':
        args.aspHome = argv[i + 1]
        if (!args.aspHome) throw new Error('Missing value for --asp-home')
        i += 1
        break
      case '--cwd':
        args.cwd = argv[i + 1]
        if (!args.cwd) throw new Error('Missing value for --cwd')
        i += 1
        break
      case '--frontend':
        args.frontend = (argv[i + 1] ?? '') as HarnessFrontend
        if (!args.frontend) throw new Error('Missing value for --frontend')
        i += 1
        break
      case '--model':
        args.model = argv[i + 1]
        if (!args.model) throw new Error('Missing value for --model')
        i += 1
        break
      case '--continuation-key':
        args.continuationKey = argv[i + 1]
        if (!args.continuationKey) throw new Error('Missing value for --continuation-key')
        i += 1
        break
      case '--cp-session-id':
        args.cpSessionId = argv[i + 1]
        if (!args.cpSessionId) throw new Error('Missing value for --cp-session-id')
        i += 1
        break
      case '--run-id':
        args.runId = argv[i + 1]
        if (!args.runId) throw new Error('Missing value for --run-id')
        i += 1
        break
      case '--env': {
        const value = argv[i + 1]
        if (!value) throw new Error('Missing value for --env')
        const separator = value.indexOf('=')
        if (separator <= 0) throw new Error(`Invalid --env value (expected KEY=VALUE): ${value}`)
        const key = value.slice(0, separator)
        const envValue = value.slice(separator + 1)
        args.env[key] = envValue
        i += 1
        break
      }
      case '--verbose':
        args.verbose = true
        break
      default:
        if (!arg.startsWith('--') && i === argv.length - 1) {
          args.prompt = arg
          break
        }
        if (arg.startsWith('--space=')) {
          const value = arg.slice('--space='.length)
          if (!value) throw new Error('Missing value for --space')
          args.spaces.push(value)
          break
        }
        if (arg.startsWith('--env=')) {
          const value = arg.slice('--env='.length)
          if (!value) throw new Error('Missing value for --env')
          const separator = value.indexOf('=')
          if (separator <= 0) throw new Error(`Invalid --env value (expected KEY=VALUE): ${value}`)
          const key = value.slice(0, separator)
          const envValue = value.slice(separator + 1)
          args.env[key] = envValue
          break
        }
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return args
}

function buildSpec(args: ParsedArgs): SpaceSpec {
  const hasSpaces = args.spaces.length > 0
  const hasTarget = Boolean(args.targetName || args.targetDir)

  if (hasSpaces && hasTarget) {
    throw new Error('Provide either --space/--spaces or --target/--target-dir, not both')
  }
  if (!hasSpaces && !hasTarget) {
    throw new Error('Missing spec. Provide --space/--spaces or --target/--target-dir')
  }

  if (hasSpaces) {
    return { spaces: args.spaces }
  }

  if (!args.targetName || !args.targetDir) {
    throw new Error('Both --target and --target-dir are required for target specs')
  }

  const resolvedDir = isAbsolute(args.targetDir) ? args.targetDir : resolve(args.targetDir)
  if (!isAbsolute(resolvedDir)) {
    throw new Error(`targetDir must be absolute: ${args.targetDir}`)
  }

  return { target: { targetName: args.targetName, targetDir: resolvedDir } }
}

function extractHookPayload(event: AgentEvent): unknown | undefined {
  if (event.type === 'log' && event.fields) return event.fields
  if (event.type === 'tool_call') {
    return {
      hook_event_name: 'PreToolUse',
      tool_name: event.toolName,
      tool_use_id: event.toolUseId,
      tool_input: event.input,
    }
  }
  if (event.type === 'tool_result') {
    return {
      hook_event_name: 'PostToolUse',
      tool_name: event.toolName,
      tool_use_id: event.toolUseId,
      tool_output: event.output,
      is_error: event.isError,
    }
  }
  if (event.type === 'message' && typeof event.content === 'string') {
    if (event.content.startsWith('Hook ')) {
      return { message: event.content }
    }
  }
  return undefined
}

/** Derive the provider domain from the frontend for building continuation refs. */
function frontendProvider(frontend: HarnessFrontend): 'anthropic' | 'openai' {
  switch (frontend) {
    case 'agent-sdk':
    case 'claude-code':
      return 'anthropic'
    case 'pi-sdk':
    case 'codex-cli':
      return 'openai'
  }
}

async function main(): Promise<void> {
  marked.setOptions({
    renderer: new TerminalRenderer(),
  })

  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return
  }
  const spec = buildSpec(args)

  const aspHome = args.aspHome ?? process.env['ASP_HOME'] ?? '/tmp/asp-test'
  await mkdir(aspHome, { recursive: true })

  const cwd =
    args.cwd ?? (spec && 'target' in spec ? spec.target.targetDir : undefined) ?? process.cwd()

  const cpSessionId = args.cpSessionId ?? `cp-session-${Date.now()}`
  const runId = args.runId ?? `cp-run-${Date.now()}`

  // Build continuation ref from key if provided
  const continuation: HarnessContinuationRef | undefined = args.continuationKey
    ? { provider: frontendProvider(args.frontend), key: args.continuationKey }
    : undefined

  const client = createAgentSpacesClient()

  const describeResult = await client.describe({
    aspHome,
    spec,
    frontend: args.frontend,
    ...(args.model ? { model: args.model } : {}),
    cwd,
    cpSessionId,
  })
  console.log('describe.hooks:', describeResult.hooks)
  console.log('describe.skills:', describeResult.skills)
  console.log('describe.tools:', describeResult.tools)
  if (describeResult.agentSdkSessionParams) {
    console.log('describe.agentSdkSessionParams:')
    console.dir(describeResult.agentSdkSessionParams, { depth: null })
  }

  console.log('starting runTurnNonInteractive...')
  const prompt = args.prompt ?? 'What skills are available?'
  const response = await client.runTurnNonInteractive({
    cpSessionId,
    runId,
    aspHome,
    spec,
    frontend: args.frontend as 'agent-sdk' | 'pi-sdk',
    ...(args.model ? { model: args.model } : {}),
    ...(continuation ? { continuation } : {}),
    cwd,
    ...(Object.keys(args.env).length > 0 ? { env: args.env } : {}),
    prompt,
    callbacks: {
      onEvent: async (event) => {
        if (args.verbose) {
          console.log('event:', JSON.stringify(event, null, 2))
        }

        const hookPayload = extractHookPayload(event)
        if (hookPayload !== undefined) {
          console.log('hook payload:', JSON.stringify(hookPayload, null, 2))
        }
      },
    },
  })

  console.log('runTurnNonInteractive response:', JSON.stringify(response, null, 2))
  if (response.result.finalOutput) {
    console.log('\nrunTurnNonInteractive finalOutput (rendered markdown):')
    console.log(marked.parse(response.result.finalOutput))
  }
  if (!response.result.success) {
    console.error(
      'runTurnNonInteractive failed:',
      response.result.error?.message ?? 'Unknown error'
    )
    process.exitCode = 1
    return
  }

  // Test resume: make a second call asking the model to repeat the last question
  if (response.continuation?.key) {
    console.log('\n--- Testing resume with continuation key:', response.continuation.key, '---\n')
    const resumeResponse = await client.runTurnNonInteractive({
      cpSessionId,
      runId: `${runId}-resume`,
      aspHome,
      spec,
      frontend: args.frontend as 'agent-sdk' | 'pi-sdk',
      ...(args.model ? { model: args.model } : {}),
      continuation: response.continuation,
      cwd,
      ...(Object.keys(args.env).length > 0 ? { env: args.env } : {}),
      prompt: 'What was the last question I asked you?',
      callbacks: {
        onEvent: async (event) => {
          if (args.verbose) {
            console.log('resume event:', JSON.stringify(event, null, 2))
          }

          const hookPayload = extractHookPayload(event)
          if (hookPayload !== undefined) {
            console.log('resume hook payload:', JSON.stringify(hookPayload, null, 2))
          }
        },
      },
    })

    console.log('resume runTurnNonInteractive response:', JSON.stringify(resumeResponse, null, 2))
    if (resumeResponse.result.finalOutput) {
      console.log('\nresume runTurnNonInteractive finalOutput (rendered markdown):')
      console.log(marked.parse(resumeResponse.result.finalOutput))
    }
    if (!resumeResponse.result.success) {
      console.error(
        'resume runTurnNonInteractive failed:',
        resumeResponse.result.error?.message ?? 'Unknown error'
      )
      process.exitCode = 1
    }
  } else {
    console.log('\nNo continuation key returned, skipping resume test')
  }
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
