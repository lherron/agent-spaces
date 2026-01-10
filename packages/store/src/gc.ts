/**
 * Garbage collection for store and cache.
 *
 * WHY: Over time, the store and cache accumulate entries that are no longer
 * referenced by any lock file. GC cleans these up to reclaim disk space.
 */

import { readdir } from "node:fs/promises";
import type { Sha256Integrity, LockFile, SpaceKey } from "@agent-spaces/core";
import { asSha256Integrity } from "@agent-spaces/core";
import { type PathResolver } from "./paths.js";
import { listSnapshots, deleteSnapshot, type SnapshotOptions } from "./snapshot.js";
import { listCacheEntries, deleteCache, computePluginCacheKey, type CacheOptions } from "./cache.js";

/**
 * GC result statistics.
 */
export interface GCResult {
	/** Number of snapshots deleted */
	snapshotsDeleted: number;
	/** Number of cache entries deleted */
	cacheEntriesDeleted: number;
	/** Bytes freed (approximate) */
	bytesFreed: number;
}

/**
 * Options for garbage collection.
 */
export interface GCOptions {
	/** Path resolver for storage locations */
	paths: PathResolver;
	/** Working directory (for snapshot operations) */
	cwd: string;
	/** Dry run - don't actually delete anything */
	dryRun?: boolean | undefined;
}

/**
 * Compute the set of reachable integrities from lock files.
 */
export function computeReachableIntegrities(lockFiles: LockFile[]): Set<Sha256Integrity> {
	const reachable = new Set<Sha256Integrity>();

	for (const lock of lockFiles) {
		for (const entry of Object.values(lock.spaces)) {
			reachable.add(entry.integrity);
		}
	}

	return reachable;
}

/**
 * Compute the set of reachable cache keys from lock files.
 */
export function computeReachableCacheKeys(lockFiles: LockFile[]): Set<string> {
	const reachable = new Set<string>();

	for (const lock of lockFiles) {
		for (const entry of Object.values(lock.spaces)) {
			const cacheKey = computePluginCacheKey(
				entry.integrity,
				entry.plugin.name,
				entry.plugin.version ?? "0.0.0"
			);
			reachable.add(cacheKey);
		}
	}

	return reachable;
}

/**
 * Run garbage collection on the store and cache.
 */
export async function runGC(
	lockFiles: LockFile[],
	options: GCOptions
): Promise<GCResult> {
	const result: GCResult = {
		snapshotsDeleted: 0,
		cacheEntriesDeleted: 0,
		bytesFreed: 0,
	};

	// Compute reachable sets
	const reachableIntegrities = computeReachableIntegrities(lockFiles);
	const reachableCacheKeys = computeReachableCacheKeys(lockFiles);

	// GC snapshots
	const snapshotOpts: SnapshotOptions = {
		paths: options.paths,
		cwd: options.cwd,
	};

	const snapshots = await listSnapshots(snapshotOpts);
	for (const integrity of snapshots) {
		if (!reachableIntegrities.has(integrity)) {
			if (!options.dryRun) {
				await deleteSnapshot(integrity, snapshotOpts);
			}
			result.snapshotsDeleted++;
		}
	}

	// GC cache
	const cacheOpts: CacheOptions = { paths: options.paths };
	const cacheEntries = await listCacheEntries(cacheOpts);

	for (const cacheKey of cacheEntries) {
		if (!reachableCacheKeys.has(cacheKey)) {
			if (!options.dryRun) {
				await deleteCache(cacheKey, cacheOpts);
			}
			result.cacheEntriesDeleted++;
		}
	}

	return result;
}

/**
 * Check what would be garbage collected without actually deleting.
 */
export async function checkGC(
	lockFiles: LockFile[],
	options: GCOptions
): Promise<GCResult> {
	return runGC(lockFiles, { ...options, dryRun: true });
}
