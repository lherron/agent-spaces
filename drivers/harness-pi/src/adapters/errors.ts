/**
 * Pi-specific error classes.
 */

import { AspError } from 'spaces-config'

/** Error thrown when Pi binary is not found */
export class PiNotFoundError extends AspError {
  constructor(searchedPaths: string[]) {
    super(`Pi CLI not found. Searched: ${searchedPaths.join(', ')}`, 'PI_NOT_FOUND_ERROR')
    this.name = 'PiNotFoundError'
  }
}

/** Error thrown when Pi extension bundling fails */
export class PiBundleError extends AspError {
  readonly extensionPath: string
  readonly stderr: string

  constructor(extensionPath: string, stderr: string) {
    super(`Failed to bundle Pi extension "${extensionPath}": ${stderr}`, 'PI_BUNDLE_ERROR')
    this.name = 'PiBundleError'
    this.extensionPath = extensionPath
    this.stderr = stderr
  }
}
