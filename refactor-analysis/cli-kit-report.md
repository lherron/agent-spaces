# Refactor analysis — `cli-kit`

**Package:** `cli-kit` (`packages/cli-kit`)
**Type:** leaf library (published, cross-repo)
**Source:** `src/index.ts` (191 LOC) + `src/index.test.ts` (204 LOC). No other source files.
**Date:** 2026-06-08
**Verdict:** **CLEAN — 0 internal-only applicable findings.** The two prior passes (T-02028,
T-02030) already landed here; their fingerprints are the justification comments on the overloads,
the type guard, and the `formatErrorLine`/`readBody` extractions. Tests pass 18/18. One Low /
public-surface nit is deferred (carried from the prior pass, still valid).

## packageType
`leaf` — pure helpers/validators, no concurrency, no perf-critical paths, no internal state. The
mechanism lens is tuned to boundary (T07/M02) + de-abstraction (T16) + partial→total (T17), which is
where a small published utility kit is most likely to drift.

## Public boundary verdict — the load-bearing observation
cli-kit exports **12 public symbols**: `CliUsageError`, `BuildDeps<D>`, `attachJsonOption`,
`attachServerOption`, `attachActorOption`, `repeatable`, `withDeps`, `parseDuration`,
`parseJsonObject`, `parseCommaList`, `parseIntegerValue`, `consumeBody`, `exitWithError`.

The only in-tree consumer (`packages/cli`, 8 files) imports exactly **two**: `CliUsageError` and
`exitWithError`. The other 10 exports have **zero importers anywhere in this repo**.

On a normal internal module this is a textbook **T16 (collapse premature abstraction)** /
**T07 (narrow fat interface to actual usage)** finding — delete the unused 10.

**It is NOT auto-applicable here, and the contraindication is decisive:**
- `package.json` declares `version: 0.1.1`, a `dist` artifact, `prepack`/`postpack`, and the
  `strip-bun-exports` step — this is a *published* package, not an internal helper.
- It is wired into the verdaccio dev-publish loop: `scripts/publish-local-verdaccio.ts` and
  `scripts/smoke-pack-cross-repo.ts` both list `packages/cli-kit`.
- Per the repo-split (2026-05-18), `hrc-runtime` and `agent-control-plane` are *separate repos* that
  consume ASP packages via verdaccio. Their source is not in this tree, so "no importer here" does
  **not** mean "no importer." The 10 currently-unused-in-`cli` exports are a **deliberate published
  surface** for out-of-tree consumers.

Trimming them would be a breaking `M02 contract change` justified by an incomplete view of the
consumer graph — exactly the false positive the brief warns against. **Leave the surface intact**
(surfaced as a deferred public-surface note so a human with the full consumer inventory can decide).

The shape of the public API is otherwise sound: small, orthogonal functions; every validator takes
the flag name first for uniform error messages; the `(opts, deps={})` injected-seam convention is
consistent across `consumeBody` and `exitWithError`.

## Findings by mechanism

No internal-only applicable findings. Every mechanism was walked and pressure-tested; results below.

- **A — Make-safe [T40]:** Characterization already strong. `index.test.ts` covers every export,
  both `exitWithError` exit codes, the JSON envelope, the injected `write`/`exit` and `readFile`
  seams (no global `process` mutation), and a bun-commander smoke. No gap to backfill — and there is
  no churn to gate.
- **B — Boundary [T07/M02]:** See verdict above. Fat-looking but the width is intentional published
  surface. Narrowing deferred, not applied.
- **C — Seams/structure [T01/T16/T15/T03/T19]:**
  - T01: substitution seams already present and injected (`deps.readFile`, `deps.write`,
    `deps.exit`, `buildDeps`). No `new Concrete()`/singleton/static buried in logic.
  - T16 (de-abstract): the `repeatable` overload set is two overloads + one impl resolving a real
    typing problem (no-parser ⇒ `string`, parser ⇒ its return type) — it removes an `as T` cast, so
    it is *earning* its structure, not premature. `BuildDeps<D> = () => D` is a one-line named alias
    used in `withDeps`'s signature; trivial but it documents intent at the published boundary —
    inlining it is a lateral move with no behavior or clarity gain. Leave both.
  - T15 (extract abstraction): magic numbers already named (`EXIT_CODE_USAGE`/`EXIT_CODE_INTERNAL`,
    `DURATION_UNIT_MS`); the duration regex is derived from the unit table, not duplicated. (The
    one remaining inline literals — `'-'` / `'/dev/stdin'` in `consumeBody` — are the deferred nit.)
  - T03 (cohesion): single file, three cohesive clusters (commander attachers / validators / error
    envelope). Splitting into modules would only add a barrel; not worth it at 191 LOC.
  - T19 (conditional↔dispatch): no growing type/enum switch. `consumeBody`'s file/`-`/positional
    branch is a fixed 3-way, not a per-feature-growing arm.
