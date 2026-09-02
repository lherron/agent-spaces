# Harness-broker evidence authority

**Law:** `agent-spaces.harness-broker-local-commit-observation` (`6d04d5de`)
**Spec:** `HARNESS_BROKER_OBSERVABILITY_PROPOSAL.md` §§6, 6.1, 7 (wrkq `T-07853`)
**Implemented by:** wrkq `T-07863` (observability Phase 0)
**Amended by:** wrkq `T-07883` — Lance operator ruling 2026-09-02: an
unclassified type warns loudly and the cursor advances; nothing halts.

> Authority is declared per **event family**, never once per provider.

This file is the published prose form of the code declaration
`Driver.evidenceAuthority` (`src/drivers/evidence-authority.ts`). The two must
agree: the code is what the broker enforces and publishes over `broker.hello`,
this file is what it means and what it costs.

Phase 0 **declares** the authority in force today. It cuts nothing over —
authority cutovers are Phases 2–5, and each one changes an entry here together
with the code that actually moves the evidence, plus a parity report showing
zero unexplained loss or duplication.

## Reading the matrix

| Value | Meaning |
| --- | --- |
| `native` | the provider's own transcript file or protocol stream owns the family |
| `hook` | a synchronous harness hook owns it |
| `broker` | it is a broker decision no provider can report |

Families are cut finer than the event-name prefixes on purpose, so that each
family has exactly **one truthful owner per driver**:

| Family | Event types | Why it is its own family |
| --- | --- | --- |
| `invocation-lifecycle` | `invocation.*`, `lifecycle.*` | broker-owned everywhere |
| `harness-lifecycle` | `harness.started`, `harness.exited`, `harness.recovery.*` | process facts, source varies by driver |
| `continuation` | `continuation.updated`, `continuation.cleared` | session identity, source varies |
| `input-admission` | `input.*`, `admission.*`, `queue.*`, `interrupt.*` | the broker DECIDING what to do with a submission |
| `submission-disposition` | `submission.*` | terminal submission outcomes — a different owner from admission |
| `turn-bracket` | `turn.started`, `turn.completed`, `turn.failed`, `turn.interrupted` | provider-observed turn boundaries |
| `turn-supervision` | `turn.stalled`, `turn.retry` | broker lifecycle policy; no provider reports these |
| `conversation` | `assistant.message.*`, `user.message` | model/user content |
| `tool` | `tool.call.*` | tool evidence |
| `usage` | `usage.updated` | token accounting |
| `permission` | `permission.*` | pre-execution gating |
| `diagnostic` | `diagnostic`, `driver.notice`, `capture.warning`, `capture.released` | non-load-bearing notices |
| `terminal-surface` | `terminal.surface.reported` | the broker allocates and reports the pane lease |
| `provider-artifact` | `provider.transcript.reported` | broker-authored pointer to a raw artifact |

Merging `input-admission` with `submission-disposition`, or `turn-supervision`
with `turn-bracket`, would force at least one driver to declare an authority it
does not have. That is the failure this taxonomy exists to prevent.

## Load-bearing families

`turn-bracket`, `conversation`, `tool`, `input-admission`,
`submission-disposition`, `permission`.

These are the families whose facts a consumer ACTS on. An unclassified native
type in one of them is the **loudest** capture warning the broker can raise — a
type we cannot place in a family at all cannot be asserted to be load-bearing,
so it takes the quieter class. That is the whole of what the taxonomy decides.

**It decides nothing about halting, because nothing halts.** Lance ruled on
2026-09-02 (wrkq `T-07883`, operator, direct):

> "We should never halt when an unknown event arrives. Harnesses are upgraded
> all the time; we don't want to hard-fail our entire fleet when we haven't
> handled an upgraded new event. It should warn loudly."

The ruling supersedes the halt clause of law 6d04d5de / `T-07849` rev 9 item 11
and the earlier text of this section. Every `blocked-unknown`, in every family,
now does exactly this and nothing more:

1. the raw record keeps its durable `blocked-unknown` disposition;
2. `capture.warning{kind:'blocked_unknown'}` is committed, carrying `family`,
   `loadBearing` and the verbatim native row (`cursorHalted` is retained on the
   payload and is always `false`);
