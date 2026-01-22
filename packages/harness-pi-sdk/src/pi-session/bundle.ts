import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { discoverSkills } from '@mariozechner/pi-coding-agent'
import type { ExtensionFactory, Skill } from '@mariozechner/pi-coding-agent'

interface PiSdkBundleExtensionEntry {
  spaceId: string
  path: string
}

interface PiSdkBundleContextEntry {
  spaceId: string
  path: string
  label?: string | undefined
}

export interface PiSdkBundleHookEntry {
  event: string
  script: string
  tools?: string[] | undefined
  blocking?: boolean | undefined
}

export interface PiSdkBundleManifest {
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

export interface PiSdkContextFile {
  path: string
  content: string
  label?: string | undefined
}

export interface LoadPiSdkBundleOptions {
  cwd: string
  yolo?: boolean
  noExtensions?: boolean
  noSkills?: boolean
  agentDir?: string
}

export interface PiSdkBundleLoadResult {
  targetName: string
  bundleRoot: string
  extensions: ExtensionFactory[]
  skills: Skill[]
  contextFiles: PiSdkContextFile[]
  manifest: PiSdkBundleManifest
}

async function loadBundle(bundleRoot: string): Promise<PiSdkBundleManifest> {
  const manifestPath = resolve(bundleRoot, 'bundle.json')
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
}): ExtensionFactory {
  const { hooks, bundleRoot, targetName, spaceIds, yolo, cwd } = options
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === 'string')
  ) as Record<string, string>

  return (pi) => {
    const api = pi as ExtensionApi
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
          api.sendMessage({
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
          api.sendMessage({
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

    api.on('tool_call', async (event: Record<string, unknown>, ctx: unknown) => {
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

    api.on('tool_result', async (event: Record<string, unknown>, ctx: unknown) => {
      await runHooks(
        'post_tool_use',
        event,
        ctx as { sessionManager?: { getSessionFile?: () => string | undefined } },
        event['toolName'] as string | undefined
      )
      return undefined
    })

    api.on('session_start', async (event: Record<string, unknown>, ctx: unknown) => {
      await runHooks(
        'session_start',
        event,
        ctx as { sessionManager?: { getSessionFile?: () => string | undefined } }
      )
      return undefined
    })

    api.on('session_shutdown', async (event: Record<string, unknown>, ctx: unknown) => {
      await runHooks(
        'session_end',
        event,
        ctx as { sessionManager?: { getSessionFile?: () => string | undefined } }
      )
      return undefined
    })
  }
}

export async function loadPiSdkBundle(
  bundleRoot: string,
  options: LoadPiSdkBundleOptions
): Promise<PiSdkBundleLoadResult> {
  const manifest = await loadBundle(bundleRoot)
  const extensionFactories: ExtensionFactory[] = []
  const noExtensions = options.noExtensions ?? false
  const noSkills = options.noSkills ?? false
  const yolo = options.yolo ?? false

  const hooks = noExtensions ? [] : (manifest.hooks ?? [])
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
        yolo,
        cwd: options.cwd,
      })
    )
  }

  if (!noExtensions) {
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
      return { path: filePath, content, label: entry.label }
    })
  )

  let skills: Skill[] = []
  if (!noSkills && manifest.skillsDir) {
    const { skills: discovered, warnings } = discoverSkills(options.cwd, options.agentDir, {
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

  return {
    targetName: manifest.targetName,
    bundleRoot,
    extensions: extensionFactories,
    skills,
    contextFiles,
    manifest,
  }
}
