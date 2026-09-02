# Harness-broker evidence authority

**Law:** `agent-spaces.harness-broker-local-commit-observation` (`6d04d5de`)
**Spec:** `HARNESS_BROKER_OBSERVABILITY_PROPOSAL.md` §§6, 6.1, 7 (wrkq `T-07853`)
**Implemented by:** wrkq `T-07863` (observability Phase 0)

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
| `input-admission` | `input.accepted`, `input.queued`, `input.rejected` | the broker DECIDING what to do with a submission |
| `submission-disposition` | `submission.absorbed`, `submission.executed`, `submission.cancelled` | what the harness actually DID with it — a different owner from admission |
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

An unclassified native type in one of these **stops that invocation's
normalization cursor** until an operator disposition releases it. Everything
else still records a `blocked-unknown` disposition and emits
`capture.warning{kind:'blocked_unknown'}`, but does not halt — because the law
halts on an unclassified *load-bearing* type, and a type we cannot place in a
family cannot be asserted to be load-bearing.

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
| `conversation` | hook | **native** | native | hook | native | native |
| `tool` | hook | hook | native | hook | native | native |
| `usage` | native † | native † | native | hook † | native | native |
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
`submission.expired`, `admission.*`, `queue.*` and `interrupt.*` require
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
| `conversation` (hook) | `user.message` for a submission that entered context via the disposition mirror | session JSONL: the `remove` + `queued_command` attachment pair, or the plain `user` row |
| `turn-bracket` (hook) | `turn.started` for a drained submission; `turn.interrupted` from the `[Request interrupted by user]` row | session JSONL (T-07849 rev 10 items 3 and 5) |
| `diagnostic` (hook) | the API-failure `diagnostic` | session JSONL `assistant` row with `isApiErrorMessage:true` — it never arrives via a hook (T-05092) |
| `submission-disposition` (native) | `submission.executed` for an IDLE-path prompt | the `UserPromptSubmit` hook — an idle prompt skips the composer queue entirely, so no queue-operation evidence exists for it (T-07849 item 7) |

Claude session-JSONL rows arrive through either the read immediately preceding
a hook normalization or a native file-change notification (T-07849 rev 12).
Both enqueue onto one serialized drain chain and share one byte-offset tailer,
so the earlier intake point changes neither row order nor ownership and cannot
double-read a row. The file watcher arms lazily on the first hook after Claude
creates its SessionStart-named transcript; watcher loss gets one immediate
re-arm, then degrades the invocation loudly as `native_wakeup_lost` and refuses
preempt/interrupt rather than silently losing the no-successor terminal
(T-07849 rev 13). Hooks remain primary for the families the hook normalizer
produces; the transcript-primary target posture (§6) is still a Phase 4 cutover
rather than a relabelling.

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
  attachment subtypes, 4 queue operations. The later observed
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
| an `item` subtype NOT in the table, under a pinned item-carrying `event_msg` | `blocked-unknown` in `conversation` — **HALTS** |
| a row type, `event_msg` type or `response_item` type not in the table | `blocked-unknown` in `diagnostic` — warns, no halt |

The halt is narrow on purpose. The only rows we can ASSERT are load-bearing are
`item` subtypes whose parent is pinned: `item_completed` is where codex's
paginated history mode delivers `AgentMessage`, the terminal answer this reader
holds, so a renamed or added item type there silently costs assistant prose.
That is the codex analogue of Claude's unknown QUEUE OPERATION — a demonstrated
dependency, not a guess. Anything else in the rollout cannot be placed in a
family at all, and the law halts on an unclassified *load-bearing* type, so it
warns instead. Same reasoning as the hook-name precedent below.

Two entries are worth reading as deliberate:

- `agent_message_delta` / `agent_message_content_delta` are pinned even though
  the pinned source revision does not persist them, because the reader CONSUMES
  them. A type the normalizer acts on is known by construction, and leaving it
  out would halt the moment an older codex is on PATH.
- `exec_approval_request`, `apply_patch_approval_request`, `request_permissions`,
  `request_user_input` and `elicitation_request` are ABSENT, because
  `policy.rs::should_persist_event_msg` puts all five in the transient arm. The
  rollout carries no permission evidence at all — which is the source-side
  confirmation of the `permission` row below.

### Unknown HOOK names warn; they do not halt

An earlier revision of this work halted the cursor on a hook name outside a
driver's table, reasoning that the broker writes the harness's hook
configuration and so controls the set of names it can receive. **The first live
pi-tui-tmux session falsified that directly**: pi fired `before_agent_start` and
`message_start`, the cursor halted, and 135 raw records piled up behind a hook
the normalizer would simply have ignored.

A hook whose name the normalizer does not handle mints nothing, so there is no
evidence it is load-bearing — and the law halts on an unclassified *load-bearing*
type. Unknown hook names are therefore `blocked-unknown` with a
`capture.warning` and no halt. Unknown QUEUE OPERATIONS are the opposite case
and still halt: turn attribution demonstrably depends on them, which is the
example the law itself names.

The hook tables are still worth keeping accurate — a warning should mean
"something new", not "something the author failed to look up" — so
`PI_KNOWN_HOOK_NAMES` is now enumerated from a real capture rather than read off
the normalizer.

### A named risk: unknown Claude attachment subtypes do not halt

An attachment subtype outside the pinned set is attributed to `diagnostic`, so
it warns without halting. The attachment channel is overwhelmingly UI/session
metadata — 125 attachments in the first archived session, of which 5 were
`queued_command` — and new cosmetic subtypes appear between Claude releases
(`remote_session_change` shows up only in the third archived session). Halting a
whole runtime's capture on cosmetic noise would make the mechanism something
operators route around.

Absorption evidence going missing is still caught, and caught earlier: under
T-07849 rev 10 an unresolved `remove` that reaches a disposition boundary is
itself `blocked-unknown` in `submission-disposition`, which **does** halt. A
renamed absorption attachment therefore fails loudly through the mirror rather
than through this table. Unknown queue *operations* halt unconditionally.

## Operating a halt

```
harness-broker capture status  --socket <broker.sock> --invocation <id>
harness-broker capture release --socket <broker.sock> --invocation <id> \
  --raw-record <raw_000123> --disposition ignored-known --note "reviewed: cosmetic"
```

`--disposition normalized-as` additionally mints the event the broker could not
derive (`--event-type` / `--event-payload` / `--turn-id`); it is committed with
the blocked record's `rawRecordId` and `sourceKind: 'broker'`, because the
classification was an operator decision, not something the provider reported.

The seat keeps running while capture is halted. Only capture stops, and it stops
visibly: `snapshot.capture.state` is `blocked` and names the record.

## Changing this file

Changing a matrix cell is an authority cutover. It requires:

1. the code change that actually moves the evidence;
2. `scripts/capture-parity.ts` over real invocations for that driver, showing
   zero unexplained loss or duplication for the affected family;
3. the same edit in `src/drivers/evidence-authority.ts` — they are checked
   against each other by `test/capture/authority-matrix.test.ts`.