3. ONE line at WARN goes to the broker process's own stderr — the seat's
   `bipc/<id>/broker.err` — rate-limited to one per exact
   `(driver, nativeType, family)` per invocation, with the repeat count in
   `snapshot.capture.blockedUnknown`;
4. **the cursor advances.**

`snapshot.capture.state` is always `open` and `deferredCount` always `0`. A halt
persisted in the SQLite index by a pre-ruling broker is cleared on load, logged
at WARN, and its held records normalize through the ordinary replay.

Why the halt went, in one paragraph: it was live for one night and fired three
times on real seats, every time on a KNOWN native type in an unhandled state —
a plain Claude user row arriving while a turn was active (a human typing into
the pane, a `wrkc` resend landing mid-turn) — never on a new type. Each seat
kept running while HRC saw it busy forever and mail queued behind it:
`clod@agent-spaces:T-07873` lost 28 minutes, `mable@hcs:primary` halted for 17
with 127 deferred records, two smoke seats halted until they were terminated.
Nothing reached an operator-readable log, so operators had to bypass HRC and
call `harness-broker capture release` on the bipc socket. This file already
records the same mistake once, under "Unknown HOOK names" below.

## The matrix

| Family | claude-code-tmux | codex-cli-tmux | codex-app-server | pi-tui-tmux | agent-harness-tmux | pi-sdk |
| --- | --- | --- | --- | --- | --- | --- |
| `invocation-lifecycle` | broker | broker | broker | broker | broker | broker |
| `harness-lifecycle` | hook | hook | broker | hook | native | broker |
| `continuation` | hook | hook | native | hook | native | native |
| `input-admission` | broker | broker | broker | broker | broker | broker |
| `submission-disposition` | **native** | broker † | broker † | broker † | broker † | broker † |
| `turn-bracket` | hook | hook | native | hook ‡ | native | **broker** ‡ |
| `turn-supervision` | broker | broker | broker | broker | broker | broker |
| `conversation` | **native** | **native** | native | hook | native | native |
| `tool` | **native** | hook | native | hook | native | native |
| `usage` | native | native † | native | hook † | native | native |
| `permission` | hook | hook | native | hook | native | native |
| `diagnostic` | hook | broker | native | broker | broker | broker |
| `terminal-surface` | broker | broker | broker | broker | broker | broker |
| `provider-artifact` | broker | broker | broker | broker | broker | broker |

† **Declared but not emitted today.** The value names the source that *would*
own the family, so a later cutover has a stated starting point. The parity
report shows zero events in these cells.

‡ **Pi's bounded accepted risk**, `agent-spaces.pi-delivery-asserted-turn-start`.
The manager authors the INITIAL `turn.started(source:'broker-delivery')` after a
blind pane delivery, and hooks correlate provider evidence into that bracket
without reminting it. For `pi-tui-tmux` that is one bracket among several — the
live parity report shows 3 hook-observed against 1 broker-authored — so the
family's primary is `hook` and the delivery-asserted bracket is the exception
below. `pi-sdk` has no hooks at all, so `broker` is its primary. Pi session JSONL
is non-authoritative for both until a separately approved evidence change.

## Disposition provenance: any source, never none

`submission.absorbed`, `submission.executed` and `submission.cancelled` REQUIRE
provenance and accept **any** `sourceKind`. `submission.rejected`,
`submission.expired`, `submission.withdrawn`, `admission.*`, `queue.*` and `interrupt.*` require
`sourceKind: 'broker'`.

The split is the point. A disposition reports what the harness *did* with a
submission, and the source of that fact varies by driver and by outcome:

- on an evidence driver, `absorbed`/`executed` are minted from the session JSONL
  and nothing else (T-07849 rev 11); on a headless driver they may be broker- or
  API-acknowledged;
- `cancelled{reason:'recalled'}` is the transcript `popAll` row (provider), while
  `cancelled{reason:'teardown'}` is broker lifecycle knowledge;
- an admission refusal or a TTL expiry has no provider behind it at all.

`submission.absorbed`/`executed`/`cancelled` were briefly broker-only, which
forced the emitter to overwrite a true record with a false one — falsifying the
very field this contract exists to make truthful. Ruled on wrkq T-07863 (pointer
on T-07860): the ledger must never carry a rewritten provenance. This is what
makes the `submission-disposition: native` cell honestly true for
claude-code-tmux.

## Exception matrix

