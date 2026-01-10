/**
 * Tests for git-tags module.
 *
 * WHY: Git tag parsing is critical for semver resolution.
 * These tests verify tag parsing and pattern building.
 */

import { describe, expect, it } from "bun:test";
import {
	buildTagPattern,
	parseVersionTag,
} from "./git-tags.js";
import type { SpaceId } from "@agent-spaces/core";

describe("buildTagPattern", () => {
	it("should build pattern for space tags", () => {
		const pattern = buildTagPattern("my-space" as SpaceId);
		expect(pattern).toBe("space/my-space/v*");
	});
});

describe("parseVersionTag", () => {
	it("should parse valid version tag", () => {
		const result = parseVersionTag("space/my-space/v1.2.3");
		expect(result).not.toBeNull();
		expect(result?.spaceId).toBe("my-space");
		expect(result?.version).toBe("1.2.3");
	});

	it("should parse prerelease version", () => {
		const result = parseVersionTag("space/my-space/v1.0.0-beta.1");
		expect(result).not.toBeNull();
		expect(result?.version).toBe("1.0.0-beta.1");
	});

	it("should return null for invalid format", () => {
		expect(parseVersionTag("not-a-tag")).toBeNull();
		expect(parseVersionTag("space/my-space")).toBeNull();
		expect(parseVersionTag("space/my-space/1.2.3")).toBeNull(); // missing v
	});

	it("should return null for invalid semver", () => {
		expect(parseVersionTag("space/my-space/vabc")).toBeNull();
		expect(parseVersionTag("space/my-space/v1.2")).toBeNull();
	});
});
