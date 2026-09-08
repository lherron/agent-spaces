# Codex desktop participation in ASP and HRC

Revision 1 — 2026-09-08. Status: APPROVED by Daedalus in EN-08387, room R-00071. No requested changes, conditions or public-contract changes.
Owner: Astra. Product authority: Lance. Implementation projects: agent-spaces and hrc-runtime.

## 1. Authorized outcome and verification boundary

An existing local Codex desktop conversation participates as Stella in the HRC fleet: it has a stable readable address, receives wrkc mail at a future turn through Codex's durable queue, and exposes recorded turns, messages, tool results and usage through existing HRC observation surfaces. Lance opens the conversations. Desktop retains ownership of its threads, execution, approvals and application lifecycle.

Lance approved a separate `codex-desktop` driver with shared Codex parsing/protocol internals. He explicitly excluded unattended desktop/thread birth, remote interruption, approval control, per-thread personas, and changes to the desktop binary. The installed desktop-bundled Codex executable is the only queue/helper executable; PATH's Codex is not a substitute.

Verification is limited to correctness, implementability and fit within these decisions. No public broker/HRC/wrkq wire-contract redesign, new federation mechanism, general external-participant platform, security/provenance expansion, feature flags or additional product controls are authorized. Existing generic driver-kind and metadata extension points carry the integration. A required public contract change or a rejection-driven scope expansion goes to Lance BEFORE revising the design. Daedalus commentary creates no obligations. Implementation-level corrections within scope are recorded in this document and the review thread.

## 2. Evidence and reuse

See `codex_desktop_queue_analysis.md` and the accompanying `codex-desktop-compatibility.md` for live readback. Desktop bundle on the observed host: `/Applications/ChatGPT.app/Contents/Resources/codex`, version 0.153.3; Codex home `/Users/lherron/.codex`. These are observed installation values, not hardcoded production paths.

The native queue supports add/list/delete and preserves caller `clientUserMessageId`. Desktop rollout `event_msg/item_completed` with `item.type=UserMessage` preserves it as `item.client_id` alongside thread_id and turn_id. `task_started`, `task_complete`, assistant items, tool results and usage provide durable observation. Queue add is not idempotent merely because the client ID is stable.

Reuse ASP's JSONL byte tailer, raw capture/normalization/replay machinery, Codex native vocabulary and assistant parsing. Extract reusable rollout processing from `drivers/codex-cli-tmux/hook-transcript.ts`; preserve the existing hook-driven CLI behavior. That reader currently emits assistant prose and uses Stop for final flush; it does not already derive every turn/tool/user event from JSONL. Add desktop-specific mappings for native turn boundaries, UserMessage attribution, recorded tool completions and usage. Do not fabricate transient tool starts, token deltas or approvals absent from persisted evidence.

Reuse `codex-app-server` input construction, RPC client and correlation concepts where independent of lifecycle. Do not reuse its startup/resume queue scrub, thread start/resume ownership, forced queue start after interruption or process teardown policy.

## 3. Integration shape and ownership

ASP implements a real broker driver, `codex-desktop`, with native source `provider-jsonl`, observed turn minting, queue-only admission and no steer/preempt/interrupt/desktop-stop capability. The driver is instantiated once per adopted thread by the normal durable broker engine. Existing broker methods, submission events, snapshots, replay and capabilities remain the public contract. Typed driver configuration is private to the new driver and supplied through the existing driver extension point; it includes resolved bundle executable, canonical Codex/SQLite home, native thread UUID and rollout path.

HRC provides a node-local internal desktop-registration handler and hook helper, using the existing internal callback transport/auth conventions. This is integration plumbing, not a new public operator API. HRC allocates identity, establishes ordinary placement on the node actually hosting desktop, and starts/reconnects the normal durable broker observation invocation. ASP must not infer node authority from paths. A conflicting established home is reported; it is never moved.

HRC retains external lifecycle ownership for the desktop thread. It can stop/restart its observer/helper and detach its broker connection; it cannot signal desktop, resume its thread in another server, scrub its queue, or birth a CLI replacement. Implement the private controller attachment needed for ordinary broker submission/seat observation on this externally owned thread. Reuse the existing lifecycle guard and mapper behavior, not generic EPR registration wholesale: current EPR creates random reg-* scopes and has a separate handshake/retention path. Its public schema, arbitrary participants and TTL semantics stay unchanged.

No second always-on service is required. The existing HRC daemon supervises desktop observers. HRC restart recovers durable mappings and observation/submission state; an observer restart is not proof that the desktop runtime ended. One desktop app-server may host many threads; thread identity, not app-server PID, partitions invocations.

## 4. Thread registration, readable scopes and migration

The registration key is `(local desktop installation/home identity, native thread UUID)`. HRC stores a durable unique mapping to Stella, project, readable scope, rollout path and integration runtime linkage. Installation identity resolves the real Codex home and effective SQLite home; helpers must use the same storage resolution as desktop. Binary version is compatibility metadata, not part of conversation identity.