A family's declared value names its **primary** owner. Where a specific event
type inside a family comes from the other source, it is named here rather than
smeared into a dishonest single value. These are the cells the parity report
should show as `both`.

### claude-code-tmux

| Family (declared) | Exception | Source of the exception |
| --- | --- | --- |
| `conversation` (native) | the turn's TERMINAL `assistant.message.completed` is flushed on the `Stop` hook | the hook is the synchronous CONTROL that says the turn is over; the event still names the `assistant` row that carried the prose. Claude writes a turn's closing `system` rows only AFTER the Stop hooks return, so no transcript row can end the message in time |
| `conversation` (native) | `assistant.message.completed` from `Stop.last_assistant_message` when the transcript held NOTHING at `Stop` | a turn that answered but whose prose the reader never saw would otherwise redden on HRC's `final_message_count`. Fires only when the transcript is empty for the turn — never as a second opinion |
| `tool` (native) | `tool.call.delta` | the `Notification` hook. The session JSONL has no in-progress tool vocabulary at all |
| `turn-bracket` (hook) | `turn.started` for a drained submission; `turn.interrupted` from the `[Request interrupted by user]` row | session JSONL (T-07849 rev 10 items 3 and 5) |
| `diagnostic` (hook) | the API-failure `diagnostic` | session JSONL `assistant` row with `isApiErrorMessage:true` — it never arrives via a hook (T-05092) |
| `submission-disposition` (native) | `submission.executed` for an IDLE-path prompt | the `UserPromptSubmit` hook — an idle prompt skips the composer queue entirely, so no queue-operation evidence exists for it (T-07849 item 7). Note the SPLIT after Phase 4: the disposition stays on the hook record, but the prompt's `user.message` is minted from the echoing `user` row, so `conversation` has no hook exception |

Claude session-JSONL rows arrive through either the read immediately preceding
a hook normalization or a native file-change notification (T-07849 rev 12).
Both enqueue onto one serialized drain chain and share one byte-offset tailer,
so the earlier intake point changes neither row order nor ownership and cannot
double-read a row. The file watcher arms lazily on the first hook after Claude
creates its SessionStart-named transcript; watcher loss gets one immediate
re-arm, then degrades the invocation loudly as `native_wakeup_lost` and refuses
preempt/interrupt rather than silently losing the no-successor terminal
(T-07849 rev 13). Since Phase 4 (T-07873) this driver IS the transcript-primary
posture §6 describes: `conversation`, `tool` and `usage` are minted from the
session JSONL, and `PreToolUse`/`PostToolUse`/`MessageDisplay` remain live
synchronous controls whose records reach the `duplicate` disposition
(`CLAUDE_TRANSCRIPT_OWNED_HOOK_FACTS`) rather than minting a second copy.

### codex-cli-tmux

| Family (declared) | Exception | Source of the exception |
| --- | --- | --- |
| `conversation` (native) | `user.message` | the `UserPromptSubmit` hook |

Assistant prose already comes from the rollout JSONL (the held-latest transcript
reader), which is why this driver is the doc's first broad cutover candidate
(Phase 3).

### pi-tui-tmux

| Family (declared) | Exception | Source of the exception |
| --- | --- | --- |
| `turn-bracket` (hook) | the INITIAL `turn.started(source:'broker-delivery')` | the broker manager, asserted at delivery — the bounded accepted risk `agent-spaces.pi-delivery-asserted-turn-start`. Every later bracket comes from pi's `turn_start`/`turn_end` hooks. |

### codex-app-server

| Family (declared) | Exception | Source of the exception |
| --- | --- | --- |
| `permission` (native) | `permission.resolved` | the BROKER (or its client) decides it, asynchronously, after the provider's request record is dispositioned. It carries `sourceKind: 'broker'` and names the committed request record it answers, so the audit pair stays followable both ways (T-07870) |
| `continuation` (native) | `continuation.updated` for the thread id | minted by the driver from the `thread/start` response, not read off a committed notification — `broker`, because no record backs it |
| `diagnostic` (native) | the stderr-line and lifecycle diagnostics | minted by the driver, not normalized from a notification — `broker` |

`permission.requested` IS native and now names its record: the server→client
JSON-RPC request frame is committed exactly like a notification and the ask is
minted from inside that record's normalization.

