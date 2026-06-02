import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { type HarnessRunOptions, PathResolver, type SpaceRefString } from 'spaces-config'

import type { BaseRunOptions } from './types.js'

export function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function formatCommand(commandPath: string, args: string[]): string {
  return [shellQuote(commandPath), ...args.map(shellQuote)].join(' ')
}

export function formatEnvPrefix(env: Record<string, string> | undefined): string {
  if (!env || Object.keys(env).length === 0) return ''
  return `${Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ')} `
}

export function mergeDefined<T extends object>(defaults: Partial<T>, overrides: Partial<T>): T {
  const merged = { ...defaults } as T
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const value = overrides[key]
    if (value !== undefined) {
      merged[key] = value as T[keyof T]
    }
  }
  return merged
}

/**
 * Combine a priming prompt and a user prompt into a single prompt.
 *
 * Ordering contract: the priming prompt always precedes the user prompt,
 * separated by a blank line (`priming\n\nuser`). Multiple call sites depend on
 * this order; do not reorder without updating them.
 */
export function combinePrompts(
  primingPrompt: string | undefined,
  userPrompt: string | undefined
): string | undefined {
  if (primingPrompt !== undefined && userPrompt !== undefined) {
    return `${primingPrompt}\n\n${userPrompt}`
  }
  return primingPrompt ?? userPrompt
}

/** Parse an env-style boolean gate that accepts `'1'` or `'true'`. */
function isEnvFlagEnabled(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

/**
 * Resolve the run-time feature gates from the environment.
 *
 * Centralizes the `ASP_RUN_VIA_COMPILER` / `ASP_DEBUG_RUN` `'1' | 'true'` gate
 * parsing that both `run.ts` and `space-launch.ts` previously duplicated inline.
 * `env` defaults to `process.env` so existing callers behave identically, while
 * tests can pass an explicit env.
 */
export function resolveRunEnvFlags(env: NodeJS.ProcessEnv = process.env): {
  viaCompiler: boolean
  debugRun: boolean
} {
  return {
    viaCompiler: isEnvFlagEnabled(env['ASP_RUN_VIA_COMPILER']),
    debugRun: isEnvFlagEnabled(env['ASP_DEBUG_RUN']),
  }
}

/** Whether the run should be driven through the injected compiler. */
export function isViaCompiler(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveRunEnvFlags(env).viaCompiler
}

/**
 * Map a run-options bag onto the harness-facing `HarnessRunOptions` literal.
 *
 * Both the project-target run (`run.ts`) and the space run (`space-launch.ts`)
 * previously inlined a near-identical ~18-field literal that differed only in
 * `aspHome` / `projectPath` / `cwd` defaulting and the prompt value. This helper
 * captures the shared mapping; callers pass the run-mode-specific overrides so a
 * new launch field is added in exactly one place.
 */
export function toHarnessRunOptions(
  options: BaseRunOptions,
  overrides: {
    aspHome: string
    projectPath: string | undefined
    taskId?: string | undefined
    cwd: string | undefined
    prompt: string | undefined
  }
): HarnessRunOptions {
  return {
    aspHome: overrides.aspHome,
    model: options.model,
    modelReasoningEffort: options.modelReasoningEffort,
    extraArgs: options.extraArgs,
    interactive: options.interactive,
    prompt: overrides.prompt,
    settingSources: options.settingSources,
    permissionMode: options.permissionMode,
    settings: options.settings,
    yolo: options.yolo,
    debug: options.debug,
    projectPath: overrides.projectPath,
    taskId: overrides.taskId,
    cwd: overrides.cwd,
    artifactDir: options.artifactDir,
    continuationKey: options.continuationKey,
    remoteControl: options.remoteControl,
    sessionNamePrefix: options.sessionNamePrefix,
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export function composeArraysMatch(
  manifestCompose: readonly SpaceRefString[],
  lockCompose: readonly SpaceRefString[]
): boolean {
  if (manifestCompose.length !== lockCompose.length) {
    return false
  }
  return manifestCompose.every((ref, index) => ref === lockCompose[index])
}

export async function createTempDir(aspHome: string): Promise<string> {
  const paths = new PathResolver({ aspHome })
  await mkdir(paths.temp, { recursive: true })
  return mkdtemp(join(paths.temp, 'run-'))
}

export async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    await rm(tempDir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
}
