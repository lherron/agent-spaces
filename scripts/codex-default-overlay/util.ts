import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'

export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export function isWithinPath(path: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))
}

export function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}