### agent-harness-tmux, pi-sdk

No exceptions. agent-harness reads a single native protocol stream; pi-sdk runs
in-process with no hook channel, so its delivery-asserted bracket is the whole
family.

**Named gap — neither driver is capture-wired.** They commit no raw records, so
under the provenance rule below their ledger events report `sourceKind: 'broker'`
rather than the `native` their declaration names. The declaration is unchanged
and still states where the evidence comes from; what is missing is a journal to
substantiate it, exactly as the `†` cells mark families that are declared but
not emitted.

## Provenance truthfulness: a provider claim must name a record

A `provider-*` `sourceKind` claims the provider's own transcript or protocol
stream reported the fact, and §7.1 makes the committed raw record the only thing
that can substantiate that claim. **An event that claims a provider source and
names no `rawRecordId` is unfalsifiable** — there is nothing on disk to open.
That is not hypothetical: it is how T-07868's in-memory-journal defect stayed
invisible under a green suite, and T-07868 shipped seven codex-app-server events
in exactly that state.

The rule is mechanical and cross-driver:

- any event whose `provenance.sourceKind` is `provider-*` MUST carry a
  `rawRecordId` naming a committed record;
- anything minted from a broker-side path carries `sourceKind: 'broker'`.

It is enforced at `buildEventExtra` — the one seam every event passes through —
so no driver can opt out, and a provider claim with no record is degraded to
`broker` with its `nativeType` and normalizer preserved. The degrade is a floor,
not a fix: `scripts/capture-parity.ts` FAILS a report that contains one (and one
that names a record the index does not hold), and
`test/capture/provenance-truthfulness.test.ts` drives every shipped driver's real
declaration through the seam.

## Native-type vocabularies

The tables that decide `ignored-known` vs `blocked-unknown` are
**behaviour-pinned, not documented APIs**:

- `src/drivers/claude-code-tmux/native-types.ts` — enumerated from the three
  archived live sessions on wrkq `T-07849`: 14 session-JSONL row types, 9
  attachment subtypes, 4 queue operations, and — added by Phase 4 — 3 `system`
  row SUBTYPES (`turn_duration`, `stop_hook_summary`, `bridge_status`), the
  `attachment:hook_blocking_error` subtype and the `Stop hook feedback:` user-row
  prefix, both found by the structured-output LIVE leg because only a blocked
  hook decision produces them. `system`
  and `cost-state` left the ignored set when they started minting; an unknown
  `system` subtype is a quieter-class warning, like any unknown row type. The
  later observed
  `attachment:hook_cancelled` is `ignored-known`; its raw detail preserves
  `{hookName, hookEvent, durationMs, timedOut}` and it mints no broker event.
  `test/capture/claude-native-type-
  coverage.test.ts` replays those real transcripts and asserts every row reaches
  a terminal disposition with zero warnings.
- `src/drivers/codex-cli-tmux/native-types.ts` — the ROLLOUT vocabulary, pinned
  under T-07870: 11 top-level row types, 25 `event_msg` payload types, 18
  `response_item` payload types and 19 `TurnItem` subtypes. Corpus-derived from
  six real codex-cli-tmux invocations (250 committed raw rows) plus the 1611
  archived rollouts under `~/.codex/sessions`, then SOURCE-confirmed against
  `~/tools/codex` @ `90ae0c4ef944bb80a3c725d15910289dfbb7db51` — in particular
  `codex-rs/rollout/src/policy.rs`, the filter that decides what reaches a
  rollout file at all. `test/capture/codex-native-type-coverage.test.ts` is the
  drift guard: it classifies all 87 pinned combinations with zero warnings, and
  replays every real corpus journal as an opt-in leg.
- `src/drivers/pi-tui-tmux/native-types.ts` — the hook names the broker
  registers for that harness.

### The Codex rollout disposition law

With the vocabulary pinned, a rollout row is dispositioned by this law rather
than being swept into `ignored-known`:

| Row | Disposition |
| --- | --- |
| consumed by the reader | `normalized` (it minted a fact) / `state-only` (it advanced held state) |
| pinned, deliberately not consumed | `ignored-known`, carrying its type in `detail` |
| an `item` subtype NOT in the table, under a pinned item-carrying `event_msg` | `blocked-unknown` in `conversation` — **loudest class** |
| a row type, `event_msg` type or `response_item` type not in the table | `blocked-unknown` in `diagnostic` — quieter class |

