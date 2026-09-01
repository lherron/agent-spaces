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

Every Claude event ARRIVES through a hook — the session-JSONL reader is a
hook-driven byte-offset tail, so no hook means no transcript read. That is why
`hook` is the primary for the families the hook normalizer produces, and it is
also why the doc's target posture (transcript-primary, §6) is a Phase 4 cutover
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

### codex-app-server, agent-harness-tmux, pi-sdk

No exceptions. app-server and agent-harness read a single native protocol
stream; pi-sdk runs in-process with no hook channel, so its delivery-asserted
bracket is the whole family.

## Native-type vocabularies

The tables that decide `ignored-known` vs `blocked-unknown` are
**behaviour-pinned, not documented APIs**:

- `src/drivers/claude-code-tmux/native-types.ts` — enumerated from the three
  archived live sessions on wrkq `T-07849`: 14 session-JSONL row types, 9
  attachment subtypes, 4 queue operations. `test/capture/claude-native-type-
  coverage.test.ts` replays those real transcripts and asserts every row reaches
  a terminal disposition with zero warnings.
- `src/drivers/codex-cli-tmux/native-types.ts`,
  `src/drivers/pi-tui-tmux/native-types.ts` — the hook names the broker
  registers for each harness.

### A named gap: the Codex rollout vocabulary is not pinned yet

`claude-code-tmux`'s native-type table was enumerated from three archived real
sessions, so it can tell "reviewed and intentionally ignored" apart from "new,
and therefore suspect". **codex-cli-tmux has no such archive.** Its rollout rows
are now captured verbatim with cursors and dispositions, but a row the reader
does not consume is dispositioned `ignored-known` (carrying its type in
`detail`), never `blocked-unknown`.

This is deliberate and it is a gap, not a design: inventing a known-types table
for a vocabulary nobody has enumerated would either halt real sessions on
ordinary rows, or — worse — give a false assurance of completeness. Capturing
every row is what makes the table derivable, so pinning it from real captures is
the concrete prerequisite for the Phase 3 Codex CLI authority cutover, alongside
that phase's own parity requirement.

`pi-tui-tmux` has no transcript reader at all (hooks only, by the accepted risk
above), so it has no equivalent gap.

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
