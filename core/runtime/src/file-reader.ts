import { readFile } from 'node:fs/promises'

/**
 * Shared internal file-reading helpers centralizing the "read a file, treat a
 * missing file as a non-error" pattern that was previously duplicated across
 * context-resolver and the agent-memory store. Package-internal; not re-exported
 * from the package root.
 */

/** True when `error` is a Node ENOENT (missing file/path) error. */
export function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * Read a UTF-8 file, returning `undefined` when the file does not exist. Any
 * other error propagates.
 */
export async function readFileOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined
    }
    throw error
  }
}

/**
 * Read a UTF-8 file, returning an empty string when the file does not exist. Any
 * other error propagates.
 */
export async function readFileOrEmpty(filePath: string): Promise<string> {
  return (await readFileOrUndefined(filePath)) ?? ''
}