Both classes warn and advance; the family only says how loud. The load-bearing
attribution is narrow on purpose. The only rows we can ASSERT are load-bearing
are `item` subtypes whose parent is pinned: `item_completed` is where codex's
paginated history mode delivers `AgentMessage`, the terminal answer this reader
holds, so a renamed or added item type there silently costs assistant prose.
That is the codex analogue of Claude's unknown QUEUE OPERATION — a demonstrated
dependency, not a guess. Anything else in the rollout cannot be placed in a
family at all, so it takes the quieter class. Same reasoning as the hook-name
precedent below.

Two entries are worth reading as deliberate:

- `agent_message_delta` / `agent_message_content_delta` are pinned even though
  the pinned source revision does not persist them, because the reader CONSUMES
  them. A type the normalizer acts on is known by construction, and leaving it
  out would warn on every such row the moment an older codex is on PATH.
- `exec_approval_request`, `apply_patch_approval_request`, `request_permissions`,
  `request_user_input` and `elicitation_request` are ABSENT, because
  `policy.rs::should_persist_event_msg` puts all five in the transient arm. The
  rollout carries no permission evidence at all — which is the source-side
  confirmation of the `permission` row below.

### Unknown HOOK names are not load-bearing

An earlier revision of this work halted the cursor on a hook name outside a
driver's table, reasoning that the broker writes the harness's hook
configuration and so controls the set of names it can receive. **The first live
pi-tui-tmux session falsified that directly**: pi fired `before_agent_start` and
`message_start`, the cursor halted (as it then could), and 135 raw records piled
up behind a hook the normalizer would simply have ignored.

A hook whose name the normalizer does not handle mints nothing, so there is no
evidence it is load-bearing. Unknown hook names are therefore `blocked-unknown`
in `diagnostic`, the quieter class. Unknown QUEUE OPERATIONS are the opposite
case and take the loudest class: turn attribution demonstrably depends on them,
which is the example the law itself names.

This precedent is the narrow version of the general rule `T-07883` later made
fleet-wide: a piled-up queue behind an unhandled type is an outage, and no
family halts any more. Neither case stops the cursor; the difference is only how
loudly each is reported.

The hook tables are still worth keeping accurate — a warning should mean
"something new", not "something the author failed to look up" — so
`PI_KNOWN_HOOK_NAMES` is now enumerated from a real capture rather than read off
the normalizer.

### A named risk: unknown Claude attachment subtypes are the quieter class

An attachment subtype outside the pinned set is attributed to `diagnostic`. The
attachment channel is overwhelmingly UI/session metadata — 125 attachments in
the first archived session, of which 5 were `queued_command` — and new cosmetic
subtypes appear between Claude releases (`remote_session_change` shows up only
in the third archived session). Reporting cosmetic noise at the loudest level
would make the mechanism something operators learn to ignore.

Absorption evidence going missing is still caught, and caught earlier: under
T-07849 rev 10 an unresolved `remove` that reaches a disposition boundary is
itself `blocked-unknown` in `submission-disposition`, the loudest class. A
renamed absorption attachment therefore reports loudly through the mirror rather
than through this table.

## Phase 3: what the Codex rollout can and cannot own

Doc §6 names `codex-cli-tmux` "rollout-primary; first broad cutover candidate",
and Phase 3 is that cutover. With the vocabulary pinned, the candidate families
were measured against a real corpus rather than argued about. **Every one of them
stays `hook`**, each for its own reason, and this section is the record — an
honest non-promotion is a valid outcome, a silent partial promotion is not.

The corpus: six real codex-cli-tmux invocations on
`release-20260902024216362-98392` (idle prompt, tool call, permission approve,
permission deny, interrupt, multi-turn), 250 committed raw rows, artifacts under
`var/wrkq-artifacts/T-07870/corpus`. The source: `~/tools/codex` @
`90ae0c4ef944bb80a3c725d15910289dfbb7db51`.

