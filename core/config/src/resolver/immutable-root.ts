/**
 * The node-local immutable-source root, either already placed or acquired on
 * first use. Only registry (git-pinned/selector) entries read it; @dev, agent
 * and project spaces never do, so a compile of those needs no mirror at all.
 */
export type ImmutableSourceRoot = string | (() => Promise<string>)

/** Resolve an {@link ImmutableSourceRoot}, falling back to `fallback` when absent. */
export async function resolveImmutableSourceRoot(
  root: ImmutableSourceRoot | undefined,
  fallback: string
): Promise<string> {
  if (root === undefined) return fallback
  return typeof root === 'string' ? root : await root()
}
