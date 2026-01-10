/**
 * Integrity hashing for spaces.
 *
 * WHY: Integrity hashes verify space snapshots are not corrupted.
 * They use a deterministic algorithm based on git tree contents.
 */

import { createHash } from "node:crypto";
import { listTreeRecursive, filterTreeEntries, type TreeEntry } from "@agent-spaces/git";
import type { SpaceId, CommitSha, Sha256Integrity } from "@agent-spaces/core";
import { asSha256Integrity } from "@agent-spaces/core";

/**
 * Options for integrity hashing.
 */
export interface IntegrityOptions {
	/** Working directory (registry repo root) */
	cwd: string;
}

/**
 * Compute the integrity hash for a space at a specific commit.
 *
 * Algorithm:
 * 1. List all files under spaces/<id>/ at the commit
 * 2. Filter out ignored paths (node_modules, .git, etc.)
 * 3. Sort entries by path (lexicographic)
 * 4. Build canonical representation:
 *    "v1\0" + for each entry: path + "\0" + type + "\0" + oid + "\0" + mode + "\n"
 * 5. SHA256 the result
 */
export async function computeIntegrity(
	spaceId: SpaceId,
	commit: CommitSha,
	options: IntegrityOptions
): Promise<Sha256Integrity> {
	const treePath = `spaces/${spaceId}`;
	const ref = commit;

	// Get all files recursively
	let entries: TreeEntry[];
	try {
		entries = await listTreeRecursive(ref, treePath, { cwd: options.cwd });
	} catch (err) {
		// If the tree doesn't exist, return a hash of empty content
		const hash = createHash("sha256");
		hash.update("v1\0");
		return asSha256Integrity(`sha256:${hash.digest("hex")}`);
	}

	// Filter out ignored paths
	const filtered = filterTreeEntries(entries);

	// Sort by path (lexicographic)
	filtered.sort((a, b) => a.path.localeCompare(b.path));

	// Build canonical representation
	const hash = createHash("sha256");
	hash.update("v1\0");

	for (const entry of filtered) {
		// path\0type\0oid\0mode\n
		hash.update(`${entry.path}\0${entry.type}\0${entry.oid}\0${entry.mode}\n`);
	}

	const digest = hash.digest("hex");
	return asSha256Integrity(`sha256:${digest}`);
}

/**
 * Compute the environment hash from load order and integrities.
 *
 * Formula:
 * sha256("env-v1\0" + for each spaceKey in loadOrder:
 *   spaceKey + "\0" + integrity + "\0" + pluginName + "\n")
 */
export function computeEnvHash(
	loadOrder: Array<{
		spaceKey: string;
		integrity: Sha256Integrity;
		pluginName: string;
	}>
): Sha256Integrity {
	const hash = createHash("sha256");
	hash.update("env-v1\0");

	for (const entry of loadOrder) {
		hash.update(`${entry.spaceKey}\0${entry.integrity}\0${entry.pluginName}\n`);
	}

	const digest = hash.digest("hex");
	return asSha256Integrity(`sha256:${digest}`);
}

/**
 * Verify an integrity hash matches the computed value.
 */
export async function verifyIntegrity(
	spaceId: SpaceId,
	commit: CommitSha,
	expected: Sha256Integrity,
	options: IntegrityOptions
): Promise<boolean> {
	const computed = await computeIntegrity(spaceId, commit, options);
	return computed === expected;
}
