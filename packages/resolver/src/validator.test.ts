/**
 * Tests for validator module.
 *
 * WHY: Validation catches configuration issues early.
 * These tests verify various error conditions are detected.
 */

import { describe, expect, it } from "bun:test";
import {
	validateSpaceManifest,
	validateProjectManifest,
	validateClosure,
	validateLockFile,
} from "./validator.js";
import type { SpaceManifest, ProjectManifest, LockFile, SpaceKey } from "@agent-spaces/core";

describe("validateSpaceManifest", () => {
	it("should pass for valid manifest", () => {
		const manifest: SpaceManifest = {
			schema: 1,
			id: "my-space" as any,
			version: "1.0.0",
		};
		const result = validateSpaceManifest(manifest);
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	it("should fail for missing id", () => {
		const manifest = {
			schema: 1,
		} as SpaceManifest;
		const result = validateSpaceManifest(manifest);
		expect(result.valid).toBe(false);
		expect(result.errors.some(e => e.code === "E001")).toBe(true);
	});

	it("should fail for invalid space ref in deps", () => {
		const manifest: SpaceManifest = {
			schema: 1,
			id: "my-space" as any,
			deps: {
				spaces: ["invalid-ref" as any],
			},
		};
		const result = validateSpaceManifest(manifest);
		expect(result.valid).toBe(false);
		expect(result.errors.some(e => e.code === "E002")).toBe(true);
	});
});

describe("validateProjectManifest", () => {
	it("should pass for valid manifest", () => {
		const manifest: ProjectManifest = {
			schema: 1,
			targets: {
				default: {
					compose: ["space:my-space@stable" as any],
				},
			},
		};
		const result = validateProjectManifest(manifest);
		expect(result.valid).toBe(true);
	});

	it("should fail for empty targets", () => {
		const manifest: ProjectManifest = {
			schema: 1,
			targets: {},
		};
		const result = validateProjectManifest(manifest);
		expect(result.valid).toBe(false);
		expect(result.errors.some(e => e.code === "E010")).toBe(true);
	});

	it("should fail for empty compose", () => {
		const manifest: ProjectManifest = {
			schema: 1,
			targets: {
				default: {
					compose: [],
				},
			},
		};
		const result = validateProjectManifest(manifest);
		expect(result.valid).toBe(false);
		expect(result.errors.some(e => e.code === "E011")).toBe(true);
	});
});

describe("validateClosure", () => {
	it("should pass for valid closure", () => {
		const key = "my-space@abc123" as SpaceKey;
		const result = validateClosure({
			spaces: new Map([[key, {
				key,
				id: "my-space" as any,
				commit: "abc123" as any,
				path: "spaces/my-space",
				manifest: { schema: 1, id: "my-space" as any },
				resolvedFrom: { commit: "abc123" as any, selector: { kind: "dist-tag", tag: "stable" } },
				deps: [],
			}]]),
			loadOrder: [key],
			roots: [key],
		});
		expect(result.valid).toBe(true);
	});

	it("should fail when load order references missing space", () => {
		const result = validateClosure({
			spaces: new Map(),
			loadOrder: ["missing@abc123" as SpaceKey],
			roots: [],
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some(e => e.code === "E021")).toBe(true);
	});
});

describe("validateLockFile", () => {
	it("should pass for valid lock file", () => {
		const key = "my-space@abc123" as SpaceKey;
		const lock: LockFile = {
			lockfileVersion: 1,
			resolverVersion: 1,
			generatedAt: new Date().toISOString(),
			registry: { type: "git", url: "https://example.com/repo" },
			spaces: {
				[key]: {
					id: "my-space" as any,
					commit: "abc123" as any,
					path: "spaces/my-space",
					integrity: "sha256:abc123" as any,
					plugin: { name: "my-space" },
					deps: { spaces: [] },
				},
			},
			targets: {
				default: {
					compose: ["space:my-space@stable" as any],
					roots: [key],
					loadOrder: [key],
					envHash: "sha256:def456" as any,
				},
			},
		};
		const result = validateLockFile(lock);
		expect(result.valid).toBe(true);
	});

	it("should fail for unsupported version", () => {
		const lock = {
			lockfileVersion: 2,
			resolverVersion: 1,
			generatedAt: new Date().toISOString(),
			registry: { type: "git", url: "https://example.com/repo" },
			spaces: {},
			targets: {},
		} as unknown as LockFile;
		const result = validateLockFile(lock);
		expect(result.valid).toBe(false);
		expect(result.errors.some(e => e.code === "E030")).toBe(true);
	});
});
