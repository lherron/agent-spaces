/**
 * Lock file generation from resolution results.
 *
 * WHY: Lock files ensure reproducible builds by recording
 * exact versions resolved during installation.
 */

import type {
	SpaceKey,
	SpaceRefString,
	LockFile,
	LockRegistry,
	LockSpaceEntry,
	LockTargetEntry,
	LockPluginInfo,
	ResolvedFrom,
	Sha256Integrity,
} from "@agent-spaces/core";
import { derivePluginIdentity } from "@agent-spaces/core";
import { type ClosureResult, type ResolvedSpace } from "./closure.js";
import { computeIntegrity, computeEnvHash } from "./integrity.js";

/**
 * Options for lock file generation.
 */
export interface LockGeneratorOptions {
	/** Working directory (registry repo root) */
	cwd: string;
	/** Registry information */
	registry: LockRegistry;
}

/**
 * Target resolution input.
 */
export interface TargetInput {
	/** Target name */
	name: string;
	/** Original compose refs */
	compose: SpaceRefString[];
	/** Computed closure */
	closure: ClosureResult;
}

/**
 * Generate a complete lock file from resolved targets.
 */
export async function generateLockFile(
	targets: TargetInput[],
	options: LockGeneratorOptions
): Promise<LockFile> {
	const lock: LockFile = {
		lockfileVersion: 1,
		resolverVersion: 1,
		generatedAt: new Date().toISOString(),
		registry: options.registry,
		spaces: {},
		targets: {},
	};

	// Collect all unique spaces and compute integrities
	const allSpaces = new Map<SpaceKey, ResolvedSpace>();
	const integrities = new Map<SpaceKey, Sha256Integrity>();

	for (const target of targets) {
		for (const [key, space] of target.closure.spaces) {
			if (!allSpaces.has(key)) {
				allSpaces.set(key, space);
				// Compute integrity for each unique space
				const integrity = await computeIntegrity(space.id, space.commit, options);
				integrities.set(key, integrity);
			}
		}
	}

	// Build space entries
	for (const [key, space] of allSpaces) {
		const integrity = integrities.get(key)!;
		const pluginIdentity = derivePluginIdentity(space.manifest);

		const resolvedFrom: ResolvedFrom = {
			selector: space.resolvedFrom.selector.kind === "dist-tag"
				? space.resolvedFrom.selector.tag
				: space.resolvedFrom.selector.kind === "semver"
					? space.resolvedFrom.selector.range
					: `git:${space.resolvedFrom.selector.sha}`,
		};

		if (space.resolvedFrom.tag !== undefined) {
			resolvedFrom.tag = space.resolvedFrom.tag;
		}
		if (space.resolvedFrom.semver !== undefined) {
			resolvedFrom.semver = space.resolvedFrom.semver;
		}

		// Build plugin info, only including version if defined
		const pluginInfo: LockPluginInfo = { name: pluginIdentity.name };
		if (pluginIdentity.version !== undefined) {
			pluginInfo.version = pluginIdentity.version;
		}

		const entry: LockSpaceEntry = {
			id: space.id,
			commit: space.commit,
			path: space.path,
			integrity,
			plugin: pluginInfo,
			deps: {
				spaces: space.deps,
			},
			resolvedFrom,
		};

		lock.spaces[key] = entry;
	}

	// Build target entries
	for (const target of targets) {
		// Build env hash data
		const envHashData = target.closure.loadOrder.map((key) => {
			const space = allSpaces.get(key)!;
			const integrity = integrities.get(key)!;
			const pluginIdentity = derivePluginIdentity(space.manifest);
			return {
				spaceKey: key,
				integrity,
				pluginName: pluginIdentity.name,
			};
		});

		const envHash = computeEnvHash(envHashData);

		const targetEntry: LockTargetEntry = {
			compose: target.compose,
			roots: target.closure.roots,
			loadOrder: target.closure.loadOrder,
			envHash,
		};

		lock.targets[target.name] = targetEntry;
	}

	return lock;
}

/**
 * Generate a lock file for a single target.
 */
export async function generateLockFileForTarget(
	targetName: string,
	compose: SpaceRefString[],
	closure: ClosureResult,
	options: LockGeneratorOptions
): Promise<LockFile> {
	return generateLockFile(
		[{ name: targetName, compose, closure }],
		options
	);
}

/**
 * Merge a new lock file into an existing one.
 * Updates or adds targets while preserving existing ones.
 */
export function mergeLockFiles(
	existing: LockFile,
	updates: LockFile
): LockFile {
	const merged: LockFile = {
		...existing,
		generatedAt: new Date().toISOString(),
		spaces: { ...existing.spaces },
		targets: { ...existing.targets },
	};

	// Merge spaces (updates take precedence for same key)
	for (const [key, entry] of Object.entries(updates.spaces)) {
		merged.spaces[key as SpaceKey] = entry;
	}

	// Merge targets (updates take precedence)
	for (const [name, entry] of Object.entries(updates.targets)) {
		merged.targets[name] = entry;
	}

	return merged;
}

/**
 * Check if a lock file is up to date for a target.
 * Returns true if the compose list matches exactly.
 */
export function isTargetUpToDate(
	lock: LockFile,
	targetName: string,
	compose: SpaceRefString[]
): boolean {
	const entry = lock.targets[targetName];
	if (!entry) {
		return false;
	}

	if (entry.compose.length !== compose.length) {
		return false;
	}

	return entry.compose.every((ref, i) => ref === compose[i]);
}