| Family | Decision | The measured gap |
| --- | --- | --- |
| `turn-bracket` | stays `hook` | `event_msg:task_complete` for turn N is never in the reader's view at turn N's `Stop`; it is first read at turn N+1's `UserPromptSubmit`. Every invocation captured exactly (turns − 1) of them — the final turn's is missing 6/6. Promoting `turn.completed` loses one terminal per session and delays the rest by a whole idle period. |
| `tool` | stays `hook` | Two: (a) the rollout's tool identity is the model `call_id`, the hook's is `tool_use_id`, and they share no field — `permission` stays hook by contract and correlates on a HOOK id, so a rollout-primary `tool` severs the permission↔tool join; (b) `policy.rs` puts `ItemStarted`, `ExecCommandBegin` and `McpToolCallBegin` in the not-persisted arm, so the rollout has no tool-START event at all. |
| `harness-lifecycle` | stays `hook` | The rollout has a session-start row (`session_meta`) but no exit row: `ShutdownComplete` and `SessionConfigured` are both not-persisted. Promoting leaves `harness.exited` with no evidence. |
| `permission` | stays `hook` (contract) | Now source-confirmed: `ExecApprovalRequest`, `ApplyPatchApprovalRequest`, `RequestPermissions`, `RequestUserInput` and `ElicitationRequest` are ALL not-persisted. The rollout carries no permission evidence whatsoever, and the corpus agrees — zero permission rows across the approve and deny legs. |
| `continuation` | stays `hook` | `session_meta` carries `session_id` once at the head, which would serve `continuation.updated` — but `continuation.cleared` has no rollout row at all; it is minted from the synthetic `SessionEnd`. §13's condition ("the rollout carries the session/thread id on every row that needs it") is not met for the family. |

### The one prerequisite behind three of these: the reader has no wakeup

`turn-bracket`'s gap is not a vocabulary gap — the row IS on disk. An archived
rollout ends `task_started, task_complete`; codex writes the terminal row after
the `Stop` hook returns. **The rollout reader is woken only by hooks**, so it
never reads those bytes, and for the last turn of a session no later hook ever
comes.

That generalises: a rollout-carried fact can never be more timely than the hook
that triggers its read, because the hook IS the read. Under a hook-only wakeup,
rollout-primary is strictly worse than hook-primary for every family the hook
also carries — later at best, absent at worst — which is why this phase promotes
nothing rather than relabelling the same facts.

The unblocking change is a NATIVE wakeup for the rollout file, the shape
`claude-code-tmux` already has (T-07849 rev 12: a file-change notification
enqueued onto the same serialized drain chain as the hooks, with
`native_wakeup_lost` degradation when the watcher dies). It is deliberately out
of Phase 3's scope — §13's Phase 3 keeps the hook as the wakeup — and is named
here the way Phase 0 named the vocabulary pin: as the concrete prerequisite for
the next attempt, not as a note.

Useful side finding for whoever does it: rollout `turn_context.payload.turn_id`
is the SAME id the hooks carry, so the rollout is already turn-correlatable.

## Phase 4: what the Claude transcript can and cannot own

Doc §6 names `claude-code-tmux` "transcript-primary with an explicit hook
exception matrix", and Phase 4 (wrkq T-07873) is that cutover. The prerequisite
Phase 3 named for codex — a NATIVE wakeup, so a transcript fact does not have to
wait for a hook to trigger its read — this driver already has (T-07849 rev 12).
So unlike Phase 3, this phase promotes.

Corpus: the three archived T-07849 sessions (835 rows, 36 turns) plus a live
`claude-code-tmux` seat measured against its own raw ingress journal.

