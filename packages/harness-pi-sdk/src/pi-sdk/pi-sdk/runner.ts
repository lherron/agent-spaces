/**
 * Pi SDK runner for Agent Spaces
 */

import { constants, access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type ExtensionApi,
  buildHookExtension,
  loadBundleManifest,
} from '../../pi-session/hook-runtime.js'

interface RunnerArgs {
  bundle: string
  project: string
  cwd: string
  mode: 'interactive' | 'print'
  prompt?: string | undefined
  model?: string | undefined
  yolo: boolean
  noExtensions: boolean
  noSkills: boolean
  sdkRoot?: string | undefined
  verbose: boolean
}

type ExtensionFactory = (pi: ExtensionApi) => void | Promise<void>

const SDK_ENTRY_CANDIDATES = [
  'packages/coding-agent/dist/index.js',
  'packages/coding-agent/src/index.ts',
]

function parseArgs(argv: string[]): RunnerArgs {
  const args: RunnerArgs = {
    bundle: '',
    project: '',
    cwd: process.cwd(),
    mode: 'interactive',
    yolo: false,
    noExtensions: false,
    noSkills: false,
    verbose: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--bundle':
        args.bundle = argv[i + 1] ?? ''
        i += 1
        break
      case '--project':
        args.project = argv[i + 1] ?? ''
        i += 1
        break
      case '--cwd':
        args.cwd = argv[i + 1] ?? args.cwd
        i += 1
        break
      case '--mode':
        args.mode = (argv[i + 1] as RunnerArgs['mode']) ?? 'interactive'
        i += 1
        break
      case '--prompt':
        args.prompt = argv[i + 1] ?? ''
        i += 1
        break
      case '--model':
        args.model = argv[i + 1] ?? ''
        i += 1
        break
      case '--yolo':
        args.yolo = true
        break
      case '--no-extensions':
        args.noExtensions = true
        break
      case '--no-skills':
        args.noSkills = true
        break
      case '--sdk-root':
        args.sdkRoot = argv[i + 1] ?? ''
        i += 1
        break
      case '--verbose':
      case '-v':
        args.verbose = true
        break
      default:
        if (arg?.startsWith('-')) {
          throw new Error(`Unknown argument: ${arg}`)
        }
        break
    }
  }

  if (!args.bundle) {
    throw new Error('Missing required --bundle argument')
  }
  if (!args.project) {
    throw new Error('Missing required --project argument')
  }
  if (!args.mode || (args.mode !== 'interactive' && args.mode !== 'print')) {
    throw new Error('Missing or invalid --mode (interactive|print)')
  }

  return args
}

async function resolveSdkEntry(sdkRoot: string): Promise<string | null> {
  for (const candidate of SDK_ENTRY_CANDIDATES) {
    const entryPath = join(sdkRoot, candidate)
    try {
      await access(entryPath, constants.F_OK)
      return entryPath
    } catch {
      // Candidate does not exist; try the next one.
    }
  }

  return null
}

async function loadSdkModule(sdkRoot?: string | undefined) {
  if (sdkRoot) {
    const entry = await resolveSdkEntry(sdkRoot)
    if (!entry) {
      throw new Error(`Unable to find Pi SDK entry under ${sdkRoot}`)
    }
    return import(pathToFileURL(entry).href)
  }

  return import('@mariozechner/pi-coding-agent')
}

