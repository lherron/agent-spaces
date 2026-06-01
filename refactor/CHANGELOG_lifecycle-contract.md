# Changelog: Broker Lifecycle Contract Updates

Date: 2026-05-31

## Summary

Updated the `agent-spaces/refactor` contract/spec documents to incorporate the approved three-policy broker lifecycle contract:

1. `RuntimeRetentionPolicy` — HRC-owned runtime retention policy, broker-implemented.
2. `HarnessRecoveryPolicy` — broker-owned child/generation recovery mechanics, parameterized by HRC policy.
3. `TurnRetryPolicy` — separate semantic replay policy, defaulting to `none` and allowed only under explicit safe-retry predicates.

The central contract change is that lifecycle policy is now a typed `BrokerLifecyclePolicyOverlay` on `InvocationDispatchRequest`. It remains outside `HarnessInvocationSpec`, outside `InvocationStartRequest`, outside compiled profile material, and outside `startRequestHash`. It has a separate HRC-owned policy hash/persistence record.

## Files changed

### `FINAL_CONTRACTS.md`

- Clarified HRC/broker ownership boundaries:
  - HRC owns runtime/container/broker lifecycle, concrete tmux leases, durable state, reconciliation, and hard reap.
  - Harness Broker owns live harness-child execution below the broker boundary, including driver-private retire/recycle mechanics and generation/attempt emission.
- Added `BrokerLifecyclePolicyOverlay` to broker dispatch/start flow as an HRC-owned overlay.
- Preserved compiler closure: HRC may not write lifecycle policy into `HarnessInvocationSpec`, `InvocationStartRequest`, compiled profiles, or `startRequestHash` material.
- Added separate lifecycle policy hashing/persistence semantics via `lifecyclePolicyHash` / `lifecycle_policy_hash`.
- Added lifecycle event families: `lifecycle.policy.accepted`, `lifecycle.escalation`, `harness.started`, `harness.exited`, `harness.recovery.*`, `turn.stalled`, `turn.retry`, and `permission.cancelled`.
- Added generation/attempt projection rules for `harnessGeneration` and `turnAttempt`.
- Added permission fencing rules and clarified that cancellation is represented by `permission.cancelled`, not by adding `cancelled` to the `allow | deny` decision domain.
- Added driver SPI expectations for lifecycle capabilities, including real `retire()` semantics for idle TTL and `recover()`/runner-control semantics for child recycle.
- Added lifecycle flows for idle self-retire, harness recovery without retry, and guarded turn retry.
- Added persistence tables/columns for lifecycle policy, harness generations, turn attempts, terminal reasons, and generation-aware permission decisions.
- Added acceptance checks for lifecycle overlay hashing, idle TTL projection, generation fencing, permission cancellation, and retry fail-closed behavior.

### `FINAL_DATATYPES.md`

- Added lifecycle schema/version, IDs, hashes, policies, capabilities, runtime state, and dispatch overlay DTOs.
- Added `lifecyclePolicy?: BrokerLifecyclePolicyOverlay` to `InvocationDispatchRequest`, controller inputs, route decisions, runtime operations, and ASPC compile-and-start dispatch overlays.
- Added accepted lifecycle policy reporting to `InvocationStartResponse`.
- Added `harnessGeneration` and `turnAttempt` to event envelopes and relevant event payloads.
- Added lifecycle/harness/recovery/retry event payloads.
- Added `permission.cancelled` and generation-aware permission request/response/decision DTOs.
- Added broker runtime state fields for lifecycle policy hash, current harness generation, and current turn attempt.
- Added persistence records for broker harness generations and broker turn attempts.
- Added lifecycle-specific runtime control error codes.
- Standardized `HarnessRecoveryPolicy` around `none`, `fail-and-escalate`, and `recycle-child`; removed the weaker `observe` policy shape from the normative datatypes.

### `AGENT_RUNTIME_CONTRACT_PLANE_SPEC.md`

- Added closed architecture decision AD-011 for the three-policy lifecycle model.
- Updated the contract triangle and ownership matrix for HRC-owned hard-reap/container authority versus broker-owned live harness-child mechanics.
- Added lifecycle capability negotiation and reject-on-unsupported policy semantics.
- Updated broker start flow to pass `InvocationDispatchRequest { startRequest, dispatchEnv?, runtime?, lifecyclePolicy? }`.
- Added lifecycle state, event families, generation/attempt fences, permission cancellation, and lifecycle persistence requirements.
- Added §12.5 defining the lifecycle policy contract and its separation from input policy and continuation policy.
- Updated boundary checks to allow HRC dispatch-overlay assembly while still forbidding compiled-mechanics mutation.
- Updated route-catalog guidance with a safe lifecycle baseline for tmux broker routes.

### `RUNTIME_CONFIGURATION_CATALOG.md`

- Updated date to 2026-05-31.
- Added a lifecycle certification baseline table for broker tmux routes, `codex-app-server`, embedded SDK routes, and legacy routes.
- Added coverage gaps for lifecycle overlay smoke, idle-retire certification, harness-generation certification, and guarded retry certification.
- Updated maintenance rules to require lifecycle capability tests whenever route lifecycle support changes.

### `PROPOSAL_harness-lifecycle.md`

- Replaced the original proposal with the approved rewritten proposal.
- Marked the proposal as incorporated into the current specs.
- Aligned proposal vocabulary with the normative contract: `BrokerLifecyclePolicyOverlay`, separate `lifecyclePolicyHash`, `fail-and-escalate`, `maxGenerationsPerInvocation`, `permission.cancelled`, and default `turnRetry.none`.

## Consistency fixes made while editing

- Removed stale normative references to HRC writing `spec.lifecycle` or `spec.turnPolicy.stall` into the hashed compiled start spec.
- Removed stale normative references to `InvocationDispatchRequest { startRequest, dispatchEnv?, runtime? }` from current specs and replaced them with the lifecycle-aware envelope where applicable.
- Removed lifecycle fallback/downgrade ambiguity: unsupported lifecycle policy is a typed start rejection; silent downgrade is forbidden.
- Avoided adding lifecycle or generation fields to `invocation.started`; lifecycle policy acceptance and child generation now use separate events.
- Fixed permission cancellation semantics so `PermissionResolvedPayload.decision` remains `allow | deny` and stale/generation-ended requests use `permission.cancelled`.
- Replaced the storage primary key for permission decisions with a stable `permission_identity_key` plus a uniqueness constraint over `(invocation_id, harness_generation, turn_attempt, permission_request_id)` to avoid collisions across recycled harness generations.
- Ensured lifecycle policy audit data is stored as policy material, not compiler-closure evidence.

## Deferred implementation implications captured by the specs

- Existing tmux driver `stop()` behavior is not sufficient for `idle-ttl`; drivers must implement real retire semantics before advertising that capability.
- Child recycle requires process-tree/foreground-process control, runner status or equivalent health probing, hook socket rotation/fencing, and stale event filtering.
- Automatic retry remains disabled unless the driver can prove all safe-retry predicates, including no observed tool call, permission request, assistant finalization, external mutation, or continuation advancement from the failed attempt.
