/**
 * Pi SDK runner for Agent Spaces
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

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
}

interface PiSdkBundleExtensionEntry {
  spaceId: string
  path: string
}

interface PiSdkBundleContextEntry {
  spaceId: string
  path: string
  label?: string | undefined
}

interface PiSdkBundleHookEntry {
  event: string
  script: string
  tools?: string[] | undefined
  blocking?: boolean | undefined
}

interface PiSdkBundleManifest {
  schemaVersion: number
  harnessId: string
  targetName: string
  rootDir: string
  extensions: PiSdkBundleExtensionEntry[]
  skillsDir?: string | undefined
  contextFiles?: PiSdkBundleContextEntry[] | undefined
  hooks?: PiSdkBundleHookEntry[] | undefined
}

interface ExtensionApi {
  on: <Args extends unknown[]>(event: string, handler: (...args: Args) => unknown) => unknown
  sendMessage: (message: unknown, options?: unknown) => unknown
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
      const file = await readFile(entryPath)
      if (file.byteLength >= 0) {
        return entryPath
      }
    } catch {
      // Continue
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

async function loadBundle(bundleRoot: string): Promise<PiSdkBundleManifest> {
  const manifestPath = join(bundleRoot, 'bundle.json')
  const raw = await readFile(manifestPath, 'utf-8')
  const manifest = JSON.parse(raw) as PiSdkBundleManifest

  if (manifest.harnessId !== 'pi-sdk') {
    throw new Error(`Unexpected bundle harness: ${manifest.harnessId}`)
  }

  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported bundle schemaVersion: ${manifest.schemaVersion}`)
  }

  return manifest
}

function resolveHookScriptPath(bundleRoot: string, script: string): string {
  if (/\s/.test(script)) {
    return script
  }

  if (isAbsolute(script)) {
    return script
  }

  return resolve(bundleRoot, script)
}

async function runHookScript(
  script: string,
  payload: string,
  env: Record<string, string>,
  cwd: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const proc = spawn(script, [], {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr?.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('error', (error) => {
      reject(error)
    })

    proc.on('close', (code) => {
      resolveResult({ exitCode: code ?? 1, stdout, stderr })
    })

    if (proc.stdin) {
      proc.stdin.write(payload)
      proc.stdin.end()
    }
  })
}

function buildHookExtension(options: {
  hooks: PiSdkBundleHookEntry[]
  bundleRoot: string
  targetName: string
  spaceIds: string[]
  yolo: boolean
  cwd: string
}) {
  const { hooks, bundleRoot, targetName, spaceIds, yolo, cwd } = options
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === 'string')
  ) as Record<string, string>

  return (pi: ExtensionApi) => {
    const runHooks = async (
      hookEvent: string,
      event: Record<string, unknown>,
      ctx: { sessionManager?: { getSessionFile?: () => string | undefined } } | undefined,
      toolName?: string | undefined
    ): Promise<{ blocked: boolean; reason?: string | undefined } | undefined> => {
      const matching = hooks.filter((hook) => hook.event === hookEvent)
      for (const hook of matching) {
        if (hook.tools && toolName) {
          const normalizedTool = toolName.toLowerCase()
          const allowed = hook.tools.some((tool) => tool.toLowerCase() === normalizedTool)
          if (!allowed) {
            continue
          }
        }

        const payload = (() => {
          try {
            return JSON.stringify(event ?? {})
          } catch {
            return ''
          }
        })()

        const resolvedScript = resolveHookScriptPath(bundleRoot, hook.script)
        const toolInput = (() => {
          try {
            return JSON.stringify((event as { input?: unknown }).input ?? {})
          } catch {
            return ''
          }
        })()
        const toolResult = (() => {
          try {
            return JSON.stringify(event ?? {})
          } catch {
            return ''
          }
        })()
        const sessionId = ctx?.sessionManager?.getSessionFile?.() ?? ''
        const env: Record<string, string> = {
          ...baseEnv,
          ASP_HARNESS: 'pi-sdk',
          ASP_TARGET: targetName,
          ASP_BUNDLE_ROOT: bundleRoot,
          ASP_EVENT: hook.event,
          ASP_TOOL_NAME: toolName ?? '',
          ASP_TOOL_INPUT: toolInput,
          ASP_TOOL_RESULT: toolResult,
          ASP_SESSION_ID: sessionId,
          ASP_SPACE_IDS: spaceIds.join(','),
        }

        let result: { exitCode: number; stdout: string; stderr: string } | undefined
        try {
          result = await runHookScript(resolvedScript, payload, env, cwd)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          pi.sendMessage({
            customType: 'asp-hook',
            content: `Hook ${hook.event}: ${hook.script}\n\n[error]\n${message}`,
            display: true,
            details: { event: hook.event, script: hook.script, exitCode: 1 },
          })
          if (hook.blocking && !yolo && hookEvent === 'pre_tool_use') {
            return { blocked: true, reason: message }
          }
          continue
        }

        const outputParts = []
        if (result.stdout.trim().length > 0) {
          outputParts.push(result.stdout.trimEnd())
        }
        if (result.stderr.trim().length > 0) {
          outputParts.push(`[stderr]\n${result.stderr.trimEnd()}`)
        }

        if (outputParts.length > 0 || result.exitCode !== 0) {
          const content = `Hook ${hook.event}: ${hook.script}\n\n${
            outputParts.length > 0 ? outputParts.join('\n\n') : '(no output)'
          }`
          pi.sendMessage({
            customType: 'asp-hook',
            content,
            display: true,
            details: { event: hook.event, script: hook.script, exitCode: result.exitCode },
          })
        }

        if (hook.blocking && !yolo && hookEvent === 'pre_tool_use' && result.exitCode !== 0) {
          return {
            blocked: true,
            reason: `Hook ${hook.event} blocked tool ${toolName ?? ''}`,
          }
        }
      }

      return undefined
    }

    if (hooks.length === 0) {
      return
    }

    pi.on('tool_call', async (event: Record<string, unknown>, ctx: unknown) => {
      const result = await runHooks(
        'pre_tool_use',
        event,
        ctx as { sessionManager?: { getSessionFile?: () => string | undefined } },
        event['toolName'] as string | undefined
      )
      if (result?.blocked) {
        return { block: true, reason: result.reason }
      }
      return undefined
    })

    pi.on('tool_result', async (event: Record<string, unknown>, ctx: unknown) => {
      await runHooks(
        'post_tool_use',
        event,
        ctx as { sessionManager?: { getSessionFile?: () => string | undefined } },
        event['toolName'] as string | undefined
      )
      return undefined
    })

    pi.on('session_start', async (event: Record<string, unknown>, ctx: unknown) => {
      await runHooks(
        'session_start',
        event,
        ctx as { sessionManager?: { getSessionFile?: () => string | undefined } }
      )
      return undefined
    })

    pi.on('session_shutdown', async (event: Record<string, unknown>, ctx: unknown) => {
      await runHooks(
        'session_end',
        event,
        ctx as { sessionManager?: { getSessionFile?: () => string | undefined } }
      )
      return undefined
    })
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const bundleRoot = resolve(args.bundle)
  const manifest = await loadBundle(bundleRoot)
  const sdk = await loadSdkModule(args.sdkRoot)

  const {
    createAgentSession,
    discoverAuthStorage,
    discoverModels,
    discoverSkills,
    InteractiveMode,
    runPrintMode,
  } = sdk

  const extensionFactories: ExtensionFactory[] = []
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
    const { skills: discovered, warnings } = discoverSkills(args.cwd, undefined, {
      enabled: true,
      enableCodexUser: false,
      enableClaudeUser: false,
      enableClaudeProject: false,
      enablePiUser: false,
      enablePiProject: false,
      enableSkillCommands: true,
      customDirectories: [resolve(bundleRoot, manifest.skillsDir)],
      ignoredSkills: [],
      includeSkills: [],
    })
    for (const warning of warnings ?? []) {
      console.warn(warning)
    }
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

    const authStorage = discoverAuthStorage()
    const modelRegistry = discoverModels(authStorage)
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
