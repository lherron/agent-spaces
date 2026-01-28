#!/usr/bin/env bun
/**
 * Codex Interface Test
 *
 * Tests the agent-spaces client library with the codex-cli frontend.
 * Codex is a CLI-only frontend, so this uses buildProcessInvocationSpec
 * to produce a ProcessInvocationSpec and optionally spawns the process.
 *
 * Usage:
 *   bun scripts/codex-interface-test.ts --space space:smokey@dev
 *   bun scripts/codex-interface-test.ts --target codex-test --target-dir /path
 *   bun scripts/codex-interface-test.ts --space space:smokey@dev --spawn "What is 2+2?"
 */
import { mkdir } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import { createAgentSpacesClient } from '../packages/agent-spaces/src/index.ts'
import type {
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
  frontend: 'claude-code' | 'codex-cli'
  model?: string | undefined
  continuationKey?: string | undefined
  cpSessionId?: string | undefined
  interactionMode: 'interactive' | 'headless'
  ioMode: 'pty' | 'pipes' | 'inherit'
  env: Record<string, string>
  verbose: boolean
  help: boolean
  spawn: boolean
  prompt?: string | undefined
}

function printUsage(): void {
  console.log(
    [
      'Codex Interface Test - Test agent-spaces buildProcessInvocationSpec with CLI frontends',
      '',
      'Usage:',
      '  bun scripts/codex-interface-test.ts --space <space-ref> [options]',
      '  bun scripts/codex-interface-test.ts --target <target-name> --target-dir <abs-path> [options]',
      '',
      'Options:',
      '  --space <ref>               Space reference (e.g., space:smokey@dev)',
      '  --spaces <refs>             Comma-separated space references',
      '  --target <name>             Target name from asp-targets.toml',
      '  --target-dir <path>         Target directory (required with --target)',
      '  --asp-home <path>           ASP_HOME for materialization (default: $ASP_HOME or /tmp/asp-codex-test)',
      '  --cwd <path>                Working directory for the run (default: targetDir or cwd)',
      '  --frontend <id>             Frontend id: codex-cli or claude-code (default: codex-cli)',
      '  --model <id>                Model id (default: gpt-5.2-codex for codex-cli)',
      '  --continuation-key <key>    Resume with continuation key (optional)',
      '  --cp-session-id <id>        CP session id (optional)',
      '  --interaction-mode <mode>   interactive or headless (default: headless)',
      '  --io-mode <mode>            pty, pipes, or inherit (default: pipes)',
      '  --env KEY=VALUE             Environment variable (repeatable)',
      '  --spawn                     Actually spawn the process (default: just display spec)',
      '  --verbose                   Log full payloads',
      '  --help                      Show this message',
      '  [prompt]                    Optional prompt as the last positional argument',
      '',
      'Examples:',
      '  # Build invocation spec (display only)',
      '  bun scripts/codex-interface-test.ts --space space:smokey@dev',
      '',
      '  # Build and spawn the process',
      '  bun scripts/codex-interface-test.ts --space space:smokey@dev --spawn "What is 2+2?"',
      '',
      '  # Use claude-code frontend',
      '  bun scripts/codex-interface-test.ts --space space:base@dev --frontend claude-code',
      '',
      'Authentication:',
      '  Codex uses OAuth. Run `codex login status` to verify you are logged in.',
    ].join('\n')
  )
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    spaces: [],
    frontend: 'codex-cli',
    interactionMode: 'headless',
    ioMode: 'pipes',
    env: {},
    verbose: false,
    help: false,
    spawn: false,
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
        args.frontend = (argv[i + 1] ?? '') as 'claude-code' | 'codex-cli'
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
      case '--interaction-mode':
        args.interactionMode = (argv[i + 1] ?? '') as 'interactive' | 'headless'
        if (!args.interactionMode) throw new Error('Missing value for --interaction-mode')
        i += 1
        break
      case '--io-mode':
        args.ioMode = (argv[i + 1] ?? '') as 'pty' | 'pipes' | 'inherit'
        if (!args.ioMode) throw new Error('Missing value for --io-mode')
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
      case '--spawn':
        args.spawn = true
        break
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

/** Derive the provider domain from the CLI frontend. */
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
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return
  }

  const spec = buildSpec(args)
  const provider = frontendProvider(args.frontend)

  const aspHome = args.aspHome ?? process.env['ASP_HOME'] ?? '/tmp/asp-codex-test'
  await mkdir(aspHome, { recursive: true })

  const cwd =
    args.cwd ?? (spec && 'target' in spec ? spec.target.targetDir : undefined) ?? process.cwd()

  const cpSessionId = args.cpSessionId ?? `codex-session-${Date.now()}`

  // Build continuation ref from key if provided
  const continuation: HarnessContinuationRef | undefined = args.continuationKey
    ? { provider, key: args.continuationKey }
    : undefined

  const client = createAgentSpacesClient()

  console.log('=== Codex Interface Test (CLI Frontend) ===')
  console.log(`frontend: ${args.frontend}`)
  console.log(`provider: ${provider}`)
  console.log(`aspHome: ${aspHome}`)
  console.log(`cwd: ${cwd}`)
  console.log('')

  // Describe phase
  console.log('--- describe() ---')
  const describeResult = await client.describe({
    aspHome,
    spec,
    frontend: args.frontend,
    ...(args.model ? { model: args.model } : {}),
    cwd,
    cpSessionId,
  })
  console.log('skills:', describeResult.skills)
  console.log('tools:', describeResult.tools?.length ?? 0, 'tools')
  console.log('hooks:', describeResult.hooks)
  console.log('')

  // Build invocation spec
  console.log('--- buildProcessInvocationSpec() ---')
  const invocationResult = await client.buildProcessInvocationSpec({
    cpSessionId,
    aspHome,
    spec,
    provider,
    frontend: args.frontend,
    ...(args.model ? { model: args.model } : {}),
    interactionMode: args.interactionMode,
    ioMode: args.ioMode,
    ...(continuation ? { continuation } : {}),
    cwd,
    ...(Object.keys(args.env).length > 0 ? { env: args.env } : {}),
  })

  const invocationSpec = invocationResult.spec
  console.log('provider:', invocationSpec.provider)
  console.log('frontend:', invocationSpec.frontend)
  console.log('interactionMode:', invocationSpec.interactionMode)
  console.log('ioMode:', invocationSpec.ioMode)
  console.log('cwd:', invocationSpec.cwd)
  console.log('argv:', invocationSpec.argv)
  if (invocationSpec.displayCommand) {
    console.log('displayCommand:', invocationSpec.displayCommand)
  }
  if (invocationSpec.continuation) {
    console.log('continuation:', JSON.stringify(invocationSpec.continuation))
  }
  if (invocationResult.warnings && invocationResult.warnings.length > 0) {
    console.log('warnings:', invocationResult.warnings)
  }
  if (args.verbose) {
    console.log('\nFull env:', JSON.stringify(invocationSpec.env, null, 2))
  } else {
    const envKeys = Object.keys(invocationSpec.env)
    console.log(`env: ${envKeys.length} keys [${envKeys.join(', ')}]`)
  }
  console.log('')

  // Optionally spawn the process
  if (args.spawn) {
    console.log('--- Spawning process ---')
    const [command, ...spawnArgs] = invocationSpec.argv
    if (!command) {
      console.error('No command in argv')
      process.exitCode = 1
      return
    }

    // If a prompt was provided, pass it via stdin for headless mode
    const proc = Bun.spawn([command, ...spawnArgs], {
      cwd: invocationSpec.cwd,
      env: { ...process.env, ...invocationSpec.env },
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: args.prompt ? new Response(args.prompt).body : 'inherit',
    })

    const exitCode = await proc.exited
    console.log(`\nProcess exited with code: ${exitCode}`)
    if (exitCode !== 0) {
      process.exitCode = 1
    }
  } else {
    console.log('Spec built successfully. Use --spawn to actually run the process.')
    if (invocationSpec.displayCommand) {
      console.log(`\nTo run manually:\n  ${invocationSpec.displayCommand}`)
    }
  }

  console.log('\n=== Test Complete ===')
}

try {
  await main()
} catch (error) {
  console.error('Test failed with error:', error)
  process.exitCode = 1
}