| Family | Decision | The deciding number |
| --- | --- | --- |
| `usage` | **promoted to native** | `message.usage` is on **155 of 155** `assistant` rows, all 155 with cache-creation/cache-read fields, plus `cost-state` roll-ups. The declaration said `native` from Phase 0 and the driver emitted NOTHING; this fulfils it. |
| `conversation` | **promoted to native** | The hook path delivered **1** `assistant.message.completed` for **25** assistant messages on a live seat, because `MessageDisplay` is one racing hook per message and `Stop` mints only the last. The rows are complete by construction. |
| `tool` | **promoted to native** | `tool_use`/`tool_result` pair **82/82** across the archive (49/49, 30/30, 3/3) and **17/17** live, 0 unpaired, 0 orphan — and the hook's `tool_use_id` IS the `tool_use` block id (**16/16** hook ids present in the JSONL on the first real session, 0 absent), so `permission` stays hook and still correlates onto a transcript-minted call. Decisive on the DENY path: a rejected tool call fires `PreToolUse` and **no `PostToolUse` at all** (1 and 0 in the live deny leg's journal), so the hook path had a tool start with no completion, while the transcript carries both and reports `isError:true, "User rejected tool use"`. |
| `turn-bracket` | **stays hook** | The transcript terminal is present for **33 of 36** turns (91.7%), **0 of 2** interrupted turns, and **2 of 3** no-successor final turns. Both promotion gates fail. |
| `permission` | stays hook | The session JSONL has **no permission vocabulary at all** — only the `permission-mode` UI latch row, which is the mode, not a request. The `PermissionRequest`/`PermissionResolved` hooks are the only evidence there is. |
| `harness-lifecycle` | stays hook | `SessionStart`/`SessionEnd` hooks; the transcript has no process-exit row. Promoting would leave `harness.exited` with no evidence. |
| `continuation` | stays hook | `sessionId` is on nearly every row and would serve `continuation.updated` — but `continuation.cleared` has NO transcript row; it is minted from the user-initiated `SessionEnd` reason. The family cannot move on half its vocabulary. |
| `diagnostic` | stays hook | `PreCompact`, `SubagentStart`/`Stop` and `Notification` are hook-only. The API-failure diagnostic remains the one transcript exception (T-05092). |
| structured output | can never be native | There is **no structured-output row in the session JSONL at all**. The enforcement is broker-synthesized on the `Stop` decision bridge: the driver validates `last_assistant_message` against the schema and, on the third failed attempt, mints `turn.failed` itself. Nothing the provider writes could carry that fact, so this is not a deferred promotion — it is a permanent broker responsibility. |

### Why `turn-bracket` stays: three independent reasons, one measurement

The rows EXIST — `system:turn_duration` (33) and `system:stop_hook_summary`
(33, carrying `stopReason` and `preventedContinuation`) — and Phase 4 now READS
and pins them. They are still not the primary:

1. **An interrupted turn mints no transcript terminal at all.** The abort lands
   as `isAbortedMidStream:true` on the `assistant` row with `stop_reason:null`,
   followed by a `user` row carrying `interruptedMessageId` and the
   `[Request interrupted by user]` text. No `turn_duration`, no
   `stop_hook_summary` — `Stop` never fires. **0 of 2** in the corpus.
2. **The no-successor final turn may have no terminal yet.** One of the three
   archived sessions ends on a submitted prompt whose terminal never arrived.
   **2 of 3.** That is the exact case §13's gate (c) asks about.
3. **The transcript terminal is written AFTER the hook terminal, by
   construction.** `stop_hook_summary` RECORDS the Stop hooks' own `durationMs`,
   so the row cannot exist until they have returned. Measured over the 33
   terminals: the broker's own Stop hook takes **min 57 / p50 68 / max 1085 ms**,
   and the last `assistant` row precedes the terminal row by **min 71 / p50 110
   / max 1171 ms** — before the tailer's own drain latency. A native terminal
   here is never earlier and usually later.

And the same measurement LIVE, on real seats, where the raw journal holds BOTH
sides as committed records (the `Stop` hook record and the `system` rows), so
the ordering is observed rather than inferred:

| leg | Stop hooks | `turn_duration` | prompts | terminals | final turn terminated | native observed AFTER hook, ms min/p50/max | native observed FIRST |
| --- | --- | --- | --- | --- | --- | --- | --- |
| idle-prompt | 2 | 2 | 2 | 2 | yes | 34 / 36 / 36 | 0 |
| queue-operation | 3 | 3 | 3 | 3 | yes | 23 / 31 / 34 | 0 |
| steer | 3 | 3 | 3 | 3 | yes | 28 / 31 / 31 | 0 |
| tool-approve | 2 | 2 | 2 | 2 | yes | 28 / 39 / 39 | 0 |
| tool-deny | 1 | 2 | 2 | 2 | yes | 28 / 28 / 28 | 0 |

**0 of 13 turns saw the transcript terminal first.** `tool-deny` shows 1 Stop
against 2 terminals because a DENIED turn ends as an interrupt, not a Stop —
which is the same asymmetry from the other side. Two more live paths where the
HOOK terminal is the one missing, recorded so the picture is honest in both
directions: an API-error turn writes `turn_duration` and fires no `Stop` at all,
and a denied-tool turn terminates through the transcript interrupt marker.
Neither lifts gate (a) or (c) — the interrupt path still has no transcript
terminal — but neither source is complete alone, and that is the real shape of
this family.

