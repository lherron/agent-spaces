# Maintain: the upkeep pass

The pass that keeps this skill true as agent-spaces changes. The agent-spaces resident files it on its upkeep
schedule tick (fitkit `verify-upkeep`) and dispatches clod to it; anyone can run it by hand the same way. It
follows Foundry's `verify-foundry` MAINTAIN.md.

**Edit scope:** this skill directory (`spaces/verify-agent-spaces/`). No product code. A product defect becomes an
agent-spaces task.

**The last pass** is the newest `verify.upkeep` fact's `head` (`wrkp log agent-spaces --type verify.upkeep --limit
1 --json`), or, when there is none, the skill's first commit (`git log --reverse --format=%H --
spaces/verify-agent-spaces | head -1`). Every "since the last pass" below means `<that sha>..HEAD`.

**Evidence** goes under the pass task's `artifact_dir` (`~/praesidium/var/wrkq-artifacts/<task>/`), laid out as
[SKILL.md](SKILL.md) "Evidence" says: `index/` (step 1), `sources/NN.md` (step 2), `plan.md` (step 3), one
`NN-<feature>/drive.txt` per feature (step 4), `live/` for the system reads, and `ship.txt` (step 6).

**No installs, no restarts.** The pass never runs `just install`, never activates, restarts, stops or supervises
the system aspd, and never overlays `~/.codex`. Remember that `asp` and `harness-broker` already run the
checkout's source, so a pass drives HEAD (plus anything other seats left unsaved); aspd stays on its release.

## 1. Index hygiene

`features/README.md` against `features/*.md`: every file is linked, every link resolves, and each row's summary still
names what the file covers. Every `asp` verb (`asp --help`), every operator-facing `harness-broker` verb (the `command
===` branches in `harness/harness-broker/src/cli.ts`; bare `harness-broker` prints only `run`, `capture` and
`submission` until T-10365 lands), every ASPC method (`ASPC_METHODS` in `contracts/aspc-protocol/src/types.ts`) and
every `aspd-*`, `*-asp-release`, `publish-*` and `overlay-codex` recipe must be named in a feature file. Where one is
unmapped, map it in step 6. Write the comparison to `index/`.

## 2. Source reads, one per feature

For each feature file, read the code it names (and `git log <last pass>..HEAD -- <those paths>`) and answer: what
does the code do now, and which Sub-features, Gotchas or Proven-when lines are likely drift? Also flag behavior the
file doesn't state at all. Cite file:line. Fan these out as read-only subagents when the session can, or read them
one after another. Write one note per feature: `<artifact_dir>/sources/NN.md`.

## 3. Reconcile

Merge the source notes into a plan that drives every feature in as few setups as practical: one `avs scratch up
--name <task>` serves features 1-3, 5 and 9; feature 6's isolated namespace and feature 7's clone live under the
same scratch root; features 4, 6 (system half) and 8 need no scratch. List each feature's drive and the suspected
drift and new behaviors it has to confirm or clear. Write it to `<artifact_dir>/plan.md`.

## 4. Live pass over every feature

Drive every feature (nine today) on every pass, even when no agent-spaces commit landed since the last pass: drift
also comes from what agent-spaces runs on (the harness binaries, HRC's state DB, `var/agents`), which the source
reads in step 2 don't see.

Run `avs doctor` first, and again after any surprise. Drive each feature's "Driving it" with `avs rec`, **and every
drift or new behavior step 2 flagged**. Features marked read-only get only reads. Check each result against "Proven
when". Count the features you drove to their Proven when (`driven`), and name any you couldn't drive with the
prerequisite that stopped you. Stop any scratch aspd (`just aspd-stop <root>/aspd-ns`), then `avs scratch down
<task>`.

## 5. Triage every failure

| Class | Meaning | Action |
| --- | --- | --- |
| Doc drift | The surface is right; the file is stale | Fix the feature file (Gotchas with date and evidence) |
| Harness gap | `avs` or this skill can't reach or observe it | Fix `avs` or SKILL.md |
| Product gap | The surface is wrong | File a task under `agent-spaces/inbox` with the failing drive; never paper over it in the map |

## 6. Ship

Make at most one commit of the proven map and harness fixes, with each fix re-driven. Stage only paths under
`spaces/verify-agent-spaces/` through a private index (`GIT_INDEX_FILE=<tmp> git read-tree HEAD; git add <paths>;
git commit`), check `git log origin/main..HEAD` holds only your commit, and push it. Keep the commands and their
output in `ship.txt`. On the pass task, comment the outcome and coverage:

- `clean`: nothing changed;
- `changed`: the commit SHA and what moved;
- `blocked`: what stopped the pass and the task that tracks it.

Add `driven/features`, the evidence path, any product tasks filed, and a **source-only, undriven** list: each
finding from step 2 that went into the map without a drive behind it, with why it wasn't driven.

## 7. Post the fact

End every pass by posting `verify.upkeep`, including a blocked one, and including a pass that stopped early. Its
attributes and meanings are the `consumes` block of fitkit's `verify-upkeep@2` entry (`foundry direct
fitkit.catalog '{}'` from a foundry root). `features` is the count of `features/*.md` other than README.md;
`head` is `git rev-parse HEAD` after the ship. Post it last, after the task comment, so its `occurred_at` is the
pass's finish time:

```bash
wrkp post agent-spaces --type verify.upkeep --key verify-upkeep:<task> -m "verify-agent-spaces upkeep <task>: <outcome>" \
  --attr outcome=<clean|changed|blocked> --attr features=<n> --attr driven=<n> --attr head=<sha> --attr task=<task>
```

The key makes a repeated post one fact. Then complete the task (or leave it open only when it is blocked, and say
on what).
