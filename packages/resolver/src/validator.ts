/**
 * Resolution validation - detect structural errors.
 *
 * WHY: Validation catches configuration issues early.
 * This module focuses on errors (not warnings - those are in lint package).
 */

import type {
	SpaceKey,
	SpaceRefString,
	LockFile,
	SpaceManifest,
	ProjectManifest,
} from "@agent-spaces/core";
import {
	parseSpaceRef,
	isSpaceRefString,
	ConfigValidationError,
} from "@agent-spaces/core";
import { type ClosureResult, type ResolvedSpace } from "./closure.js";

/**
 * Validation error with details.
 */
export interface ValidationError {
	/** Error code */
	code: string;
	/** Human-readable message */
	message: string;
	/** Related space or target */
	subject?: string | undefined;
	/** Additional details */
	details?: Record<string, unknown> | undefined;
}

/**
 * Validation result.
 */
export interface ValidationResult {
	/** Whether validation passed */
	valid: boolean;
	/** Errors found */
	errors: ValidationError[];
}

/**
 * Validate a space manifest structure.
 */
export function validateSpaceManifest(manifest: SpaceManifest): ValidationResult {
	const errors: ValidationError[] = [];

	// Check required fields
	if (!manifest.id) {
		errors.push({
			code: "E001",
			message: "Space manifest missing required 'id' field",
		});
	}

	// Validate space refs in deps
	if (manifest.deps?.spaces) {
		for (const ref of manifest.deps.spaces) {
			if (!isSpaceRefString(ref)) {
				errors.push({
					code: "E002",
					message: `Invalid space reference: ${ref}`,
					subject: manifest.id,
				});
			} else {
				try {
					parseSpaceRef(ref);
				} catch (err) {
					errors.push({
						code: "E002",
						message: `Failed to parse space reference '${ref}': ${err instanceof Error ? err.message : String(err)}`,
						subject: manifest.id,
					});
				}
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * Validate a project manifest structure.
 */
export function validateProjectManifest(manifest: ProjectManifest): ValidationResult {
	const errors: ValidationError[] = [];

	// Check targets exist
	if (!manifest.targets || Object.keys(manifest.targets).length === 0) {
		errors.push({
			code: "E010",
			message: "Project manifest has no targets defined",
		});
	}

	// Validate each target
	for (const [name, target] of Object.entries(manifest.targets ?? {})) {
		// Check compose is non-empty
		if (!target.compose || target.compose.length === 0) {
			errors.push({
				code: "E011",
				message: `Target '${name}' has empty compose list`,
				subject: name,
			});
		}

		// Validate each compose ref
		for (const ref of target.compose ?? []) {
			if (!isSpaceRefString(ref)) {
				errors.push({
					code: "E012",
					message: `Target '${name}' has invalid space reference: ${ref}`,
					subject: name,
				});
			} else {
				try {
					parseSpaceRef(ref);
				} catch (err) {
					errors.push({
						code: "E012",
						message: `Target '${name}' failed to parse reference '${ref}': ${err instanceof Error ? err.message : String(err)}`,
						subject: name,
					});
				}
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * Validate a closure result for structural issues.
 */
export function validateClosure(closure: ClosureResult): ValidationResult {
	const errors: ValidationError[] = [];

	// Check all roots are in spaces
	for (const root of closure.roots) {
		if (!closure.spaces.has(root)) {
			errors.push({
				code: "E020",
				message: `Root space '${root}' not found in closure`,
				subject: root,
			});
		}
	}

	// Check all load order entries are in spaces
	for (const key of closure.loadOrder) {
		if (!closure.spaces.has(key)) {
			errors.push({
				code: "E021",
				message: `Load order entry '${key}' not found in closure`,
				subject: key,
			});
		}
	}

	// Check all deps are in spaces
	for (const [key, space] of closure.spaces) {
		for (const dep of space.deps) {
			if (!closure.spaces.has(dep)) {
				errors.push({
					code: "E022",
					message: `Dependency '${dep}' of space '${key}' not found in closure`,
					subject: key,
					details: { dependency: dep },
				});
			}
		}
	}

	// Check load order respects dependencies
	const loadOrderIndex = new Map<SpaceKey, number>();
	closure.loadOrder.forEach((key, index) => {
		loadOrderIndex.set(key, index);
	});

	for (const [key, space] of closure.spaces) {
		const keyIndex = loadOrderIndex.get(key);
		if (keyIndex === undefined) continue;

		for (const dep of space.deps) {
			const depIndex = loadOrderIndex.get(dep);
			if (depIndex === undefined) continue;

			if (depIndex >= keyIndex) {
				errors.push({
					code: "E023",
					message: `Dependency order violation: '${dep}' appears after '${key}' in load order`,
					subject: key,
					details: { dependency: dep, keyIndex, depIndex },
				});
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * Validate a lock file structure.
 */
export function validateLockFile(lock: LockFile): ValidationResult {
	const errors: ValidationError[] = [];

	// Check version
	if (lock.lockfileVersion !== 1) {
		errors.push({
			code: "E030",
			message: `Unsupported lock file version: ${lock.lockfileVersion}`,
		});
	}

	// Check all spaces in targets exist
	for (const [targetName, target] of Object.entries(lock.targets)) {
		for (const key of target.loadOrder) {
			if (!lock.spaces[key]) {
				errors.push({
					code: "E031",
					message: `Target '${targetName}' references missing space: ${key}`,
					subject: targetName,
					details: { missingSpace: key },
				});
			}
		}

		for (const key of target.roots) {
			if (!lock.spaces[key]) {
				errors.push({
					code: "E032",
					message: `Target '${targetName}' has missing root space: ${key}`,
					subject: targetName,
					details: { missingSpace: key },
				});
			}
		}
	}

	// Check deps reference valid spaces
	for (const [key, space] of Object.entries(lock.spaces)) {
		for (const dep of space.deps.spaces) {
			if (!lock.spaces[dep]) {
				errors.push({
					code: "E033",
					message: `Space '${key}' references missing dependency: ${dep}`,
					subject: key,
					details: { missingDependency: dep },
				});
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}
