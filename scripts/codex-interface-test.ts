#!/usr/bin/env bun
/**
 * Codex Interface Test
 *
 * Tests the agent-spaces client library with the codex harness.
 * Similar to cp-interface-test.ts but defaults to codex harness.
 *
 * Usage:
 *   bun scripts/codex-interface-test.ts --space space:smokey@dev "What skills are available?"
 *   bun scripts/codex-interface-test.ts --target codex-test --target-dir /path "What is 2+2?"
 */
import { mkdir } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import { marked } from 'marked'
import TerminalRenderer from 'marked-terminal'

import { createAgentSpacesClient } from '../packages/agent-spaces/src/index.ts'
import type { AgentEvent, SpaceSpec } from '../packages/agent-spaces/src/types.ts'

interface ParsedArgs {
  spaces: string[]
  targetName?: string | undefined
  targetDir?: string | undefined
  aspHome?: string | undefined
  cwd?: string | undefined
  harness: string
  model?: string | undefined
  harnessSessionId?: string | undefined
  externalSessionId?: string | undefined
  externalRunId?: string | undefined
  env: Record<string, string>
  verbose: boolean
  help: boolean
  prompt?: string | undefined
  skipResume: boolean
}

function printUsage(): void {
  console.log(
    [
      'Codex Interface Test - Test agent-spaces client with codex harness',
      '',
      'Usage:',
      '  bun scripts/codex-interface-test.ts --space <space-ref> [options] [prompt]',
      '  bun scripts/codex-interface-test.ts --target <target-name> --target-dir <abs-path> [options] [prompt]',
      '',
      'Options:',
      '  --space <ref>               Space reference (e.g., space:smokey@dev)',
      '  --spaces <refs>             Comma-separated space references',
      '  --target <name>             Target name from asp-targets.toml',
      '  --target-dir <path>         Target directory (required with --target)',
      '  --asp-home <path>           ASP_HOME for materialization (default: $ASP_HOME or /tmp/asp-codex-test)',
      '  --cwd <path>                Working directory for the run (default: targetDir or cwd)',
      '  --harness <id>              Harness id (default: codex)',
      '  --model <id>                Model id (default: gpt-5.2-codex)',
      '  --harness-session-id <id>   Resume existing harness session (optional)',
      '  --external-session-id <id>  External session id (optional)',
      '  --external-run-id <id>      External run id (optional)',
      '  --env KEY=VALUE             Environment variable (repeatable)',
      '  --skip-resume               Skip the automatic resume test',
      '  --verbose                   Log full event payloads',
      '  --help                      Show this message',
      '  [prompt]                    Optional prompt as the last argument',
      '',
      'Examples:',
      '  # Test with a space reference',
      '  bun scripts/codex-interface-test.ts --space space:smokey@dev "What skills are available?"',
      '',
      '  # Test with an installed target',
      '  bun scripts/codex-interface-test.ts --target codex-test --target-dir $PWD "What is 2+2?"',
      '',
      '  # Verbose output',
      '  bun scripts/codex-interface-test.ts --space space:smokey@dev --verbose',
      '',
      'Authentication:',
      '  Codex uses OAuth. Run `codex login status` to verify you are logged in.',
      '  OAuth credentials are stored in ~/.codex/auth.json (symlinked to session homes).',
    ].join('\n')
  )
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    spaces: [],
    harness: 'codex',
    env: {},
    verbose: false,
    help: false,
    skipResume: false,
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
      case '--harness':
        args.harness = argv[i + 1] ?? ''
        if (!args.harness) throw new Error('Missing value for --harness')
        i += 1
        break
      case '--model':
        args.model = argv[i + 1]
        if (!args.model) throw new Error('Missing value for --model')
        i += 1
        break
      case '--harness-session-id':
        args.harnessSessionId = argv[i + 1]
        if (!args.harnessSessionId) throw new Error('Missing value for --harness-session-id')
        i += 1
        break
      case '--external-session-id':
        args.externalSessionId = argv[i + 1]
        if (!args.externalSessionId) throw new Error('Missing value for --external-session-id')
        i += 1
        break
      case '--external-run-id':
        args.externalRunId = argv[i + 1]
        if (!args.externalRunId) throw new Error('Missing value for --external-run-id')
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
      case '--skip-resume':
        args.skipResume = true
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

function formatEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'message':
      return `[message] ${typeof event.content === 'string' ? event.content.slice(0, 100) : '(object)'}`
    case 'tool_call':
      return `[tool_call] ${event.toolName} (${event.toolUseId})`
    case 'tool_result':
      return `[tool_result] ${event.toolName} ${event.isError ? 'ERROR' : 'OK'}`
    case 'log':
      return `[log] ${event.message}`
    case 'error':
      return `[error] ${event.message}`
    case 'status':
      return `[status] ${event.status}`
    default:
      return `[${event.type}]`
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

  // Note: Codex uses OAuth (auth.json), not OPENAI_API_KEY env var

  const spec = buildSpec(args)

  const aspHome = args.aspHome ?? process.env['ASP_HOME'] ?? '/tmp/asp-codex-test'
  await mkdir(aspHome, { recursive: true })

  const cwd =
    args.cwd ?? (spec && 'target' in spec ? spec.target.targetDir : undefined) ?? process.cwd()

  const externalSessionId = args.externalSessionId ?? `codex-session-${Date.now()}`
  const externalRunId = args.externalRunId ?? `codex-run-${Date.now()}`

  const client = createAgentSpacesClient()

  console.log('=== Codex Interface Test ===')
  console.log(`harness: ${args.harness}`)
  console.log(`aspHome: ${aspHome}`)
  console.log(`cwd: ${cwd}`)
  console.log('')

  // Describe phase
  console.log('--- describe() ---')
  const describeResult = await client.describe({
    aspHome,
    spec,
    harness: args.harness,
    ...(args.model ? { model: args.model } : {}),
    cwd,
    sessionId: args.harnessSessionId ?? externalSessionId,
  })
  console.log('skills:', describeResult.skills)
  console.log('tools:', describeResult.tools?.length ?? 0, 'tools')
  console.log('hooks:', describeResult.hooks)
  console.log('')

  // Run turn phase
  console.log('--- runTurn() ---')
  const prompt = args.prompt ?? 'What skills are available? List them briefly.'
  console.log(`prompt: "${prompt}"`)
  console.log('')

  let eventCount = 0
  const response = await client.runTurn({
    externalSessionId,
    externalRunId,
    aspHome,
    spec,
    harness: args.harness,
    ...(args.model ? { model: args.model } : {}),
    ...(args.harnessSessionId ? { harnessSessionId: args.harnessSessionId } : {}),
    cwd,
    ...(Object.keys(args.env).length > 0 ? { env: args.env } : {}),
    prompt,
    callbacks: {
      onEvent: async (event) => {
        eventCount++
        if (args.verbose) {
          console.log('event:', JSON.stringify(event, null, 2))
        } else {
          console.log(formatEvent(event))
        }
      },
    },
  })

  console.log('')
  console.log(`events received: ${eventCount}`)
  console.log(`harnessSessionId: ${response.harnessSessionId ?? '(none)'}`)
  console.log(`success: ${response.result.success}`)

  if (response.result.finalOutput) {
    console.log('\n--- finalOutput (rendered) ---')
    console.log(marked.parse(response.result.finalOutput))
  }

  if (!response.result.success) {
    console.error('\nrunTurn FAILED:', response.result.error?.message ?? 'Unknown error')
    process.exitCode = 1
    return
  }

  // Resume test (automatic unless --skip-resume)
  if (response.harnessSessionId && !args.skipResume) {
    console.log('\n--- Resume Test ---')
    console.log(`resuming with harnessSessionId: ${response.harnessSessionId}`)
    console.log('')

    let resumeEventCount = 0
    const resumeResponse = await client.runTurn({
      externalSessionId,
      externalRunId: `${externalRunId}-resume`,
      aspHome,
      spec,
      harness: args.harness,
      ...(args.model ? { model: args.model } : {}),
      harnessSessionId: response.harnessSessionId,
      cwd,
      ...(Object.keys(args.env).length > 0 ? { env: args.env } : {}),
      prompt: 'What was the last question I asked you? Answer briefly.',
      callbacks: {
        onEvent: async (event) => {
          resumeEventCount++
          if (args.verbose) {
            console.log('resume event:', JSON.stringify(event, null, 2))
          } else {
            console.log(formatEvent(event))
          }
        },
      },
    })

    console.log('')
    console.log(`resume events received: ${resumeEventCount}`)
    console.log(`resume success: ${resumeResponse.result.success}`)

    if (resumeResponse.result.finalOutput) {
      console.log('\n--- resume finalOutput (rendered) ---')
      console.log(marked.parse(resumeResponse.result.finalOutput))
    }

    if (!resumeResponse.result.success) {
      console.error(
        '\nResume test FAILED:',
        resumeResponse.result.error?.message ?? 'Unknown error'
      )
      process.exitCode = 1
      return
    }

    console.log('\n✅ Resume test PASSED - context was maintained')
  } else if (!response.harnessSessionId) {
    console.log('\n⚠️  No harnessSessionId returned, skipping resume test')
  } else {
    console.log('\n⏭️  Resume test skipped (--skip-resume)')
  }

  console.log('\n=== Test Complete ===')
}

try {
  await main()
} catch (error) {
  console.error('Test failed with error:', error)
  process.exitCode = 1
}