SessionStart/startup or resume, with UserPromptSubmit as a fallback for already-loaded conversations, invokes the internal hook helper. The helper sends thread ID, transcript path and initial workspace. Registration validates against native session metadata and accepts only the main desktop conversation (originator/source), excluding guardian and other spawned subagents. No recursive adoption of archived session history. A conversation open before overlay installation registers on its next supported hook; installation reports that boundary. Merely clicking a sidebar thread is not claimed to emit a hook.

Resolve project using the existing registered-project/worktree-root resolver and explicit local project overrides, scoped to the workspace rather than an ancestor's unrelated `.env.local`. Persist it once. Subsequent cwd/title changes do not rename the scope or move its project. An unresolvable project leaves registration pending with a diagnostic, not a guessed project. This also addresses the already-filed desktop project-mismatch work (T-07514).

Assign `primary-<celestial-token>` in the existing ROSTER_SLOT_TOKENS order, excluding bare primary. Continue with `primary-<token>-2`, then -3, etc. The full address is, for example, `stella@hrc-ios:primary-nova`. Coordinate allocation under HRC's existing agent+project claim lock and a durable uniqueness constraint. The regular exact/suffix allocator must also respect desktop reservations. Reservations survive idle, detach, archival and observer restart; no other thread or launch may recycle them. Re-registering the same native key returns the same scope. No aliases derived from changing desktop titles.

The registration response supplies a local cached projection of the assigned scope and native key for hooks. All managed Praesidium command injections use it, including wrkc/wrkp (the current command allowlist is incomplete). The cache is not an independent allocator. Hooks have bounded callback time, spool discovery if HRC is down, and can use a previously established cache. Before first successful registration, retain the existing UUID-style hook behavior and clearly report integration pending; do not mint a friendly name locally. Once acknowledged, switch every managed hook to the one returned scope.

Migration never rewrites wrkq history or silently maps Cody into Stella. Existing UUID scopes are historical addresses; new registration records the previous computed address for diagnostics. Before cutover, enumerate unresolved envelopes to those addresses and expose them in the cutover report. They are not silently forwarded, acknowledged or reassigned. Normal future mail uses the registered Stella address. Do not rotate all existing desktop conversations or edit their titles.

## 5. Observation, recovery and availability

The driver serializes native rollout intake through the existing capture gate, commits source rows before projecting them, and uses the same normalizer for replay. Native thread/turn/item identity and source cursor prevent duplicate normalized events on restart or file replacement. Reconstruct parser state from committed history/checkpoints without emitting old events as new. Initial adoption may project history as history but must not present old mail or issue fresh runtime-lapse/reminder decisions for historical turns. The adoption watermark separates historical replay from new work.

`task_started` opens an observed turn; UserMessage with matching client_id attributes its queued broker input; `task_complete` closes it and flushes final prose; `turn_aborted` records interruption. Attribution may arrive after turn start and must not be guessed from the next turn or matching text. Human turns and desktop child-thread records cannot absorb a pending broker input. Record each assistant item once even where response_item mirrors item_completed. Completed tool records support recorded tool history; absent starts remain absent. Hook notifications are discovery/timeliness hints, not competing turn authority.

Persist and expose separately: observer connection/health, last native activity, observed turn state, queued submission status and desktop availability evidence. A quiet transcript proves neither process death nor a loaded idle thread. A helper process is not desktop liveness. File disappearance, replacement, archive or unreadability yields explicit reconciliation/degraded observation; silence never fabricates turn completion. Do not fail pending wrkq obligations merely because HRC/observer disconnected. A confirmed detach/terminal decision follows existing external lifecycle rules with its actual evidence and reason.

Bundled binary replacement invalidates helper compatibility; reconnect using the currently resolved bundle and verify the exercised protocol/schema again. Unsupported queue/rollout shapes disable delivery with a specific diagnostic; preserve raw readback. No fallback to a newer standalone CLI or direct SQLite writes.

## 6. Queue and mail semantics

Use the bundled binary as a short-lived stdio app-server helper initialized with experimental APIs and explicit desktop home. It performs queue operations only. It does not thread/start, thread/resume, turn/start, thread/queue/start, steer or interrupt the real desktop thread. The queue watcher in desktop starts loaded, eligible threads; unopened, unloaded and interrupted threads may wait indefinitely. No maximum delivery latency is promised.

Preserve broker/HRC write-ahead admission and origin.envelopeId. Before native enqueue, persist input/submission ID, clientUserMessageId, target native thread, envelope link, attempt state and observation watermark in broker-owned durable state. Use the broker input ID as clientUserMessageId, retaining the provider queue submission ID when returned. One unresolved native write per thread simplifies reconciliation; later broker inputs remain queued locally. This bounds the Codex native queue impact without excluding multiple waiting mails.

