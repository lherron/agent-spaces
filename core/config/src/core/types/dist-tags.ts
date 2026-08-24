/**
 * Dist-tags file types.
 *
 * WHY: Dist-tags provide stable channel names (stable, latest, beta)
 * that map to specific versions without needing semver resolution.
 * This file is committed to registry/dist-tags.json and enables
 * PR-reviewable channel promotions.
 */

/**
 * Dist-tags file structure.
 * Maps space IDs to channel -> version mappings.
 *
 * Example:
 * {
 *   "todo-frontend": {
 *     "stable": "v1.2.0",
 *     "latest": "v1.3.0-beta.1"
 *   }
 * }
 */
export interface DistTagsFile {
  [spaceId: string]: {
    [channel: string]: string // e.g., "v1.2.3"
  }
}
