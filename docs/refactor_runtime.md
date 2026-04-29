# Refactor Notes: runtime

## Purpose

`packages/runtime` publishes the harness-agnostic runtime contracts for Agent Spaces. It defines the unified session event model, session creation registry, harness adapter registry, context-template parser/resolver, and system-prompt materialization helper used by the CLI, execution layer, agent-spaces client, ACP server tests, and individual harness packages.

## Public surface

Package name: `spaces-runtime`.

Export map:

- `spaces-runtime`: main entrypoint, backed by `src/index.ts` for Bun and `dist/index.js` for normal ESM import.
- `spaces-runtime/harness`: harness registry subpath from `src/harness/index.ts`.
- `spaces-runtime/session`: session types and registry subpath from `src/session/index.ts`.

Main exported values and types:

- `HarnessRegistry` from `src/harness/registry.ts`.
- Session API from `src/session/index.ts`: `createSession`, `setSessionRegistry`, `SessionRegistry`, `SessionFactory`, `UnifiedSession`, `UnifiedSessionEvent`, `UnifiedSessionState`, `SessionKind`, `SessionCapabilities`, `SessionMetadataSnapshot`, `ContentBlock`, `Message`, `ToolResult`, `AttachmentRef`, `PromptOptions`, `SdkSessionIdEvent`, `PermissionHandler`, `PermissionRequest`, `PermissionResult`, `CreateSessionOptions`, `CodexApprovalPolicy`, and `CodexSandboxMode`.
- Context template API from `src/index.ts`: `parseContextTemplate`, `resolveContextTemplate`, `resolveContextTemplateDetailed`, `ContextTemplate`, `ContextResolverContext`, `ResolvedContext`, `ResolvedContextDetailed`, `ResolvedContextDiagnostics`, `ResolvedZoneDiagnostics`, and `ResolveContextTemplateOptions`.
- System prompt discovery/materialization API from `src/system-prompt.ts`: `discoverContextTemplate`, `discoverSystemPromptTemplate`, `materializeSystemPrompt`, `DiscoverContextTemplateInput`, `DiscoveredContextTemplate`, `DiscoveredTemplateSource`, `MaterializeResult`, `MaterializeSystemPromptInput`, and `TemplateDiscoveryProfile`.

The package exposes no HTTP routes or CLI commands directly. It is consumed by CLI packages and runtime launchers.

## Internal structure

- `src/index.ts` composes the main public export surface.
- `src/session/types.ts` defines the unified event, message, tool result, attachment, prompt option, capability, metadata, and session interfaces.
- `src/session/options.ts` defines `CreateSessionOptions`, including shared session fields and provider-specific options for Claude, Pi, and Codex.
- `src/session/registry.ts` maps `SessionKind` values to session factories; `src/session/factory.ts` stores the process-global registry used by `createSession`.
- `src/session/permissions.ts` defines the permission request/result/handler contract passed into sessions.
- `src/harness/registry.ts` stores harness adapters, supports lookup, duplicate protection, concurrent detection, and filtering to available adapters.
- `src/context-template.ts` parses schema version 2 TOML templates into separate prompt and reminder sections with section-level `when`, `max_chars`, file, inline, exec, and slot support.
- `src/context-resolver.ts` resolves parsed context templates against agent/project roots, run mode, scaffold packets, and agent profile data; it reads optional files, executes shell snippets, interpolates variables, truncates sections, and enforces global character budgets.
- `src/system-prompt.ts` discovers context templates from `agent-profile.toml`, `agentsRoot/context-template.toml`, or `ASP_HOME/context-template.toml`; falls back to a generated SOUL/additional-base/heartbeat/scaffold template; writes `system-prompt.md` and `session-reminder.md`.
- `src/system-prompt-template.ts` and `src/system-prompt-resolver.ts` contain the older schema version 1 parser/resolver for `[[section]]` system prompt templates. They are not exported by `src/index.ts` and are not referenced by other non-dist source files.
- `src/*.test.ts`, `src/session/registry.test.ts`, and `src/harness/registry.test.ts` cover parser, resolver, materialization, registry, and public cleanup contracts.

## Dependencies

Production dependencies declared in `packages/runtime/package.json`:

- `spaces-config`: supplies harness/config types, run-mode/scaffold types, `getAspHome`, and `resolveRootRelativeRef`.

Production dependencies imported but not declared by this package:

