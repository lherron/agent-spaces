# Refactor sweep: agent-scope

## Purpose

`agent-scope` is the canonical addressing utility for Praesidium agent scopes and sessions. It validates, parses, formats, and normalizes canonical `ScopeRef` strings, shorthand `ScopeHandle` and `SessionHandle` strings, lane references, and resolved user input so downstream packages can share the same agent/project/task/role/session grammar.

## Public surface

The package exports a single module, `agent-scope`, via `packages/agent-scope/package.json`; Bun consumers load `src/index.ts`, while package imports use built `dist/index.js` and `dist/index.d.ts`. The root `packages/agent-scope/index.ts` re-exports `src/index.js` for local source imports.

Exported types:

- `ScopeKind`
- `ParsedScopeRef`
- `LaneRef`
- `SessionRef`
- `ResolvedScopeInput`

Exported constants:

- `TOKEN_PATTERN`
- `TOKEN_MIN_LENGTH`
- `TOKEN_MAX_LENGTH`

Exported functions:

- `parseScopeRef`, `formatScopeRef`, `validateScopeRef`, `ancestorScopeRefs`
- `normalizeLaneRef`, `validateLaneRef`
- `normalizeSessionRef`
- `parseScopeHandle`, `formatScopeHandle`, `validateScopeHandle`
- `parseSessionHandle`, `formatSessionHandle`
- `resolveScopeInput`

There are no HTTP routes or CLI commands in this package.

## Internal structure

- `src/types.ts` defines the shared token grammar constants and exported data shapes.
- `src/scope-ref.ts` implements the canonical `agent:<agentId>[:project:<projectId>...]` grammar, parsing, formatting, validation, and ancestor expansion.
- `src/lane-ref.ts` validates and normalizes `main` and `lane:<laneId>` references.
- `src/session-ref.ts` combines a canonical `scopeRef` with an optional lane input and returns a normalized `SessionRef`.
- `src/scope-handle.ts` parses and formats the human shorthand handle grammar, such as `alice@demo:t1/reviewer`.
- `src/session-handle.ts` extends scope handles with optional `~lane` suffixes.
- `src/input.ts` resolves user-facing input by accepting session handles, scope handles, or canonical scope refs and applying an optional default lane.
- `src/index.ts` is the package barrel.
- `src/__tests__/*.test.ts` cover scope refs, lane refs, session refs, scope handles, session handles, and input resolution.

## Dependencies

Production dependencies: none.

Development and test dependencies:

- `typescript` for build and typecheck.
- `@types/bun` for Bun runtime and test types.
- Bun's built-in `bun:test` runner for package tests.

Workspace consumers import this package from `acp-conversation`, `acp-core`, `acp-interface-store`, `acp-server`, `acp-state-store`, `coordination-substrate`, `hrcchat-cli`, `hrc-core`, `hrc-cli`, `hrc-server`, `cli`, and several e2e/test packages.

## Test coverage

The package has 4 test files and 125 passing tests:

- `scope-ref.test.ts` covers token grammar, all valid and invalid `ScopeRef` forms, lane validation, `normalizeSessionRef`, `ancestorScopeRefs`, and runtime checks for exported shapes.
- `scope-handle.test.ts` covers valid shorthand forms, invalid delimiters and characters, formatting, and round trips.
- `session-handle.test.ts` covers session handle parsing, formatting, invalid scope portions, and round trips.
- `input.test.ts` covers handle canonicalization, session-handle lanes, explicit default lanes, and invalid input.

Observed gap: `session-handle.test.ts` does not cover invalid lane suffixes after `~`, and `parseSessionHandle` currently accepts `alice~`, `alice~has space`, and `alice~lane:foo` by constructing invalid or double-prefixed lane refs.

## Recommended refactors and reductions

1. Validate the lane suffix in `parseSessionHandle`. In `packages/agent-scope/src/session-handle.ts`, lines 17-36 construct `lane:${laneId}` directly instead of calling `normalizeLaneRef` or `validateLaneRef` from `packages/agent-scope/src/lane-ref.ts`. This lets `parseSessionHandle('alice~')` return `lane:`, `parseSessionHandle('alice~has space')` return `lane:has space`, and `parseSessionHandle('alice~lane:foo')` return `lane:lane:foo`. Reuse `normalizeLaneRef` and add tests for empty, invalid-character, and already-prefixed suffixes.

2. Consolidate token validation. `validateToken` is duplicated in `packages/agent-scope/src/scope-ref.ts` and `packages/agent-scope/src/scope-handle.ts`, while `packages/agent-scope/src/lane-ref.ts` performs the same length and `TOKEN_PATTERN` checks inline. A small shared helper, for example `src/token.ts`, would reduce duplicated grammar enforcement and make future token rule changes one edit.

3. Split scope-handle parsing from validation once. `packages/agent-scope/src/scope-handle.ts` parses delimiters in both `validateScopeHandle` and `parseScopeHandle`, with `parseScopeHandle` first validating and then repeating the same splitting logic. Extracting a single internal parser that returns either parsed parts or an error would reduce duplication and keep delimiter behavior for `@`, `:`, and `/` synchronized.

No unused exported symbols, dead source files, oversized files, HTTP routes, or CLI entry points were found in the package source.
