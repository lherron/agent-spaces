# Muse handoff — 2026-09-17/18 session

Next session: begin work on the **muse-tmux driver**. This file records what was
done today and everything likely to matter for that.

## 1. Completed goal: muse serve + renderer + viewer attach (100%)

Objective "Get muse serve driver working with broker renderer and properly
attaching in hrc-viewer" was verified live and marked complete.

- Runtime `rt-3e3daf25` (seat `muse@hrc-runtime:renderview4`, release
  HRC 2eaed065 + ASP 31c20e5b): lease consumed (`terminal.surface.reported` in
  `state.sqlite:broker_invocation_events`), renderer live in observer pane
  `@1`, `runtime.presentation` event + read model carry correct
  `attachTarget` (`<session>:observer`), viewer Ghostty surface attached and
  showing the transcript. A fresh `probe ok` turn rendered in both panes.
- Key lesson: three "failures" were observability false negatives —
  `terminal.surface.reported` lives in `state.sqlite`, not the daemon log; the
  blank pane was the broker window `@0`, observer content is on `@1`;
  "tmux null rows" were older headless runtimes correctly without coordinates.
- Live panes: tmux socket
  `/Users/lherron/praesidium/var/run/hrc/btmux/muse-serve-rt-<id>.sock`,
  observer window `@1`; viewer surface found via
  `ghostmux metadata get` / `ghostmux capture-pane -t <surface>`.

## 2. Follow-up fixes (this session, ASP commit 1489a5a7, pushed to main)

User pasted a brokertest transcript showing plain (colorless) rendering plus
`[error] muse turn/steer response conflicts with the armed turn identity`.

### 2a. Steer error — root-caused via event ledger + live probes

- Ledger (`inv-8faa2450…`, R-00113 clod ping): the ping rode the birth turn
  (pong sent, EN-14636), then HRC steered the same input as a duplicate
  (`submission_…_1`) into the running turn. Muse's native turn had rolled, so
  the accepted steer named the absorbing turn, not the armed one → driver threw
  `possibly_written` + `input.rejected`, even though delivery had landed.
- Proven with throwaway probes in `/tmp` (`muse-steer-probe.ts`,
  `muse-steer-race.ts`): successful live `turn/steer` returns flat
  `{commandId, status:'accepted', turnId}` with turnId = the armed running
  turn. MSP schema (`muse schema generate-json-schema --out …`,
  `TurnSteerResult`) confirms: turnId = "The running turn that absorbed the
  input". Export at `/tmp/muse-schema/` (throwaway, regenerable).
- Related discoveries: `turn/start` echoes its commandId as turnId; commandIds
  must be UUIDv7 (v4 rejected); `CommandStatus` enum is only `accepted`.
- Fix (`drivers/muse-serve/driver.ts` `applySteerNow`): accepted steer naming
  a different turn re-arms `currentTurnId` to the absorbing turn, keeps
  `turnActive`, emits info `muse turn/steer absorbed after native turn roll`.
  Only a missing/empty turnId keeps the armed-identity error. Contract updated
  in `muse-code-driver.md` §3.
- Test: fake-muse `steer-roll` scenario + `broker.steer` resolves with no
  conflicts diagnostic (`test/drivers/muse-serve/muse-serve-driver.test.ts`).

### 2b. Renderer colors — two compounding causes, both fixed

- `drivers/muse-serve/transcript.ts` emitted plain lines by design, AND
  `renderer-entry.ts` hardcoded `color: false`.
- Muse model now uses the shared forge-lanes primitives: exported
  `createCodexStyler` + `CodexStyler`/`CodexSeg`/`CodexFg`/`CodexBg` from
  `drivers/codex-app-server/transcript.ts` (additive renames only; codex tests
  green). Iris user lane, molten `▶ turn`, kiln `$ tool` lanes, `✓ done`
  footers, red failure bands, dim chrome. `color` defaults false (legacy plain
  output byte-identical); entry enables on TTY unless `NO_COLOR`, mirroring
  the codex entry. Color/width plumbed through `renderer.ts` projection slot.
- Duplicate assistant lines folded: muse re-emits an agent item with identical
  text (seen after the steered duplicate); the model drops consecutive
  duplicate assistant texts with no intervening `turn.started`.
