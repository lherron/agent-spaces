/**
 * Pi SDK runner for Agent Spaces
 */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type ExtensionApi,
  buildHookExtension,
  collectBundleSpaceIds,
  loadBundleManifest,
} from '../../pi-session/hook-runtime.js'
import {
  loadManifestContextFiles,
  loadManifestExtensionFactories,
} from '../../pi-session/manifest-loading.js'
import { resolveSdkEntry } from '../../pi-session/sdk-entry.js'

interface RunnerArgs {
  bundle: string
  project: string
  cwd: string
  mode: 'interactive' | 'print'
  prompt?: string | undefined
  model?: string | undefined
  /** True when --resume was passed (with or without a session-path value). */
  resume: boolean
  /** Session-file path to resume from; undefined means "continue most recent". */
  resumePath?: string | undefined
  yolo: boolean
  noExtensions: boolean
  noSkills: boolean
  sdkRoot?: string | undefined
  verbose: boolean
}

type ExtensionFactory = (pi: ExtensionApi) => void | Promise<void>

export function parseArgs(argv: string[]): RunnerArgs {
  const args: RunnerArgs = {
    bundle: '',
    project: '',
    cwd: process.cwd(),
    mode: 'interactive',
    resume: false,
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
      case '--resume': {
        // --resume may carry a session-file path (resume that exact session)
        // or stand alone (continue the most recent session). Only consume the
        // next token as a path when it is not itself a flag.
        args.resume = true
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('-')) {
          args.resumePath = next
          i += 1
        }
        break
      }
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
    SessionManager,
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
    const spaceIds = collectBundleSpaceIds(manifest)
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
    const loaded = await loadManifestExtensionFactories(manifest, bundleRoot)
    extensionFactories.push(...(loaded as ExtensionFactory[]))
  }

  const contextFiles = await loadManifestContextFiles(manifest, bundleRoot)

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
    sessionManager?: unknown
  } = {
    cwd: args.cwd,
    extensions: extensionFactories,
    skills: args.noSkills ? [] : skills,
    contextFiles,
  }

  // Continuation: resume via SessionManager (mirrors how PiSession resumes
  // from a sessionPath). A --resume <path> opens that exact session file;
  // a bare --resume continues the most recent session for the cwd.
  if (args.resume) {
    sessionOptions.sessionManager = args.resumePath
      ? SessionManager.open(args.resumePath)
      : SessionManager.continueRecent(args.cwd)
  }

  if (args.model) {
    // Model IDs use the project-wide slash convention: <provider>/<model>
    // (e.g. 'openai-codex/gpt-5.5'). Split on the first '/' so model names
    // containing further separators are preserved in modelId.
    const slashIndex = args.model.indexOf('/')
    const provider = slashIndex > 0 ? args.model.slice(0, slashIndex) : ''
    const modelId = slashIndex > 0 ? args.model.slice(slashIndex + 1) : ''
    if (!provider || !modelId) {
      throw new Error('Model must be specified as provider/model')
    }

    const authStorage = AuthStorage.create()
    const modelRegistry = ModelRegistry.create(authStorage)
    const model = modelRegistry.find(provider, modelId)

    if (!model) {
      throw new Error(`Model not found: ${provider}/${modelId}`)
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

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
