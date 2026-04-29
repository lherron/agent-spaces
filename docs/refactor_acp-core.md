# acp-core Refactor Notes

## Purpose

`acp-core` is the pure domain package for ACP workflow contracts: task lifecycle and phase state, transition validation, evidence and waiver handling, role maps, workflow presets, interface delivery DTOs, admin DTOs, coordination message DTOs, job flow DTOs, and task-context hints. It intentionally contains no HTTP server, CLI command, database adapter, or gateway implementation; downstream packages import these shared types and small deterministic helpers.

## Public Surface

The package exports a single root module from `src/index.ts`.

- Task model: `Task`, `TaskLifecycleState`, `TaskStateRef`, `RiskClass`, `isPresetDrivenTask`, `toTaskStateRef`, `isLifecycleTarget`, `deriveLifecycleStateAfterTransition`, `applyTransitionDecision`.
- Actor model: `Actor`, `ActorStamp`, `ActorValidationError`, `parseActorFromHeaders`.
- Admin DTOs: `AdminAgent`, `AdminAgentStatus`, `AdminProject`, `AdminMembership`, `MembershipRole`, `InterfaceIdentity`, `SystemEvent`, `AgentHeartbeat`, `AgentHeartbeatStatus`.
- Evidence model: `EvidenceItem`, `EvidenceProducer`, `EvidenceBuild`, `EvidenceDetails`, `listEvidenceKinds`, `hasEvidenceKind`, `findMissingEvidenceKinds`, `isWaiverEvidence`, `getWaiverDetails`.
- Role maps: `RoleMap`, `getRoleAgentId`, `hasRoleAssignment`, `listAssignedRoles`.
- Presets: `Preset`, `PhaseGuidance`, `TransitionPolicyRule`, `DeepReadonly`, `deepFreeze`, `matchesRiskClass`, `findTransitionPolicyRule`, `listOutboundTransitionRules`, `codeDefectFastlaneV1`, `codeFeatureTddV1`, `getPreset`, `listPresets`.
- Transitions: `TransitionActor`, `TransitionRecord`, `LoggedTransitionRecord`, `TransitionDecision`, `TransitionRejection`, `TransitionRejectionCode`, `TransitionRequest`, `TransitionResult`, `normalizeTransitionActor`, `validateTransition`.
- Runtime/task tracking DTOs: `InputAttempt`, `Run`, `Session`.
- Interface delivery DTOs and helpers: `AttachmentKind`, `AttachmentRef`, `InterfaceMessageAttachment`, `InterfaceMessagePayload`, `DeliveryRequest`, `DeliveryRequestBody`, `DeliveryRequestStatus`, `DeliveryFailure`, `DeliveryTarget`, `InterfaceBinding`, `InterfaceBindingLookup`, `InterfaceBindingStatus`, `InterfaceSessionRef`, `InterfaceMessageSource`, `isTerminal`, `canAck`, `canFail`, `resolveBinding`.
- Conversation DTOs: `ConversationTurn`, `ConversationTurnRenderState`, `conversationTurnRenderStates`.
- Job DTOs: `Job`, `JobRun`, `JobRunStatus`, `JobFlow`, `JobFlowStep`, `BaseFlowStep`, `AgentFlowStep`, `ExecFlowStep`, `ExecStepResult`, `FlowNext`, `JobStepRun`, `JobStepRunPhase`, `JobStepRunStatus`, `StepExpectation`.
- Stores: `TaskStore`, `EvidenceStore`, `RoleAssignmentStore`, `TransitionLogStore`.
- Coordination messages: `CoordinationMessageInput`, `CoordinationMessageOptions`, `MessageParticipant` and variants, `messageParticipantKinds`.

There are no HTTP routes or CLI commands implemented in this package. HTTP handlers live in `packages/acp-server`, CLI commands live in `packages/acp-cli`, and persistence implementations live in packages such as `wrkq-lib`, `acp-state-store`, and ACP store packages.

## Internal Structure

