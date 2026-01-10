/**
 * Dependency closure computation via DFS postorder.
 *
 * WHY: Spaces can depend on other spaces. We need to compute
 * the full transitive closure and determine load order such
 * that dependencies are loaded before dependents.
 */

import type {
	SpaceId,
	CommitSha,
	SpaceKey,
	SpaceRef,
	SpaceRefString,
	SpaceManifest,
} from "@agent-spaces/core";
import { asSpaceKey, CyclicDependencyError, MissingDependencyError } from "@agent-spaces/core";
import { parseSpaceRef, buildSpaceKey } from "./ref-parser.js";
import { resolveSelector, type SelectorResolveOptions, type ResolvedSelector } from "./selector.js";
import { readSpaceManifest, getSpaceDependencies, type ManifestReadOptions } from "./manifest.js";

/**
 * A resolved space in the dependency graph.
 */
export interface ResolvedSpace {
	/** Unique key: <id>@<commit-prefix> */
	key: SpaceKey;
	/** Space identifier */
	id: SpaceId;
	/** Resolved commit SHA */
	commit: CommitSha;
	/** Path in registry */
	path: string;
	/** The space manifest */
	manifest: SpaceManifest;
	/** Resolution provenance */
	resolvedFrom: ResolvedSelector;
	/** Direct dependency keys */
	deps: SpaceKey[];
}

/**
 * Result of closure computation.
 */
export interface ClosureResult {
	/** All resolved spaces keyed by SpaceKey */
	spaces: Map<SpaceKey, ResolvedSpace>;
	/** Load order (dependencies first) */
	loadOrder: SpaceKey[];
	/** Root space keys (from compose) */
	roots: SpaceKey[];
}

/**
 * Options for closure computation.
 */
export interface ClosureOptions extends SelectorResolveOptions, ManifestReadOptions {}

/**
 * Compute the dependency closure for a set of root space refs.
 */
export async function computeClosure(
	rootRefs: SpaceRefString[],
	options: ClosureOptions
): Promise<ClosureResult> {
	const spaces = new Map<SpaceKey, ResolvedSpace>();
	const loadOrder: SpaceKey[] = [];
	const roots: SpaceKey[] = [];

	// Track visiting state for cycle detection
	// - not in map: not visited
	// - visiting: in current DFS path (potential cycle)
	// - visited: fully processed
	const visitState = new Map<SpaceKey, "visiting" | "visited">();

	// DFS stack for cycle path reporting
	const visitPath: SpaceKey[] = [];

	async function visit(ref: SpaceRef): Promise<SpaceKey> {
		// Resolve the ref to a commit
		const resolved = await resolveSelector(ref.id, ref.selector, options);
		const key = buildSpaceKey(ref.id, resolved.commit);

		// Check visit state
		const state = visitState.get(key);
		if (state === "visited") {
			// Already fully processed
			return key;
		}
		if (state === "visiting") {
			// Cycle detected!
			const cycleStart = visitPath.indexOf(key);
			const cyclePath = [...visitPath.slice(cycleStart), key];
			throw new CyclicDependencyError(cyclePath);
		}

		// Mark as visiting
		visitState.set(key, "visiting");
		visitPath.push(key);

		// Read the manifest
		const manifest = await readSpaceManifest(ref.id, resolved.commit, options);

		// Get dependencies
		const depRefs = getSpaceDependencies(manifest);
		const depKeys: SpaceKey[] = [];

		// Visit dependencies in declared order
		for (const depRefString of depRefs) {
			try {
				const depRef = parseSpaceRef(depRefString);
				const depKey = await visit(depRef);
				depKeys.push(depKey);
			} catch (err) {
				if (err instanceof CyclicDependencyError) {
					throw err;
				}
				// Wrap resolution errors as missing dependency
				// MissingDependencyError takes (spaceId, dependsOn)
				throw new MissingDependencyError(ref.id, depRefString);
			}
		}

		// All deps visited, now add this space (postorder)
		const resolvedSpace: ResolvedSpace = {
			key,
			id: ref.id,
			commit: resolved.commit,
			path: `spaces/${ref.id}`,
			manifest,
			resolvedFrom: resolved,
			deps: depKeys,
		};

		spaces.set(key, resolvedSpace);
		loadOrder.push(key);

		// Mark as fully visited
		visitPath.pop();
		visitState.set(key, "visited");

		return key;
	}

	// Process all root refs in declared order
	for (const rootRefString of rootRefs) {
		const rootRef = parseSpaceRef(rootRefString);
		const rootKey = await visit(rootRef);
		roots.push(rootKey);
	}

	return { spaces, loadOrder, roots };
}

/**
 * Get a space from the closure by key.
 */
export function getSpace(
	closure: ClosureResult,
	key: SpaceKey
): ResolvedSpace | undefined {
	return closure.spaces.get(key);
}

/**
 * Get all spaces in load order.
 */
export function getSpacesInOrder(closure: ClosureResult): ResolvedSpace[] {
	return closure.loadOrder
		.map((key) => closure.spaces.get(key))
		.filter((s): s is ResolvedSpace => s !== undefined);
}

/**
 * Check if a space is a root (directly specified in compose).
 */
export function isRoot(closure: ClosureResult, key: SpaceKey): boolean {
	return closure.roots.includes(key);
}

/**
 * Get the dependents of a space (spaces that depend on it).
 */
export function getDependents(
	closure: ClosureResult,
	key: SpaceKey
): SpaceKey[] {
	const dependents: SpaceKey[] = [];
	for (const [k, space] of closure.spaces) {
		if (space.deps.includes(key)) {
			dependents.push(k);
		}
	}
	return dependents;
}