Two further facts from the same measurement, recorded because they would
otherwise look like coverage: `stopReason` is non-empty in **0 of 33** rows and
`preventedContinuation` is true in **0 of 33**, so the Stop-bridge controls
(structured-output cap → `turn.failed`, `preventedContinuation`) are not
exercised by the archive at all. The gate in §13 asks whether those controls can
be expressed over a NATIVE terminal without minting a second terminal; with the
terminal itself missing for the interrupt path, the question does not arise.

`isAbortedMidStream` and `interruptedMessageId` are read regardless: the
interrupt terminal's raw record now carries the id of the message it cut off,
and the partial prose is flushed as a NON-final `assistant.message.completed`
rather than being dropped.

### Two rows a blocked hook decision writes, and the stall they used to cause

The `Stop` DECISION bridge is the one hook the broker BLOCKS — that is how the
structured-output retry works. Blocking it makes Claude write TWO rows no
archived session contains, because no archived session ever blocked a hook:

| Row | What it is | Disposition |
| --- | --- | --- |
| `type:'user'` with string content beginning `Stop hook feedback:` | the block reason, fed back into the conversation | `ignored-known` — harness feedback about a BROKER decision, not an operator prompt and not model prose |
| `attachment:hook_blocking_error` | Claude's marker for the blocked hook, carrying `hookName`/`hookEvent`/`blockingError` | `ignored-known`, reason kept, `command` dropped (it carries socket paths), exactly as `hook_cancelled` |

The feedback row is an ordinary user row arriving while a turn is active, which
the disposition mirror correctly treats as a load-bearing anomaly — and while
that anomaly still halted the cursor it stalled the invocation, which is why the
first structured-output live leg never reached its cap. **Reproduced on
`release-20260902035322961-10808` (pre-Phase-4) with the identical two
warnings**, so it is a pre-existing defect this phase's leg surfaced rather than
a regression, and it is fixed here: `CLAUDE_STOP_HOOK_FEEDBACK_PREFIX` is pinned
as a behaviour string, the same shape of fact as the `[Request interrupted by
user]` marker the interrupt path already pins. The stall itself is gone
fleet-wide under `T-07883` — this row is a *correct disposition* on top of that,
because a correct disposition still beats a warning.

### The one thing a transcript-primary tool family costs

The transcript row is authored BEFORE the tool runs — the `tool_use` row's own
timestamp precedes the `PreToolUse` hook's arrival at the broker by ~55 ms — but
Claude flushes the JSONL in batches, so the broker OBSERVES the row later than
the hook: **p50 161 ms** later for the start and **p50 79 ms** for the
completion on a live seat, with a long tail (max ~9 s) when a batch is lumpy.
Promoting `tool` therefore buys completeness and a truthful record and costs
observation latency. It is named here rather than left for someone to discover:
a consumer that needs a tool-start the instant the tool starts should read the
`PreToolUse` hook record, which is still committed, still a duplicate, and still
the synchronous permission-decision bridge.

## Reading an unclassified type

```
harness-broker capture status --socket <broker.sock> --invocation <id>
tail -f <runtime>/bipc/<invocation>/broker.err | grep blocked_unknown
```

`capture status` reports `capture: open` plus one entry per distinct
`(driver, nativeType, family)` the invocation has seen unclassified, with its
repeat count and whether the family is load-bearing. The same facts are on the
event stream as `capture.warning{kind:'blocked_unknown'}` and on `broker.err` as
a single WARN line per key.

`harness-broker capture release` and `invocation.capture.release` are RETAINED
but are no-ops: no record blocks the cursor any more, so every release is
refused by naming that. They stay on the wire until the whole fleet is on a
broker that cannot halt, and are removed in a later cleanup.

## Changing this file

Changing a matrix cell is an authority cutover. It requires:

1. the code change that actually moves the evidence;
2. `scripts/capture-parity.ts` over real invocations for that driver, showing
   zero unexplained loss or duplication for the affected family;
3. the same edit in `src/drivers/evidence-authority.ts` — they are checked
   against each other by `test/capture/authority-matrix.test.ts`.
