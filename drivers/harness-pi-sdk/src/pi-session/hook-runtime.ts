/**
 * Shared Pi SDK bundle hook runtime.
 *
 * Both the library loader (`bundle.ts`) and the standalone runner
 * (`pi-sdk/pi-sdk/runner.ts`) need to: load + validate a `bundle.json`, resolve
 * hook script paths, run hook scripts, and register the four `pi.on(...)`
 * lifecycle handlers that drive them. This module is the single implementation
 * of that machinery so a fix (e.g. to `runHookScript`'s `shell: true` escaping)
 * only has to be made once.
 */

import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import type { PiSdkBundleHookEntry, PiSdkBundleManifest } from './bundle-manifest-types.js'
import {
  PI_SDK_BUNDLE_SCHEMA_VERSION,
  assertPiSdkBundleHarness,
  readPiSdkBundleManifest,
} from './manifest-loading.js'

export { PI_SDK_BUNDLE_SCHEMA_VERSION, PI_SDK_HARNESS_ID } from './manifest-loading.js'

/** Hook-event names matched against bundle hook entries (`hook.event`). */
const HOOK_RUNTIME_EVENT = {
  PRE_TOOL_USE: 'pre_tool_use',
  POST_TOOL_USE: 'post_tool_use',
  SESSION_START: 'session_start',
  SESSION_END: 'session_end',
} as const

/** Pi lifecycle event names `pi.on(...)` handlers are registered against. */
export const PI_LIFECYCLE_EVENT = {
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  TURN_START: 'turn_start',
  TURN_END: 'turn_end',
  SESSION_START: 'session_start',
  SESSION_SHUTDOWN: 'session_shutdown',
} as const

/** Minimal Pi extension API surface this runtime depends on. */
export interface ExtensionApi {
  on: <Args extends unknown[]>(event: string, handler: (...args: Args) => unknown) => unknown
  sendMessage: (message: unknown, options?: unknown) => unknown
}

/** An extension registrar invoked with the (minimally-typed) Pi extension API. */
export type ExtensionFactory = (pi: ExtensionApi) => void | Promise<void>

interface HookRunContext {
  sessionManager?: { getSessionFile?: () => string | undefined }
}

interface HookScriptResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface HookBlockResult {
  blocked: boolean
  reason?: string | undefined
}

/** Read + validate a Pi SDK `bundle.json` manifest from a bundle root. */
export async function loadBundleManifest(bundleRoot: string): Promise<PiSdkBundleManifest> {
  const manifestPath = resolve(bundleRoot, 'bundle.json')
  const manifest = await readPiSdkBundleManifest<PiSdkBundleManifest>(manifestPath)
  assertPiSdkBundleHarness(manifest.harnessId)

  if (manifest.schemaVersion !== PI_SDK_BUNDLE_SCHEMA_VERSION) {
    throw new Error(`Unsupported bundle schemaVersion: ${manifest.schemaVersion}`)
  }

  return manifest
}

export function resolveHookScriptPath(bundleRoot: string, script: string): string {
  if (/\s/.test(script)) {
    return script
  }

  if (isAbsolute(script)) {
    return script
  }

  return resolve(bundleRoot, script)
}

export async function runHookScript(
  script: string,
  payload: string,
  env: Record<string, string>,
  cwd: string
): Promise<HookScriptResult> {
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

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return ''
  }
}

/**
 * Collect the de-duplicated set of spaceIds contributing to a bundle, drawn
 * from both its extensions and its context files. Shared by every
 * `buildHookExtension` caller so the space-id provenance stays consistent.
 */
export function collectBundleSpaceIds(manifest: PiSdkBundleManifest): string[] {
  return Array.from(
    new Set([
      ...manifest.extensions.map((entry) => entry.spaceId),
      ...(manifest.contextFiles ?? []).map((entry) => entry.spaceId),
    ])
  )
}

export interface BuildHookExtensionOptions {
  hooks: PiSdkBundleHookEntry[]
  bundleRoot: string
  targetName: string
  spaceIds: string[]
  yolo: boolean
  cwd: string
}

/**
 * Build the Pi extension factory that wires bundle hooks to the four lifecycle
 * events. The factory takes the (minimally-typed) Pi extension API and returns
 * void; callers that need a stricter `ExtensionFactory` shape can cast the
 * result, since the runtime contract is identical.
 */
export function buildHookExtension(options: BuildHookExtensionOptions): (pi: ExtensionApi) => void {
  const { hooks, bundleRoot, targetName, spaceIds, yolo, cwd } = options
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === 'string')
  ) as Record<string, string>

  return (pi: ExtensionApi) => {
    const runHooks = async (
      hookEvent: string,
      event: Record<string, unknown>,
      ctx: HookRunContext | undefined,
      toolName?: string | undefined
    ): Promise<HookBlockResult | undefined> => {
      const matching = hooks.filter((hook) => hook.event === hookEvent)
      for (const hook of matching) {
        if (hook.tools && toolName) {
          const normalizedTool = toolName.toLowerCase()
          const allowed = hook.tools.some((tool) => tool.toLowerCase() === normalizedTool)
          if (!allowed) {
            continue
          }
        }

        const payload = safeJsonStringify(event)
        const resolvedScript = resolveHookScriptPath(bundleRoot, hook.script)
        const toolInput = safeJsonStringify((event as { input?: unknown }).input)
        const toolResult = safeJsonStringify(event)
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

        let result: HookScriptResult | undefined
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
          if (hook.blocking && !yolo && hookEvent === HOOK_RUNTIME_EVENT.PRE_TOOL_USE) {
            return { blocked: true, reason: message }
          }
          continue
        }

        const outputParts: string[] = []
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

        if (
          hook.blocking &&
          !yolo &&
          hookEvent === HOOK_RUNTIME_EVENT.PRE_TOOL_USE &&
          result.exitCode !== 0
        ) {
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

    pi.on(PI_LIFECYCLE_EVENT.TOOL_CALL, async (event: Record<string, unknown>, ctx: unknown) => {
      const result = await runHooks(
        HOOK_RUNTIME_EVENT.PRE_TOOL_USE,
        event,
        ctx as HookRunContext,
        event['toolName'] as string | undefined
      )
      if (result?.blocked) {
        return { block: true, reason: result.reason }
      }
      return undefined
    })

    pi.on(PI_LIFECYCLE_EVENT.TOOL_RESULT, async (event: Record<string, unknown>, ctx: unknown) => {
      await runHooks(
        HOOK_RUNTIME_EVENT.POST_TOOL_USE,
        event,
        ctx as HookRunContext,
        event['toolName'] as string | undefined
      )
      return undefined
    })

    pi.on(
      PI_LIFECYCLE_EVENT.SESSION_START,
      async (event: Record<string, unknown>, ctx: unknown) => {
        await runHooks(HOOK_RUNTIME_EVENT.SESSION_START, event, ctx as HookRunContext)
        return undefined
      }
    )

    pi.on(
      PI_LIFECYCLE_EVENT.SESSION_SHUTDOWN,
      async (event: Record<string, unknown>, ctx: unknown) => {
        await runHooks(HOOK_RUNTIME_EVENT.SESSION_END, event, ctx as HookRunContext)
        return undefined
      }
    )
  }
}
