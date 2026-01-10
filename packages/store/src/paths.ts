/**
 * Path management for Agent Spaces storage.
 *
 * WHY: All agent-spaces data lives under ASP_HOME (~/.asp by default).
 * This module provides consistent path builders for all storage locations.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import type { SpaceKey, Sha256Integrity } from "@agent-spaces/core";

/**
 * Default ASP_HOME location.
 */
export const DEFAULT_ASP_HOME = join(homedir(), ".asp");

/**
 * Get the ASP_HOME directory path.
 * Uses ASP_HOME env var if set, otherwise defaults to ~/.asp
 */
export function getAspHome(): string {
	return process.env["ASP_HOME"] ?? DEFAULT_ASP_HOME;
}

/**
 * Storage structure under ASP_HOME:
 *
 * ~/.asp/
 * ├── repo/              # Registry git repository
 * │   ├── .git/
 * │   ├── spaces/        # Space sources
 * │   └── registry/      # Metadata (dist-tags.json)
 * ├── store/             # Content-addressed space snapshots
 * │   └── <sha256>/      # Keyed by integrity hash
 * │       ├── space.toml
 * │       ├── commands/
 * │       └── ...
 * ├── cache/             # Materialized plugin cache
 * │   └── <cacheKey>/    # Keyed by pluginCacheKey
 * │       ├── .claude-plugin/
 * │       └── ...
 * └── tmp/               # Temporary files during operations
 */

/**
 * Get the registry repo directory path.
 */
export function getRepoPath(): string {
	return join(getAspHome(), "repo");
}

/**
 * Get the content-addressed store directory path.
 */
export function getStorePath(): string {
	return join(getAspHome(), "store");
}

/**
 * Get the plugin cache directory path.
 */
export function getCachePath(): string {
	return join(getAspHome(), "cache");
}

/**
 * Get the temp directory path.
 */
export function getTempPath(): string {
	return join(getAspHome(), "tmp");
}

/**
 * Get the path for a space snapshot in the store.
 * Snapshots are keyed by their integrity hash.
 */
export function getSnapshotPath(integrity: Sha256Integrity): string {
	// Extract just the hash part (without "sha256:" prefix)
	const hash = integrity.replace("sha256:", "");
	return join(getStorePath(), hash);
}

/**
 * Get the path for a cached plugin.
 * Plugins are cached by their cache key (derived from integrity + plugin identity).
 */
export function getPluginCachePath(cacheKey: string): string {
	return join(getCachePath(), cacheKey);
}

/**
 * Get the path to the spaces directory in the registry.
 */
export function getSpacesPath(): string {
	return join(getRepoPath(), "spaces");
}

/**
 * Get the path to a specific space in the registry.
 */
export function getSpaceSourcePath(spaceId: string): string {
	return join(getSpacesPath(), spaceId);
}

/**
 * Get the path to the registry metadata directory.
 */
export function getRegistryMetaPath(): string {
	return join(getRepoPath(), "registry");
}

/**
 * Get the path to dist-tags.json.
 */
export function getDistTagsPath(): string {
	return join(getRegistryMetaPath(), "dist-tags.json");
}

/**
 * Ensure a directory exists, creating it if necessary.
 */
export async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

/**
 * Ensure all ASP_HOME directories exist.
 */
export async function ensureAspHome(): Promise<void> {
	await Promise.all([
		ensureDir(getRepoPath()),
		ensureDir(getStorePath()),
		ensureDir(getCachePath()),
		ensureDir(getTempPath()),
	]);
}

/**
 * Options for path resolution.
 */
export interface PathOptions {
	/** Override ASP_HOME for testing */
	aspHome?: string | undefined;
}

/**
 * Path resolver with custom ASP_HOME.
 */
export class PathResolver {
	readonly aspHome: string;

	constructor(options: PathOptions = {}) {
		this.aspHome = options.aspHome ?? getAspHome();
	}

	get repo(): string {
		return join(this.aspHome, "repo");
	}

	get store(): string {
		return join(this.aspHome, "store");
	}

	get cache(): string {
		return join(this.aspHome, "cache");
	}

	get temp(): string {
		return join(this.aspHome, "tmp");
	}

	snapshot(integrity: Sha256Integrity): string {
		const hash = integrity.replace("sha256:", "");
		return join(this.store, hash);
	}

	pluginCache(cacheKey: string): string {
		return join(this.cache, cacheKey);
	}

	spaceSource(spaceId: string): string {
		return join(this.repo, "spaces", spaceId);
	}

	async ensureAll(): Promise<void> {
		await Promise.all([
			ensureDir(this.repo),
			ensureDir(this.store),
			ensureDir(this.cache),
			ensureDir(this.temp),
		]);
	}
}
