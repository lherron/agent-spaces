/**
 * Git tag resolution for semver matching.
 *
 * WHY: Spaces are versioned using git tags in the format
 * space/<id>/vX.Y.Z. This module queries and matches these tags.
 */

import { listTags, listTagsWithCommits, getTagCommit } from "@agent-spaces/git";
import type { SpaceId, CommitSha } from "@agent-spaces/core";
import { asCommitSha, SelectorResolutionError } from "@agent-spaces/core";
import * as semver from "semver";

/**
 * Version information extracted from a git tag.
 */
export interface VersionInfo {
	/** The original git tag name */
	tag: string;
	/** Parsed semver version */
	version: string;
	/** Commit SHA the tag points to */
	commit: CommitSha;
}

/**
 * Options for git tag operations.
 */
export interface GitTagOptions {
	/** Working directory (registry repo root) */
	cwd: string;
}

/**
 * Build the git tag pattern for a space.
 * Tags follow the format: space/<id>/v*
 */
export function buildTagPattern(spaceId: SpaceId): string {
	return `space/${spaceId}/v*`;
}

/**
 * Parse a git tag to extract version info.
 * Returns null if the tag doesn't match expected format.
 */
export function parseVersionTag(tag: string): { spaceId: string; version: string } | null {
	const match = tag.match(/^space\/([^/]+)\/v(.+)$/);
	if (!match) {
		return null;
	}
	const [, spaceId, version] = match;
	if (!spaceId || !version) {
		return null;
	}
	// Validate it's a valid semver
	if (!semver.valid(version)) {
		return null;
	}
	return { spaceId, version };
}

/**
 * List all version tags for a space with their commits.
 */
export async function listVersionTags(
	spaceId: SpaceId,
	options: GitTagOptions
): Promise<VersionInfo[]> {
	const pattern = buildTagPattern(spaceId);
	const tagsWithCommits = await listTagsWithCommits(pattern, { cwd: options.cwd });

	const versions: VersionInfo[] = [];
	// GitTag has { name, commit } properties
	for (const { name, commit } of tagsWithCommits) {
		const parsed = parseVersionTag(name);
		if (parsed && parsed.spaceId === spaceId) {
			versions.push({
				tag: name,
				version: parsed.version,
				commit: asCommitSha(commit),
			});
		}
	}

	// Sort by semver descending (newest first)
	versions.sort((a, b) => semver.rcompare(a.version, b.version));
	return versions;
}

/**
 * Resolve an exact version to a commit.
 */
export async function resolveExactVersion(
	spaceId: SpaceId,
	version: string,
	options: GitTagOptions
): Promise<CommitSha | null> {
	// Normalize version
	const normalizedVersion = version.startsWith("v") ? version.slice(1) : version;
	const tagName = `space/${spaceId}/v${normalizedVersion}`;

	try {
		const commit = await getTagCommit(tagName, { cwd: options.cwd });
		return asCommitSha(commit);
	} catch {
		return null;
	}
}

/**
 * Resolve a semver range to the highest matching version.
 */
export async function resolveSemverRange(
	spaceId: SpaceId,
	range: string,
	options: GitTagOptions
): Promise<VersionInfo | null> {
	const versions = await listVersionTags(spaceId, options);
	if (versions.length === 0) {
		return null;
	}

	// Parse the range
	const parsedRange = semver.validRange(range);
	if (!parsedRange) {
		return null;
	}

	// Find highest matching version (versions are sorted descending)
	for (const info of versions) {
		if (semver.satisfies(info.version, parsedRange)) {
			return info;
		}
	}

	return null;
}

/**
 * Get the latest version for a space (highest semver).
 */
export async function getLatestVersion(
	spaceId: SpaceId,
	options: GitTagOptions
): Promise<VersionInfo | null> {
	const versions = await listVersionTags(spaceId, options);
	if (versions.length === 0) {
		return null;
	}
	// Already sorted descending, first is highest
	return versions[0] ?? null;
}

/**
 * Check if a specific version exists for a space.
 */
export async function versionExists(
	spaceId: SpaceId,
	version: string,
	options: GitTagOptions
): Promise<boolean> {
	const commit = await resolveExactVersion(spaceId, version, options);
	return commit !== null;
}