function buildVerboseLoggingExtension() {
  let turnCount = 0

  return (pi: ExtensionApi) => {
    pi.on('session_start', async () => {
      console.error('[verbose] session_start')
      return undefined
    })

    pi.on('turn_start', async (_event: Record<string, unknown>) => {
      turnCount += 1
      console.error(`[verbose] turn_start #${turnCount}`)
      return undefined
    })

    pi.on('turn_end', async (event: Record<string, unknown>) => {
      const usage = event['usage'] as { inputTokens?: number; outputTokens?: number } | undefined
      const usageStr = usage
        ? ` (input: ${usage.inputTokens ?? '?'}, output: ${usage.outputTokens ?? '?'})`
        : ''
      console.error(`[verbose] turn_end #${turnCount}${usageStr}`)
      return undefined
    })

    pi.on('tool_call', async (event: Record<string, unknown>) => {
      const toolName = event['toolName'] as string | undefined
      console.error(`[verbose] tool_call: ${toolName ?? 'unknown'}`)
      return undefined
    })

    pi.on('tool_result', async (event: Record<string, unknown>) => {
      const toolName = event['toolName'] as string | undefined
      const error = event['error'] as string | undefined
      const status = error ? `error: ${error}` : 'success'
      console.error(`[verbose] tool_result: ${toolName ?? 'unknown'} (${status})`)
      return undefined
    })

    pi.on('session_shutdown', async () => {
      console.error(`[verbose] session_shutdown (${turnCount} turns)`)
      return undefined
    })
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const bundleRoot = resolve(args.bundle)
  const manifest = await loadBundleManifest(bundleRoot)
  const sdk = await loadSdkModule(args.sdkRoot)

  const {
    AuthStorage,
    ModelRegistry,
    createAgentSession,
    loadSkills,
    InteractiveMode,
    runPrintMode,
  } = sdk

  const extensionFactories: ExtensionFactory[] = []

  // Add verbose logging extension first so it logs before other extensions
  if (args.verbose) {
    console.error('[verbose] Loading bundle:', bundleRoot)
    console.error('[verbose] Target:', manifest.targetName)
    console.error('[verbose] Extensions:', manifest.extensions.length)
    console.error('[verbose] Hooks:', manifest.hooks?.length ?? 0)
    console.error('[verbose] Context files:', manifest.contextFiles?.length ?? 0)
    extensionFactories.push(buildVerboseLoggingExtension())
  }

  const hooks = args.noExtensions ? [] : (manifest.hooks ?? [])
  if (hooks.length > 0) {
    const spaceIds = Array.from(
      new Set([
        ...manifest.extensions.map((entry) => entry.spaceId),
        ...(manifest.contextFiles ?? []).map((entry) => entry.spaceId),
      ])
    )
    extensionFactories.push(
      buildHookExtension({
        hooks,
        bundleRoot,
        targetName: manifest.targetName,
        spaceIds,
        yolo: args.yolo,
        cwd: args.cwd,
      })
    )
  }

  if (!args.noExtensions) {
    for (const extension of manifest.extensions) {
      const extensionPath = resolve(bundleRoot, extension.path)
      const module = await import(pathToFileURL(extensionPath).href)
      const factory = module.default ?? module
      if (typeof factory !== 'function') {
        throw new Error(`Extension ${extensionPath} does not export a default function`)
      }
      extensionFactories.push(factory)
    }
  }

  const contextFiles = await Promise.all(
    (manifest.contextFiles ?? []).map(async (entry) => {
      const filePath = resolve(bundleRoot, entry.path)
      const content = await readFile(filePath, 'utf-8')
      return { path: filePath, content }
    })
  )

  let skills: unknown[] = []
  if (!args.noSkills && manifest.skillsDir) {
    const { skills: discovered } = loadSkills({
      cwd: args.cwd,
      agentDir: bundleRoot,
      skillPaths: [resolve(bundleRoot, manifest.skillsDir)],
      includeDefaults: false,
    })
    skills = discovered
  }

  const sessionOptions: {
    cwd: string
    extensions: ExtensionFactory[]
    skills: unknown[]
    contextFiles: Array<{ path: string; content: string }>
    model?: unknown
    authStorage?: unknown
    modelRegistry?: unknown
  } = {
    cwd: args.cwd,
    extensions: extensionFactories,
    skills: args.noSkills ? [] : skills,
    contextFiles,
  }

  if (args.model) {
    const [provider, modelId] = args.model.split(':')
    if (!provider || !modelId) {
      throw new Error('Model must be specified as provider:model')
    }

    const authStorage = AuthStorage.create()
    const modelRegistry = ModelRegistry.create(authStorage)
    const model = modelRegistry.find(provider, modelId)

    if (!model) {
      throw new Error(`Model not found: ${provider}:${modelId}`)
    }

    sessionOptions.model = model
    sessionOptions.authStorage = authStorage
    sessionOptions.modelRegistry = modelRegistry
  }

  const { session, modelFallbackMessage } = await createAgentSession(sessionOptions)

  if (args.mode === 'interactive') {
    const mode = new InteractiveMode(session, {
      initialMessage: args.prompt,
      modelFallbackMessage,
    })
    await mode.run()
    return
  }

  await runPrintMode(session, {
    mode: 'text',
    initialMessage: args.prompt ?? '',
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
