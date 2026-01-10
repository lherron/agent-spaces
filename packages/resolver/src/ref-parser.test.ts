/**
 * Tests for ref-parser module.
 *
 * WHY: Reference parsing is fundamental to resolution.
 * These tests verify parsing and key building work correctly.
 */

import { describe, expect, it } from "bun:test";
import {
	parseSpaceRef,
	parseSelector,
	buildSpaceKey,
	parseSpaceKey,
	parseAllRefs,
	asSpaceId,
	asCommitSha,
} from "./ref-parser.js";

describe("parseSpaceRef", () => {
	it("should parse dist-tag selector", () => {
		const ref = parseSpaceRef("space:my-space@stable");
		expect(ref.id).toBe("my-space");
		expect(ref.selectorString).toBe("stable");
		expect(ref.selector.kind).toBe("dist-tag");
	});

	it("should parse exact semver selector", () => {
		const ref = parseSpaceRef("space:my-space@1.2.3");
		expect(ref.id).toBe("my-space");
		expect(ref.selectorString).toBe("1.2.3");
		expect(ref.selector.kind).toBe("semver");
		if (ref.selector.kind === "semver") {
			expect(ref.selector.exact).toBe(true);
		}
	});

	it("should parse semver range selector", () => {
		const ref = parseSpaceRef("space:my-space@^1.0.0");
		expect(ref.id).toBe("my-space");
		expect(ref.selectorString).toBe("^1.0.0");
		expect(ref.selector.kind).toBe("semver");
		if (ref.selector.kind === "semver") {
			expect(ref.selector.exact).toBe(false);
		}
	});

	it("should parse git-pin selector", () => {
		const ref = parseSpaceRef("space:my-space@git:abc123def456");
		expect(ref.id).toBe("my-space");
		expect(ref.selector.kind).toBe("git-pin");
		if (ref.selector.kind === "git-pin") {
			expect(ref.selector.sha).toBe("abc123def456");
		}
	});

	it("should throw on invalid format", () => {
		expect(() => parseSpaceRef("invalid")).toThrow();
		expect(() => parseSpaceRef("space:")).toThrow();
		expect(() => parseSpaceRef("space:@stable")).toThrow();
	});
});

describe("parseSelector", () => {
	it("should parse stable as dist-tag", () => {
		const sel = parseSelector("stable");
		expect(sel.kind).toBe("dist-tag");
		if (sel.kind === "dist-tag") {
			expect(sel.tag).toBe("stable");
		}
	});

	it("should parse caret range", () => {
		const sel = parseSelector("^1.2.3");
		expect(sel.kind).toBe("semver");
		if (sel.kind === "semver") {
			expect(sel.range).toBe("^1.2.3");
			expect(sel.exact).toBe(false);
		}
	});

	it("should parse tilde range", () => {
		const sel = parseSelector("~1.2.3");
		expect(sel.kind).toBe("semver");
		if (sel.kind === "semver") {
			expect(sel.range).toBe("~1.2.3");
			expect(sel.exact).toBe(false);
		}
	});

	it("should parse git pin", () => {
		const sel = parseSelector("git:abcdef1");
		expect(sel.kind).toBe("git-pin");
	});
});

describe("buildSpaceKey", () => {
	it("should build key from id and commit", () => {
		const id = asSpaceId("my-space");
		const commit = asCommitSha("abc123def456789012345678901234567890abcd");
		const key = buildSpaceKey(id, commit);
		expect(key).toBe("my-space@abc123def456");
	});
});

describe("parseSpaceKey", () => {
	it("should parse key into id and commit", () => {
		const key = "my-space@abc123def456" as any;
		const { id, commit } = parseSpaceKey(key);
		expect(id).toBe("my-space");
		expect(commit).toBe("abc123def456");
	});
});

describe("parseAllRefs", () => {
	it("should parse multiple refs", () => {
		const refs = parseAllRefs([
			"space:a@stable" as any,
			"space:b@^1.0.0" as any,
		]);
		expect(refs.length).toBe(2);
		expect(refs[0]?.id).toBe("a");
		expect(refs[1]?.id).toBe("b");
	});
});
