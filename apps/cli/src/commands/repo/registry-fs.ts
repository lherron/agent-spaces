/**
 * Shared filesystem readers for the registry layout.
 *
 * WHY: The repo and spaces command families read the same
 * `registry/dist-tags.json` file; this hoists the byte-identical
 * full-registry loader so they share one source of truth.
 */

/**
 * Detect whether the registry is an initialized git repo.
 *
 * The invariant is "the registry has a `.git/HEAD`", encoded once here so the
 * repo/spaces command families stop re-spelling the path literal. Callers keep
 * their own failure protocol (throw vs message+exit) and error text.
 */
export async function registryExists(repoPath: string): Promise<boolean> {
  return Bun.file(`${repoPath}/.git/HEAD`).exists()
}

/**
 * Load the full dist-tags map (space id -> tag -> version) from the registry.
 *
 * Swallows any read/parse failure and returns `{}` so callers can treat a
 * missing or corrupt file as "no tags".
 */
export async function loadAllDistTags(
  repoPath: string
): Promise<Record<string, Record<string, string>>> {
  try {
    const distTagsPath = `${repoPath}/registry/dist-tags.json`
    const content = await Bun.file(distTagsPath).text()
    return JSON.parse(content)
  } catch {
    return {}
  }
}
