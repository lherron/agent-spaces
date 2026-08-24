/**
 * Shared inherit-flag → setting-sources resolution.
 *
 * WHY: `asp run` and `asp gui` each carried an identical helper translating the
 * `--inherit-*` flags into the `settingSources` value the execution layer
 * expects. Centralizing it removes the duplication and keeps the contract in
 * one place.
 */

/**
 * The inherit flags that influence which harness setting sources are used.
 */
export interface InheritFlags {
  inheritAll?: boolean
  inheritProject?: boolean
  inheritUser?: boolean
  inheritLocal?: boolean
}

/**
 * Build setting sources value from inherit flags.
 *
 * Returns:
 * - null: inherit all settings (--inherit-all)
 * - string: specific sources to inherit ('user,project')
 * - undefined: use default behavior (isolated mode)
 */
export function buildSettingSources(options: InheritFlags): string | null | undefined {
  // --inherit-all means use all sources (don't pass --setting-sources at all)
  if (options.inheritAll) {
    return null
  }

  const sources: string[] = []
  if (options.inheritProject) sources.push('project')
  if (options.inheritUser) sources.push('user')
  if (options.inheritLocal) sources.push('local')

  // If any inherit flags specified, return the combined string
  if (sources.length > 0) {
    return sources.join(',')
  }

  // Default: isolated mode (undefined means "use default" which is isolated)
  return undefined
}
