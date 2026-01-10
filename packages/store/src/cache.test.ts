/**
 * Tests for cache module.
 *
 * WHY: Plugin cache management is critical for performance.
 * These tests verify cache key computation and operations.
 */

import { describe, expect, it } from "bun:test";
import { computePluginCacheKey } from "./cache.js";
import type { Sha256Integrity } from "@agent-spaces/core";

describe("computePluginCacheKey", () => {
	it("should compute consistent hash", () => {
		const integrity = "sha256:abc123" as Sha256Integrity;
		const key1 = computePluginCacheKey(integrity, "my-plugin", "1.0.0");
		const key2 = computePluginCacheKey(integrity, "my-plugin", "1.0.0");
		expect(key1).toBe(key2);
	});

	it("should produce 64-char hex hash", () => {
		const integrity = "sha256:abc123" as Sha256Integrity;
		const key = computePluginCacheKey(integrity, "my-plugin", "1.0.0");
		expect(key.length).toBe(64);
		expect(/^[0-9a-f]+$/.test(key)).toBe(true);
	});

	it("should differ for different integrities", () => {
		const key1 = computePluginCacheKey("sha256:aaa" as Sha256Integrity, "plugin", "1.0.0");
		const key2 = computePluginCacheKey("sha256:bbb" as Sha256Integrity, "plugin", "1.0.0");
		expect(key1).not.toBe(key2);
	});

	it("should differ for different plugin names", () => {
		const integrity = "sha256:abc" as Sha256Integrity;
		const key1 = computePluginCacheKey(integrity, "plugin-a", "1.0.0");
		const key2 = computePluginCacheKey(integrity, "plugin-b", "1.0.0");
		expect(key1).not.toBe(key2);
	});

	it("should differ for different versions", () => {
		const integrity = "sha256:abc" as Sha256Integrity;
		const key1 = computePluginCacheKey(integrity, "plugin", "1.0.0");
		const key2 = computePluginCacheKey(integrity, "plugin", "1.0.1");
		expect(key1).not.toBe(key2);
	});
});
