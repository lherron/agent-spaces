# acp-e2e Refactor Notes

## Purpose

`acp-e2e` is a private, test-only package that exercises ACP workflows through the real CLI and in-process ACP server stack. It seeds wrkq, coordination, interface, jobs, run, and input-attempt state into temporary SQLite or in-memory stores, then validates end-to-end behavior for task workflows, interface ingress/delivery, and JobFlow execution without launching real agent runtimes.

## Public surface

This package has no production library entrypoint and no package exports. Its package scripts are `build` (`rm -rf dist && tsc`), `typecheck` (`tsc --noEmit`), and `test` (`bun test`).

The e2e tests exercise these CLI commands:

- `task create`
- `task promote`
- `task show`
- `task evidence add`
- `task transition`
- `task transitions`

The e2e tests exercise these HTTP routes through `createAcpServer`:

- `POST /v1/sessions/launch`
- `POST /v1/interface/bindings`
- `GET /v1/interface/bindings`
- `POST /v1/interface/messages`
- `GET /v1/gateway/{gatewayId}/deliveries/stream`
- `POST /v1/gateway/deliveries/{id}/ack`
- `POST /v1/gateway/deliveries/{id}/fail`
- `POST /v1/admin/jobs`
- `POST /v1/admin/jobs/{jobId}/run`
- `GET /v1/job-runs/{jobRunId}`

The reusable test-local exports are `SeedStack`, `createSeedStack`, and `withSeedStack` from `test/fixtures/seed-stack.ts`; `RecordedLaunch`, `RecordingMockLauncher`, and `createRecordingMockLauncher` from `test/fixtures/mock-launcher.ts`; and `createBareWrkqBugTask` from `test/helpers/raw-wrkq-task.ts`.

## Internal structure

- `package.json` declares the package as private ESM and wires build, typecheck, and Bun test scripts.
- `tsconfig.json` builds declaration output only, with `rootDir` at the monorepo root so it can include the shared wrkq fixture at `../wrkq-lib/test/fixtures/seed-wrkq-db.ts`.
- `README.md` is a one-line note for the `code_defect_fastlane` MVP e2e.
- `test/fixtures/seed-stack.ts` creates the temporary wrkq, coordination, and interface stores; adapts `acp-cli` to an in-process `createAcpServer`; captures stdout/stderr and `process.exit`; supplies a default runtime resolver; and guarantees cleanup through `withSeedStack`.
- `test/fixtures/mock-launcher.ts` records `launchRoleScopedRun` calls and can synthesize assistant `message_end` events for interface delivery tests.
- `test/helpers/raw-wrkq-task.ts` creates a minimal raw wrkq bug task used by promotion coverage.
- `test/e2e-defect-fastlane.test.ts` covers `code_defect_fastlane` task creation, promotion, evidence, phase transitions, separation-of-duties rejection, coordination handoff/wake creation, session launch task context, HRC task environment variables, and system-prompt materialization.
- `test/e2e-code-feature-tdd.test.ts` covers the `code_feature_tdd` happy path from `scoped` through `released` and lifecycle completion.
- `test/e2e-interface.test.ts` covers interface bindings, thread-specific binding resolution, ingress dispatch, assistant delivery queuing, delivery streaming, and ack/fail state transitions.
- `test/jobflow-mvp.test.ts` covers agent-backed JobFlow sequence steps, result block parsing, required/equal result assertions, and `onFailure` handling.
- `test/jobflow-exec.test.ts` covers exec JobFlow steps, exit-code branching, mixed exec/agent flow behavior, and policy denial when `ACP_JOB_FLOW_EXEC_ENABLED` is unset. This file is present in the working tree but is not currently tracked by git.

## Dependencies

Production workspace dependencies are `acp-cli`, `acp-core`, `acp-jobs-store`, `acp-server`, `agent-scope`, `coordination-substrate`, `hrc-core`, `hrc-server`, `spaces-runtime`, and `wrkq-lib`. The tests also import `acp-interface-store` even though it is not listed in `package.json`, because `seed-stack.ts` opens an interface store directly. Dev dependencies are `@types/bun` and `typescript`.

Runtime APIs used by the tests include `bun:test`, `bun:sqlite`, Node `fs`, `os`, and `path`, the `wrkq-lib` actor/task/evidence/transition repositories, coordination-substrate event/handoff/wake queries, HRC CLI invocation building, and spaces-runtime system prompt materialization.

## Test coverage

There are 24 Bun tests across five test files: 9 in `e2e-defect-fastlane.test.ts`, 1 in `e2e-code-feature-tdd.test.ts`, 7 in `e2e-interface.test.ts`, 2 in `jobflow-mvp.test.ts`, and 3 in `jobflow-exec.test.ts`. Coverage is strongest around happy-path lifecycle transitions, role separation, interface ingress and delivery, and JobFlow result parsing/branching. Gaps visible from the current tests are malformed request payloads for interface routes, delivery ack/fail of missing or already-terminal delivery IDs, JobFlow timeout behavior, and failure cases for invalid transition evidence beyond the separation-of-duties check.

## Recommended refactors and reductions

1. Extract duplicated JobFlow harness helpers from `test/jobflow-mvp.test.ts` and `test/jobflow-exec.test.ts`. Both files define the same `RecordingInputAttemptStore`, `HeadlessHrcFixture`, `JobRunPayload`, `createHeadlessHrcDb`, `insertTerminalHrcRun`, `createTerminalFlowLauncher`, `createFlowJob`, `runJob`, and `getJobRun` scaffolding; moving those into a shared `test/helpers/jobflow.ts` would remove a large duplicated block and keep future JobFlow tests consistent.

2. Extract duplicated CLI task helpers from `test/e2e-code-feature-tdd.test.ts` and `test/e2e-defect-fastlane.test.ts`. Both files define local `CliResult`, `parseJson`, `expectSuccess`, `expectJsonSuccess`, `addEvidence`, and `transitionTask` helpers. A shared `test/helpers/acp-cli.ts` would reduce repeated command construction and make transition/evidence expectations easier to update.

3. Split `test/e2e-defect-fastlane.test.ts`, which is 768 lines and mixes workflow lifecycle, coordination side effects, session launch, HRC environment construction, and prompt materialization. Moving the generic setup functions (`createDefectFastlaneTask`, `promoteBareWrkqBugTask`, `createTaskAtRed`, `createTaskAtGreen`, `createTaskAtVerified`, `withTaskEnv`) into helpers would leave the file focused on assertions and make the runtime-intent coverage easier to find.

4. Move the interface route payload and request scaffolding in `test/e2e-interface.test.ts` into a test helper module. The file currently defines local DTO shapes plus `projectSessionRef`, `requestJson`, `createBinding`, `postInterfaceMessage`, and `queueAssistantDelivery` before the actual route tests; extracting those would reduce the file's setup section and clarify the boundary between route fixtures and route assertions.

5. Declare `acp-interface-store` explicitly in `package.json` or stop importing it directly from `test/fixtures/seed-stack.ts`. The package currently imports `openInterfaceStore` and `InterfaceStore` from `acp-interface-store`, but that workspace dependency is absent from `dependencies`, which makes the fixture depend on undeclared monorepo resolution.
