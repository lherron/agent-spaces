/**
 * Space manifest reading from git.
 *
 * WHY: Resolution needs to read space.toml from specific commits
 * to resolve transitive dependencies.
 */

import { showFile, showFileOrNull } from "@agent-spaces/git";
import type { SpaceId, CommitSha, SpaceManifest, SpaceRefString } from "@agent-spaces/core";
import { validateSpaceManifest as coreValidateManifest, ConfigParseError } from "@agent-spaces/core";
import TOML from "@iarna/toml";

/**
 * Options for manifest reading.
 */
export interface ManifestReadOptions {
	/** Working directory (registry repo root) */
	cwd: string;
}

/**
 * Read a space manifest from a specific commit.
 * Throws if the manifest doesn't exist or is invalid.
 */
export async function readSpaceManifest(
	spaceId: SpaceId,
	commit: CommitSha,
	options: ManifestReadOptions
): Promise<SpaceManifest> {
	const path = `spaces/${spaceId}/space.toml`;

	// showFileOrNull takes (commitish, path, options)
	const content = await showFileOrNull(commit, path, { cwd: options.cwd });
	if (content === null) {
		throw new ConfigParseError(
			path,
			`Space manifest not found at ${commit}:${path}`
		);
	}

	try {
		const data = TOML.parse(content);
		const result = coreValidateManifest(data);
		if (!result.valid) {
			throw new ConfigParseError(
				path,
				`Invalid space manifest: ${result.errors.map(e => e.message).join(", ")}`
			);
		}
		return result.data;
	} catch (err) {
		if (err instanceof ConfigParseError) {
			throw err;
		}
		throw new ConfigParseError(
			path,
			`Failed to parse space manifest: ${err instanceof Error ? err.message : String(err)}`
		);
	}
}

/**
 * Get the dependencies from a space manifest.
 */
export function getSpaceDependencies(manifest: SpaceManifest): SpaceRefString[] {
	return manifest.deps?.spaces ?? [];
}

/**
 * Check if a space manifest has any dependencies.
 */
export function hasDependencies(manifest: SpaceManifest): boolean {
	return getSpaceDependencies(manifest).length > 0;
}

/**
 * Read a space manifest if it exists, returning null otherwise.
 */
export async function readSpaceManifestOrNull(
	spaceId: SpaceId,
	commit: CommitSha,
	options: ManifestReadOptions
): Promise<SpaceManifest | null> {
	try {
		return await readSpaceManifest(spaceId, commit, options);
	} catch {
		return null;
	}
}