- **D — Invariants [T12/T10/T17]:**
  - T17 (partial→total): the two `as` casts (`index.ts:38` `value as unknown as T`,
    `index.ts:71` `DURATION_UNIT_MS[match[2]] as number`) are **not** unsafe partial overrides — the
    first is reachable only on the no-parser overload where `T = string`, the second is guarded by
    the regex alternation that produced `match[2]`. Both are documented. Keeping them explicit is
    correct; "totalizing" further would add dead runtime branches for can't-happen states.
  - T10/T12: no boolean soup, no "must call X first" ordering, no illegal-state struct.
- **E — Quality [T18/T23/T22/T21]:**
  - T18 (error handling): both `catch` blocks (`parseJsonObject`, `readBody`) **rethrow** as
    `CliUsageError` with a clearer message — translation, not swallowing. `exitWithError` maps
    `CliUsageError → exit 2` vs `else → exit 1` cleanly. Nothing to restructure.
  - T23 (middle man): no delegating-only class or `a.b().c().d()` chain. `formatErrorLine` is a real
    extraction (formatting decoupled from exit orchestration), not a pass-through.
  - T22 (nesting): max nesting is 2 (guard-clause style throughout). Nothing ≥4.
  - T21 (parameter object): widest param list is `exitWithError(err, opts, deps)` at 3, with `opts`
    and `deps` already grouped as objects. No clump to reify.

## Deferred (public-surface) findings

### D1. `consumeBody` inlines the stdin sentinel `'-'` and path `'/dev/stdin'`
- **Location:** `packages/cli-kit/src/index.ts:132-133`
- **Mechanism:** T15 (extract missing abstraction — name the magic strings as
  `STDIN_SENTINEL = '-'` / `STDIN_PATH = '/dev/stdin'` module constants).
- **Direction:** extract two named constants; behavior-preserving.
- **Preservation:** identical control flow and string values; existing tests
  (`consumeBody reads stdin for a "-" positional`) already pin the `/dev/stdin` read and the `'-'`
  trigger, so a regression would fail the suite.
- **Risk:** Low. **apiImpact:** public-surface.
- **Why deferred:** `consumeBody` is an exported function and the `'-'`-means-stdin semantics are
  part of the observable CLI contract consumers rely on. Pure constant-extraction does not change
  behavior, but any touch to this exported surface should be reviewed against the (cross-repo)
  consuming CLIs rather than auto-applied. Net win is readability only — low urgency.
- **Contraindication considered:** none blocking the extraction itself; deferral is purely the
  public-surface review gate.

### D2. 10 exports are unused by the only in-tree consumer (potential T07/T16 narrowing)
- **Location:** `packages/cli-kit/src/index.ts` (whole public surface; see boundary verdict).
- **Mechanism:** T07 (narrow interface to actual usage) / T16 (collapse premature abstraction) —
  *candidate only*.
- **Direction:** would remove `attachJsonOption`, `attachServerOption`, `attachActorOption`,
  `repeatable`, `withDeps`, `BuildDeps`, `parseDuration`, `parseJsonObject`, `parseCommaList`,
  `parseIntegerValue`, `consumeBody` if confirmed dead globally.
- **Preservation:** would be behavior-changing for out-of-tree consumers — this is **M02 contract
  contraction**, i.e. a breaking change, not a behavior-preserving refactor.
- **Risk:** High. **apiImpact:** public-surface.
- **Why deferred / DO NOT APPLY:** cli-kit is published via verdaccio and consumed by separate
  repos (hrc-runtime, agent-control-plane) not present in this tree. The "unused" signal is an
  artifact of single-repo visibility. Removing the surface requires a confirmed cross-repo consumer
  inventory; a human must make that call. **Recommendation: keep as-is** unless that inventory comes
  back empty.

## Deliberately left alone (with reason)
| Item | Why not touched |
|---|---|
| 10 exports unused by in-tree `cli` | Published cross-repo surface (verdaccio); out-of-tree consumers. Trimming = breaking M02 on incomplete consumer view. (Surfaced as D2.) |
| `BuildDeps<D>` one-line alias | Documents intent at the published boundary; inlining is lateral, no gain. |
| `repeatable` overload triple | Earns its structure — removes an `as T` cast; collapsing it reintroduces unsoundness. |
| `index.ts:38` / `index.ts:71` casts | Reachable-state-correct and already documented; "totalizing" adds dead can't-happen branches. |
| Single-file layout | 191 LOC, 3 cohesive clusters; splitting only adds a barrel. |

## Outside-in apply sequence
**None auto-applicable.** Both findings are public-surface and routed to the user (D1 Low, D2 High).
If a human approves D1, it is a self-contained 2-constant extraction with existing test coverage. D2
should not be applied without a cross-repo consumer inventory.