Native add ACK means queued, never presented. A matching native UserMessage in a new turn produces the existing correlated broker execution event; HRC's current landing handler then records the presentation receipt. Reply-is-ack remains wrkq's law. Fleet views consume ordinary normalized events and existing diagnostics rather than a new public event protocol.

After a timeout/disconnect/crash near add: search all queue/list pages for clientUserMessageId and scan committed/new rollout evidence. Found in queue => retain that submission, no add. Found in rollout => reconcile the existing executed submission, no add. Found in neither after a possibly-written attempt => retain indeterminate state and block automatic resend; absence is not proof of no delivery. Retry automatically only on a proven pre-write failure or definitive rejection with no native insert. No exactly-once claim across Codex's own start/delete crash window.

Once handed to Codex, an admission TTL, withdrawal or observer failure must not cause HRC's generic nonlanding retry to enqueue another copy. Retain the native-attempt reconciliation fence even if an outer submission becomes terminal. Delete only an integration-owned pending queue ID when cancellation is required and possible; reconcile a delete/start race against native history. Queue disappearance alone proves neither cancellation nor execution. Terminal wrkq mail never receives a new presentation receipt; if its body nevertheless started in a race, retain the observed execution fact and report it without reviving the envelope. Do not delete/reorder/edit human queue entries.

Desktop unavailability leaves work pending under its registered address; suppress ordinary cold-birth fallback for reserved desktop scopes, including after observer/runtime detach. No explicit queue/start after interruption. Existing wrkq expiry/withdrawal remains authoritative; this integration does not add deadlines or auto-ack policies.

## 7. Validation and rollout gates

Real bundled-server calls precede fixtures. Compatibility evidence is checked in with this proposal; model-backed probes are bounded and carry no code-changing work. Production feature tests must use the installed desktop binary, a Lance-opened desktop conversation and real HRC/wrkc configuration. Synthetic tests supplement, not replace, that surface.

Required cases: live queue client-ID correlation and reply; human turn before queued turn; two threads in one project; simultaneous duplicate registration; more than ten names; reopen retaining address; project/worktree-root correctness; exclude guardian; HRC/observer restart before ACK and after landing; partial JSONL/replacement; explicit queue rejection; queue ACK lost; interrupted/unloaded waiting; envelope expiry/withdraw versus start; bundle mismatch; no desktop process termination and no CLI cold birth. Exercise existing Codex headless/TUI smokes for shared parsing changes. Required broker MATRIX runs use a real Ghostty/ghostmux terminal per repository instructions.

Final rollout uses source-controlled overlay changes and `just overlay-codex`, retaining unmanaged desktop config and skills. Public contracts stay unchanged. Follow build_deploy_guide.md, commit/push before main install, coherent ASP→HRC producer sequence and installed/running readback. No ACP producer advancement is necessary for this local HRC/ASP integration. Record old-address unresolved mail before activating the hook cutover and show the new readable address from the real desktop conversation.

## 8. Work sequence

A. agent-spaces: shared rollout extraction plus separate desktop observation driver. Prove actual native evidence and replay without outbound delivery.
B. hrc-runtime: permanent registration/naming, local hook callback bridge, normal broker attachment with external thread ownership, reserved-scope no-birth behavior. Implement against the private configuration in §3. Can progress alongside A after this contract is approved; final integration waits for A.
C. agent-spaces: bundled queue helper and durable native-attempt reconciliation in the desktop driver. Depends on A. Prove ambiguous writes and late attribution.
D. hrc-runtime: mail routing/landing/recovery, install hook plumbing and produce the desktop scope cache. Depends on A, B and C. Include required agent-spaces overlay source edits as coordinated cross-repo integration in this task; one worker owns the cutover so producer versions and hook behavior agree.

D performs installed end-to-end grading before the campaign completes. No implementation starts before architecture verification. Campaign/task filing follows verification. Implementation dispatch is a separate next action; this preparation does not silently launch workers.

## Filing record (not a design amendment)

Campaign: P-00502 `agent-spaces/codex-desktop-fleet`.

| Leg | Task | Project | Prerequisites |
| --- | --- | --- | --- |
| A | T-08293 codex-desktop-observation | agent-spaces | Approved design |
| B | T-08294 codex-desktop-registration | hrc-runtime | Approved design; consumes A for final attachment proof |
| C | T-08295 codex-desktop-queue-recovery | agent-spaces | A |
| D | T-08296 codex-desktop-mail-cutover | hrc-runtime, coordinated ASP overlay edits | A, B, C |

Review: APPROVE EN-08387 in R-00071. Source design 8159a01; additional hook evidence a7996b3. No rejection, scope expansion or public contract amendment. Tasks are specified and dependency-linked, not implementation-dispatched. The existing project-mismatch issue T-07514 is related to D and remains open pending actual fix validation.
