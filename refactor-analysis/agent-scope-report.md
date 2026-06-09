# Refactor analysis — `agent-scope`

## Summary

`agent-scope` is a small, pure-logic **leaf** package (no workspace deps, no I/O, no
concurrency): the canonical grammar for semantic agent-session addressing
(ScopeRef / ScopeHandle / SessionRef / SessionHandle / LaneRef). 8 non-test source
files + 5 test files, 179 passing assertions. It is the declared "canonical upstream
package" and is consumed externally via `dist/` — **every exported symbol is public
surface**.

Two prior SOLID/code-smell passes (T-02028, T-02030) plus the earlier per-package
audit have landed the obvious work: `validateTokenField` (the `ValidationResult`-
lifting wrapper), `buildScopeRef` (single source of truth for ref assembly),
`splitHandle` (single source of truth for handle grammar, shared by validate+parse),
and the `LANE_PREFIX` constant is now single-sourced in `lane-ref.ts` and imported by
`session-ref.ts` (the prior run flagged this as duplicated — it has since been fixed;
re-verified). The low-hanging fruit is gone.

**Verdict: 0 auto-applicable findings.** One real mechanism-grounded issue exists
(a partiality gap in `parseSessionHandle` lane handling) but it is **public-surface
+ behavior-changing**, so it is surfaced as a deferred finding for a human decision,
not auto-applied.

## Public boundary verdict (assess first — outside-in)

`index.ts` re-exports a focused, well-shaped API. Boundary is healthy:

- **Token validators come in two intentional shapes**, both exported and both used:
  `validateToken` → `string | undefined` (ergonomic for `lane-ref.ts`'s inline
  error path) and `validateTokenField` → `ValidationResult` (used by the scope-ref /
  scope-handle validators). Not a redundant pair — different return contracts,
  different call sites. Leave.
- **Parse/format/validate trios** are symmetric across ScopeRef, ScopeHandle,
  SessionRef, SessionHandle and round-trip under test. Good.
- **One asymmetry** in the boundary: `parseSessionRef` (canonical-string form)
  validates its lane segment via `normalizeSessionRef`, but `parseSessionHandle`
  (shorthand form) does **not** validate its lane segment. See deferred finding D1.

No fat/leaky interface, no premature one-implementor abstraction, no unmet
expand/contract obligation beyond D1. The boundary needs no narrowing or widening.

## Make-safe gate [T40]

Already satisfied. `bun test` → 179 pass / 0 fail, with characterization coverage on
every public function (grammar matrix, invalid-input rejection, round-trips,
error-branch messages, whitespace policy). No new characterization tests required
before internal churn — but the suite does **not** characterize the bad-lane-in-handle
case (D1), so that gap is currently invisible to the tests.

## Findings by mechanism

### D1 — `parseSessionHandle` lane segment is partial, not total  [T17 partial→total / [M02] expand-contract]

- **Location:** `src/session-handle.ts:18-38` (`parseSessionHandle`), specifically
  line 36 `laneRef: laneId === undefined ? 'main' : laneRefFromId(laneId)`.
- **Mechanism:** `laneRefFromId` is a pure formatter — it wraps any string as
  `lane:<id>` with **no token validation**. The scope portion of the handle is
  validated (via `parseScopeHandle` → `validateScopeHandle`), but the lane portion
  is not. Verified empirically by probing the package:
  - `parseSessionHandle('alice@demo~bad lane')` → `{ laneRef: 'lane:bad lane' }`
    (a `LaneRef` value that `validateLaneRef` rejects).
  - `parseSessionHandle('alice@demo~')` → `{ laneRef: 'lane:' }` (empty lane id,
    also rejected by `validateLaneRef`).
  The total-function repair is to validate the lane id (e.g. route through
  `normalizeLaneRef`/`validateLaneRef`, mirroring what `parseSessionRef` already
  does) so the function either returns a valid `SessionRef` or throws — making the
  declared `LaneRef` return invariant actually hold.
- **Direction:** Make the partial parser total — narrow the accepted input set so the
  return type's `LaneRef` invariant is honored.
- **Preservation:** **NOT behavior-preserving.** Inputs that today silently produce an
  invalid `LaneRef` would begin to throw. That is a redesign of the observable
  contract, flagged as such.
- **Risk:** Med. **apiImpact:** public-surface.
- **Tests:** No existing test characterizes the bad-lane case, so current tests would
  still pass — but external callers relying on the lenient behavior would observe a
  new throw. New tests should pin the chosen behavior (throw vs. coerce).
- **Contraindication / why deferred:** Because this changes the observable contract of
  a public, externally-consumed export, it must not be auto-applied. A human must
  decide whether `parseSessionHandle` should (a) reject invalid lanes symmetric with
  `parseSessionRef`, or (b) deliberately stay lenient (the handle parsers
  intentionally do less normalization than the ref form — see the documented
  whitespace-policy asymmetry in `session-ref.ts`). Both are defensible; this is a
  contract call, not a mechanical refactor.

## Deliberately left alone (pressure-tested, not flagged)

- **`LANE_PREFIX` duplication (prior finding) — already fixed.** The earlier audit
  flagged a copy in `session-ref.ts`; current source imports it from `lane-ref.ts`.
  Stale. No action.
- **`validateToken` vs `validateTokenField` (types.ts):** different return shapes,
  both exported, both genuinely used. Collapsing either churns the public surface and
  the `lane-ref.ts` call site for no gain.
- **`HandleParts` (scope-handle.ts) vs `ScopeRefFields` (scope-ref.ts):** structurally
  identical 4-field types in two files. Unifying [T15] would couple two currently-
  independent modules over a trivial type, and the two names express distinct intents
  (pre-validation handle decomposition vs. ref-builder input). The duplication is
  cheap and non-load-bearing. Leave.
- **`part(parts, i)` cast helper (scope-ref.ts:4-6):** casts `parts[i] as string`, a
  contained post-validation accessor — `validateScopeRef` guarantees length before
  `parseScopeRef` indexes. Reifying it would add structure without removing a real
  bug. Leave.
- **`validateScopeRef` grammar walk (scope-ref.ts:41-97):** linear, early-returning
  grammar matcher; nesting peaks below the ≥4 guard-clause threshold. A dispatch table
  [T19] would be premature — the grammar is fixed (5 kinds), not growing one arm per
  feature. Leave.
- **`formatScopeRef(parsed) = buildScopeRef(parsed)` (scope-ref.ts:143-145):** passes
  the wider `ParsedScopeRef` as a function argument (not an object literal), so
  structural typing is safe — no excess-property forwarding risk. Leave.

## Outside-in apply sequence

No auto-applicable internal-only findings, so the apply phase has nothing to do. The
single finding (D1) is deferred to the user:

1. **Decide D1's contract** — reject invalid lanes in `parseSessionHandle` (symmetric
   with `parseSessionRef`) **or** keep it deliberately lenient.
2. If "reject": route the lane id through `normalizeLaneRef`/`validateLaneRef`, add
   characterization tests for `~bad lane` and trailing-`~`, and treat it as a
   public-surface contract change (expand/contract, version note).
3. If "lenient": document the intentional asymmetry in `session-handle.ts` so the gap
   stops reading like an oversight.