- `src/index.ts` is the root barrel and defines the actual public API.
- `src/models/task.ts` holds lifecycle/phase helpers and applies accepted transition decisions back onto tasks.
- `src/validators/transition-policy.ts` is the main behavioral core: it selects matching preset rules, checks allowed roles, enforces separation-of-duties constraints, checks evidence and waivers, verifies optimistic versions, and produces `TransitionDecision` records.
- `src/models/preset.ts` defines preset and rule shapes plus `deepFreeze`, risk matching, and transition-rule lookup helpers.
- `src/presets/code_defect_fastlane.v1.ts` and `src/presets/code_feature_tdd.v1.ts` are the shipped immutable workflow presets; `src/presets/registry.ts` indexes them by `presetId@version`.
- `src/models/evidence.ts`, `src/models/role-map.ts`, `src/models/transition.ts`, `src/models/actor.ts`, `src/models/run.ts`, `src/models/session.ts`, `src/models/input-attempt.ts`, and `src/models/job.ts` define the domain DTOs and small helpers.
- `src/interface/*` defines gateway-facing attachment, binding, delivery request, delivery target, and inbound message source shapes.
- `src/conversation/turn.ts` defines conversation-turn DTOs and legal render-state names used by `acp-conversation`.
- `src/task-context.ts` renders phase guidance and required evidence hints for a task/role pair.
- `src/store/task-store.ts` defines storage interfaces only; concrete stores are in downstream packages.
- `src/admin.ts` and `src/coordination-messages.ts` define public DTOs used by admin and coordination handlers.
- `test/fixtures/in-memory-stores.ts` provides an in-memory workflow store used by this package's tests and, currently, by some `acp-server` tests via relative imports.

## Dependencies

Production dependency:

- `agent-scope`: provides `SessionRef` and `parseScopeRef` for delivery targets, coordination participants, jobs, and transition actor scope validation.

Development dependencies:

- `@types/bun`
- `typescript`

Tests run with Bun's built-in `bun:test`; no extra test framework dependency is declared. The package has generated `dist/` output and local `node_modules/` present in the working tree, but neither is tracked by git.

## Test Coverage

I counted 9 test files with 48 `test(...)` cases, plus one shared fixture file. Coverage is concentrated around transition validation, lifecycle/phase separation, preset immutability and registry lookup, actor parsing precedence, interface binding resolution, delivery terminal predicates, attachment serialization, task-context hint generation, and an in-memory workflow-store regression port.

Current gaps:

- `validateTransition` has waiver expiration and malformed-date logic in `src/validators/transition-policy.ts`, but the tests only cover valid waivers and mismatched waiver scope, not expired or unparsable `expiresAt`.
- `src/coordination-messages.ts`, the job flow DTOs in `src/models/job.ts`, and the admin DTOs in `src/admin.ts` are type-only surfaces with no runtime behavior to test here.
- `src/models/transition.ts` only exercises `normalizeTransitionActor` indirectly through a matching scope-ref path; there is no direct test for agent-id or role mismatches throwing.

## Recommended Refactors and Reductions

1. Merge duplicate actor parsing tests in `test/actor.test.ts` and `test/actor-precedence.test.ts`. Both files cover `parseActorFromHeaders` precedence and fallback behavior; keeping one expanded suite would reduce duplicated cases while preserving the JSON-header and invalid-kind assertions.

2. Add focused waiver edge tests for `isWaiverValidForMissingEvidence` through `validateTransition` in `test/transition-policy.test.ts`. The implementation in `src/validators/transition-policy.ts` explicitly rejects invalid `expiresAt` strings and expired waivers, but those branches are not asserted.

3. Cache waiver validation results inside `validateTransition` in `src/validators/transition-policy.ts`. The same `isWaiverValidForMissingEvidence` predicate is evaluated once while selecting `waivedRule` and again while computing `waivedEvidenceKinds`; the second pass can reuse the selected rule's missing-evidence decision.

4. Reduce repeated transition-policy entries in `src/presets/code_feature_tdd.v1.ts`. The two `refactor -> tested` rules differ only by `requiredEvidenceKinds`, and the three `accepted -> released` rules differ only by `requiredEvidenceKinds`; a small local helper for same-role/same-risk rules would make the preset easier to audit without changing the exported `Preset` shape.

5. Clarify the test-fixture boundary around `test/fixtures/in-memory-stores.ts`. `acp-server` tests import this fixture via `../../acp-core/test/fixtures/in-memory-stores.js`, which makes an internal test file an implicit cross-package API; move the shared fixture into a test helper package or duplicate the small setup locally in `acp-server`.

6. Review unused root exports from `src/index.ts`: repository-wide search outside `packages/acp-core` found no references to `ActorStamp`, `isPresetDrivenTask`, `hasRoleAssignment`, `listAssignedRoles`, `TransitionRequest`, `TransitionResult`, `CoordinationMessageInput`, `InterfaceMessagePayload`, `DeliveryRequestBody`, `canAck`, `canFail`, `resolveBinding`, `deepFreeze`, `findTransitionPolicyRule`, `listOutboundTransitionRules`, or `normalizeTransitionActor`. The package should either document these as intentional public API or stop exporting them.
