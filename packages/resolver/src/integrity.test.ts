/**
 * Tests for integrity module.
 *
 * WHY: Integrity hashing ensures space content verification.
 * These tests verify the hash computation algorithms.
 */

import { describe, expect, it } from "bun:test";
import { computeEnvHash } from "./integrity.js";
import type { Sha256Integrity } from "@agent-spaces/core";

describe("computeEnvHash", () => {
	it("should compute consistent hash for same input", () => {
		const input = [
			{
				spaceKey: "space-a@abc123",
				integrity: "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Sha256Integrity,
				pluginName: "space-a",
			},
			{
				spaceKey: "space-b@def456",
				integrity: "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Sha256Integrity,
				pluginName: "space-b",
			},
		];

		const hash1 = computeEnvHash(input);
		const hash2 = computeEnvHash(input);

		expect(hash1).toBe(hash2);
		expect(hash1.startsWith("sha256:")).toBe(true);
		expect(hash1.length).toBe(7 + 64); // "sha256:" + 64 hex chars
	});

	it("should produce different hash for different input", () => {
		const input1 = [{
			spaceKey: "space-a@abc123",
			integrity: "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Sha256Integrity,
			pluginName: "space-a",
		}];

		const input2 = [{
			spaceKey: "space-a@abc123",
			integrity: "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Sha256Integrity,
			pluginName: "space-b", // different plugin name
		}];

		const hash1 = computeEnvHash(input1);
		const hash2 = computeEnvHash(input2);

		expect(hash1).not.toBe(hash2);
	});

	it("should produce different hash for different order", () => {
		const a = {
			spaceKey: "space-a@abc123",
			integrity: "sha256:1111111111111111111111111111111111111111111111111111111111111111" as Sha256Integrity,
			pluginName: "space-a",
		};
		const b = {
			spaceKey: "space-b@def456",
			integrity: "sha256:2222222222222222222222222222222222222222222222222222222222222222" as Sha256Integrity,
			pluginName: "space-b",
		};

		const hash1 = computeEnvHash([a, b]);
		const hash2 = computeEnvHash([b, a]);

		expect(hash1).not.toBe(hash2);
	});

	it("should handle empty input", () => {
		const hash = computeEnvHash([]);
		expect(hash.startsWith("sha256:")).toBe(true);
	});
});