- Tests in `transcript.test.ts` (legacy expectations unchanged + styled/dedup).

### 2c. Validation + deploy state

- 38 tests pass (muse-serve + codex-app-server src/test), `tsc --noEmit`
  clean, biome clean on all touched paths (repo-wide `bun run lint` fails at
  baseline too — pre-existing, unrelated).
- Published in aspd bundle `asp-32a8e0d6767f-20260918T041415Z` and on main
  (plus a later `32a8e0d6 feat(aspc)` commit on top, different area).
- Liveness model: global `harness-broker` symlinks to the workspace and its
  launcher prefers `src/`, so **newly spawned brokers load current src with no
  reinstall**. The 8 running brokers predate the fix; runtimes reuse warm
  brokers, so old runtimes stay stale until recycled — new runtimes get the
  fix. No daemon restart needed (driver runs in the broker child).

## 3. Repo / tree state left behind

- agent-spaces main: clean except this file (untracked, intentional).
- hrc-runtime: 3 commits ahead of origin, **unpushed**; plus UNCOMMITTED
  mail-kicker reply-principal changes (`ledger/presentation.ts` + test +
  index) — unrelated to muse work, do not touch.
- User was mid-edit in hrc; no hrc changes were needed or made from here.

## 4. Directly relevant to the muse-tmux driver

- **Precedent tmux drivers** (same directory): `claude-code-tmux/`,
  `codex-cli-tmux/`, `pi-tui-tmux/`, `agent-harness-tmux/`. Start from
  `codex-cli-tmux` (closest shape: CLI-in-tmux + broker renderer) and reuse
  `drivers/tmux-shared.ts` (`consumePaneLease`, `TmuxPaneController`,
  `shellQuote`) — the observer lease/consume path already works for muse-serve
  and is driver-agnostic.
- **Renderer reuse**: `codex-app-server/renderer.ts` (durable-read projection),
  `renderer-entry.ts` launch shape (`--driver/--invocation-id/--observer-socket/
  --control-socket`), `pane-output.ts`, and now the shared `createCodexStyler`
  + `MuseTranscriptModelOptions{color,width}` pattern. A tmux driver gets the
  observer pane for free via `DriverContext.runtime.terminalSurface`.
- **HRC side (already in place, no changes needed)**: observer presentation
  kind, `observerPaneAllocator`, `viewerPaneRouteOf`/`resolveViewerPaneDispatch`
  (`broker/controller/{allocation,dispatch}.ts`), `toDispatchRuntime`,
  `canOperatorAttach` incl. `observer`, flat-shape `parseFlatPresentation`
  with `observerWindow`, `attachTarget …:observer` in read model + events.
- **Steer contract** (`muse-code-driver.md` §3 + `driver.ts`): re-arm-on-absorb
  is now the house rule for muse; keep it for any new driver against the same
  MSP surface. MSP schema: regenerate with
  `muse schema generate-json-schema --out <dir>` (offline, exact for the
  binary); pinned fingerprint R3401.1 for muse 1.3.0.
- **Known quirks**: muse echoes `turn/start` commandId as turnId; native turns
  roll server-side (watch `turn/started` re-arm + `turn/retracted` handling in
  `trackTurnLifecycle`); HRC may double-deliver birth input + steer (HRC-side
  concern, user owns); duplicate agent-message items with identical text.
- **Tooling**: `bun test test/drivers/muse-serve/ src/drivers/muse-serve/
  src/drivers/codex-app-server/`; `bunx tsc --noEmit -p tsconfig.json` in
  `harness/harness-broker`; `bunx biome check <files>`; live checks via
  `sqlite3 /Users/lherron/praesidium/var/state/hrc/state.sqlite`
  (`broker_invocation_events`, `hrc_events`, `runtimes`), `tmux -S <sock>
  capture-pane -t @1 -p`, `ghostmux capture-pane -t <surface>`.
- **Still open (separate)**: MATRIX smoke row for muse-serve (T-08592 track);
  hrc-runtime commits unpushed; ghostmux live-terminal validation per repo
  doctrine when the tmux driver lands.
