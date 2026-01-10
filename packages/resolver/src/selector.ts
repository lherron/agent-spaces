/**
 * Selector resolution - resolve any selector type to a commit SHA.
 *
 * WHY: This is the core resolution logic that turns abstract
 * selectors (dist-tag, semver, git-pin) into concrete commits.
 */

import type { SpaceId, CommitSha, Selector, SpaceRef } from "@agent-spaces/core";
import { asCommitSha, SelectorResolutionError } from "@agent-spaces/core";
import { resolveDistTag, versionToGitTag } from "./dist-tags.js";
import {
	resolveExactVersion,
	resolveSemverRange,
	type VersionInfo,
} from "./git-tags.js";
import { getTagCommit } from "@agent-spaces/git";

/**
 * Resolution result with provenance information.
 */
export interface ResolvedSelector {
	/** The resolved commit SHA */
	commit: CommitSha;
	/** The original selector */
	selector: Selector;
	/** The git tag that was matched (if any) */
	tag?: string | undefined;
	/** The semver version (if resolved via version) */
	semver?: string | undefined;
}

/**
 * Options for selector resolution.
 */
export interface SelectorResolveOptions {
	/** Working directory (registry repo root) */
	cwd: string;
	/** Git ref for reading dist-tags (default: HEAD) */
	distTagsRef?: string | undefined;
}

/**
 * Resolve a selector to a commit SHA.
 */
export async function resolveSelector(
	spaceId: SpaceId,
	selector: Selector,
	options: SelectorResolveOptions
): Promise<ResolvedSelector> {
	switch (selector.kind) {
		case "dist-tag":
			return resolveDistTagSelector(spaceId, selector.tag, options);
		case "semver":
			return resolveSemverSelector(spaceId, selector.range, selector.exact, options);
		case "git-pin":
			return resolveGitPinSelector(spaceId, selector.sha, options);
		default:
			throw new SelectorResolutionError(
				spaceId,
				"unknown",
				`Unknown selector kind: ${(selector as Selector).kind}`
			);
	}
}

/**
 * Resolve a space reference to a commit SHA.
 */
export async function resolveSpaceRef(
	ref: SpaceRef,
	options: SelectorResolveOptions
): Promise<ResolvedSelector> {
	return resolveSelector(ref.id, ref.selector, options);
}

/**
 * Resolve a dist-tag selector.
 */
async function resolveDistTagSelector(
	spaceId: SpaceId,
	tagName: string,
	options: SelectorResolveOptions
): Promise<ResolvedSelector> {
	// Look up dist-tag in registry metadata
	const version = await resolveDistTag(spaceId, tagName, {
		cwd: options.cwd,
		ref: options.distTagsRef,
	});

	if (version === null) {
		throw new SelectorResolutionError(
			spaceId,
			tagName,
			`Dist-tag '${tagName}' not found for space '${spaceId}'`
		);
	}

	// Convert version to git tag and resolve to commit
	const gitTag = versionToGitTag(spaceId, version);
	let commit: string;
	try {
		commit = await getTagCommit(gitTag, { cwd: options.cwd });
	} catch (err) {
		throw new SelectorResolutionError(
			spaceId,
			tagName,
			`Git tag '${gitTag}' for dist-tag '${tagName}' not found`
		);
	}

	return {
		commit: asCommitSha(commit),
		selector: { kind: "dist-tag", tag: tagName },
		tag: gitTag,
		semver: version.startsWith("v") ? version.slice(1) : version,
	};
}

/**
 * Resolve a semver selector (exact or range).
 */
async function resolveSemverSelector(
	spaceId: SpaceId,
	range: string,
	exact: boolean,
	options: SelectorResolveOptions
): Promise<ResolvedSelector> {
	let versionInfo: VersionInfo | null = null;

	if (exact) {
		// Exact version match
		const commit = await resolveExactVersion(spaceId, range, options);
		if (commit !== null) {
			versionInfo = {
				tag: `space/${spaceId}/v${range}`,
				version: range,
				commit,
			};
		}
	} else {
		// Range match - find highest satisfying version
		versionInfo = await resolveSemverRange(spaceId, range, options);
	}

	if (versionInfo === null) {
		throw new SelectorResolutionError(
			spaceId,
			range,
			exact
				? `Version '${range}' not found for space '${spaceId}'`
				: `No version matching '${range}' found for space '${spaceId}'`
		);
	}

	return {
		commit: versionInfo.commit,
		selector: { kind: "semver", range, exact },
		tag: versionInfo.tag,
		semver: versionInfo.version,
	};
}

/**
 * Resolve a git-pin selector.
 */
async function resolveGitPinSelector(
	spaceId: SpaceId,
	sha: CommitSha,
	_options: SelectorResolveOptions
): Promise<ResolvedSelector> {
	// Git pin uses the commit directly - no resolution needed
	// We don't verify the commit exists here; that's done when reading the space
	return {
		commit: sha,
		selector: { kind: "git-pin", sha },
	};
}

/**
 * Batch resolve multiple space refs.
 */
export async function resolveSpaceRefs(
	refs: SpaceRef[],
	options: SelectorResolveOptions
): Promise<Map<SpaceRef, ResolvedSelector>> {
	const results = new Map<SpaceRef, ResolvedSelector>();

	// Resolve all refs in parallel
	await Promise.all(
		refs.map(async (ref) => {
			const resolved = await resolveSpaceRef(ref, options);
			results.set(ref, resolved);
		})
	);

	return results;
}