- `@iarna/toml`: imported by `src/context-template.ts`, `src/system-prompt-template.ts`, and `src/system-prompt.ts`. It is declared by other workspace packages, but `spaces-runtime` should declare direct runtime imports itself.

Node/Bun built-ins used at runtime:

- `node:child_process`, `node:fs`, `node:fs/promises`, `node:path`, and `node:util`.

Test/build dependencies declared:

- `@types/bun` for Bun test/runtime types.
- `typescript` for `tsc`.
- Bun's built-in `bun:test` runner is used by all test files.

## Test coverage

The package has 6 test files and 60 `test` cases:

- `src/harness/registry.test.ts` covers registration, duplicate IDs, lookup, detection errors, concurrent detection, available filtering, and clearing.
- `src/session/registry.test.ts` covers `createSession` dispatch through a configured `SessionRegistry`.
- `src/context-template.test.ts` covers schema version 2 parsing, prompt/reminder section separation, invalid schema and legacy section rejection, `max_chars`, slot `source`, and `when` predicates.
- `src/context-resolver.test.ts` covers prompt/reminder resolution, root-relative file refs, truncation, global character budget errors, `when.exists`, slots, interpolation, and skipped failed exec sections.
- `src/system-prompt.test.ts` covers materialization discovery order, built-in fallback behavior, task context environment injection, append mode, reminder output, and missing `SOUL.md`.
- `src/system-prompt-cleanup.test.ts` guards the canonical runtime entrypoint and verifies that the old `materializeSystemPromptV2` alias is not exported.

Gaps:

- `src/system-prompt-template.ts` and `src/system-prompt-resolver.ts` have no direct tests and are not exported; their only visible coverage is a negative materialization test that ignores legacy `system-prompt-template.toml`.
- `src/session/registry.ts` lacks direct tests for duplicate factory registration, missing factory errors, `get`, `getKinds`, and `clear`.
- `src/session/options.ts`, `src/session/types.ts`, and `src/session/permissions.ts` are type-contract files with no runtime behavior, so they are indirectly covered by TypeScript consumers rather than dedicated tests.

## Recommended refactors and reductions

1. Remove the legacy system prompt implementation if schema version 1 is no longer supported. `src/system-prompt-template.ts` and `src/system-prompt-resolver.ts` are unexported, untested, and not referenced by non-dist source. Deleting them would reduce duplicate parsing/resolution paths and align the package with `system-prompt.test.ts`, which verifies that legacy `system-prompt-template.toml` fallbacks are ignored.

2. If the legacy files must remain temporarily, extract shared parser utilities from `src/context-template.ts` and `src/system-prompt-template.ts`. Both files duplicate TOML parsing, schema/mode checks, section type validation, optional string/boolean/number parsing, `isRecord`, `isOneOf`, and `describeValue`.

3. If the legacy resolver must remain temporarily, extract shared resolver utilities from `src/context-resolver.ts` and `src/system-prompt-resolver.ts`. Both resolve root-relative refs, read optional files, execute shell commands with `bash -c`, join resolved content, and swallow exec failures. Keeping two copies increases the chance that v2 context behavior and legacy behavior diverge accidentally.

4. Add `@iarna/toml` to `packages/runtime/package.json` dependencies. `parseContextTemplate`, `parseSystemPromptTemplate`, and `loadTemplateDiscoveryProfile` import it directly, so relying on another workspace package to provide it makes `spaces-runtime` less self-contained.

5. Split provider-specific options out of `CreateSessionOptions` in `src/session/options.ts`. The interface currently mixes generic session fields with Claude/Pi/Codex-specific fields such as `providerModel`, `extensions`, `agentDir`, `codexHomeDir`, `codexApprovalPolicy`, and `eventsOutputPath`. A discriminated union keyed by `kind` would make unsupported combinations harder to pass and clarify which harness owns each option.

6. Make `when.exists` resolution explicit in `src/context-resolver.ts`. `matchesWhenPredicate` checks `existsSync(join(process.cwd(), section.when.exists))`, while the resolver context already carries `projectRoot`. Tests have to `process.chdir(projectRoot)` to make this work. Resolving against `context.projectRoot ?? process.cwd()` would reduce hidden global state and make callers easier to reason about.

7. Broaden `src/session/registry.test.ts` or add a dedicated registry test file for `SessionRegistry`. The class has duplicate registration, missing factory, `get`, `getKinds`, and `clear` behavior that mirrors `HarnessRegistry` but currently only receives indirect coverage through `createSession`.
