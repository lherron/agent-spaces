import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { PathResolver, type SpaceRefString } from 'spaces-config'

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

export function combinePrompts(
  primingPrompt: string | undefined,
  userPrompt: string | undefined
): string | undefined {
  if (primingPrompt !== undefined && userPrompt !== undefined) {
    return `${primingPrompt}\n\n${userPrompt}`
  }
  return primingPrompt ?? userPrompt
}

export function resolveInteractive(interactive: boolean | undefined): boolean | undefined {
  if (interactive !== undefined) {
    return interactive
  }
  return undefined
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
