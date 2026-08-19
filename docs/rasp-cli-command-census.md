# `asp` CLI command census for the `rasp` migration

- Status: migration-scope input for P4/P5
- Evidence date: 2026-08-19
- Task: T-07316

## Decision

The current TypeScript CLI has **44 leaf command paths**. This census assigns
each path exactly once:

| Bucket | Count | Meaning |
| --- | ---: | --- |
| PORT | 3 | Preserve as first-class `rasp` commands because a checked-in programmatic consumer exists. |
| RETIRE | 16 | Do not implement in `rasp`; remove after callers and compatibility checks no longer require the TypeScript command. |
| DEFER | 25 | Keep working through the TypeScript `asp` shim. This is not approval to port; a later evidence or ownership decision is required. |
| **Total** | **44** | Complete leaf-command surface from `packages/cli/src/command-registry.ts`. |

The migration must port `run`, `lint`, and `resolve-reminder`. It must not
silently absorb the other 41 commands into the Rust scope. The TypeScript shim
is the conservative compatibility boundary for deferred commands.

## Method and evidence boundary

The denominator was generated from Commander after calling
`registerAllCommands()` from
[`packages/cli/src/command-registry.ts`](../packages/cli/src/command-registry.ts),
then recursively walking commands with no children. The registry has 25
top-level registrars but expands to 44 leaf paths. Group containers (`self`,
`self memory`, `repo`, `spaces`, `resources`, and `agents`) are not independently
executable and are not counted. `self introspect` is an alias for `self inspect`,
not a second command.

The repository search examined checked-in justfiles, shell scripts, script
directories, source spawn sites, and dynamic launcher construction. It searched
for literal `asp <command>` forms, argv forms such as `['asp', 'lint', ...]`,
CLI path variables, and launcher variables whose next argument is `run`.
Generated output, dependencies, tests, and prose were separated from production
call sites; they do not make a command a PORT candidate.

### Repository snapshots searched

| Repository/source | Commit | Result relevant to CLI calls |
| --- | --- | --- |
| agent-spaces | `6a3dd76ca6f83887a911baeb0478b72c43389d63` | CLI smoke calls `self --help` and `doctor`; no external production caller. |
| hrc-runtime | `cadccf7a994065a577826fa6850a3bd88f672ee1` | No `asp` CLI spawn; HRC calls the ASPC facade. |
| agent-control-plane | `0c66312ce6c8fdd101527ee8d49d5034c9eb81a3` | No `asp` CLI spawn; ACP uses HRC and published runtime libraries. |
| taskboard | `eb06e29866a9afd90535a71d8f1ce8ed414838e5` | Ralph scripts invoke `asp run`; agent inspection calls ASPC RPC directly. |
| workboard | `9a6774e0799e9bf33c19798ae97ed10f2d887f15` | Ralph scripts invoke `asp run`. |
| ghostmux | `270a10b80de68a324401dcf2eb5b1960ac5cbd47` | No `asp` CLI invocation. |
| archagent | `3cc7a238a44029baf98cd7c0b65e1a4ee0e4b201` | Fleet judge script invokes `asp lint --judge`. |
| stackctl | `5400fdac05529cceb0b0f235d449dc8f37b9af23` | No `asp` CLI invocation. |
| wrkq | `5c8a09d967f40d36d0b5547262f2ecf88414533d` | No `asp` CLI invocation. |
| agent-loop | `d668b727410d08b766812d90156516e378332a95` | No `asp` CLI invocation; local execution uses ASPC. |
| agents | `8e851882b5731bbfe6d031e663f4ce27eb322f78` | Startup hook invokes `asp resolve-reminder`; profiles mention `self inspect/paths`. |
| spaces-repo | `5f0d87d01b9630f64546d67acb3633f47c2ff2a9` | Animata dynamically constructs `<launcher> run`; default launcher is `asp`. |

The max3 interactive-history leg is durable task evidence C-14892 and was not
repeated: `~/.zsh_history` and `~/.bash_history` contained zero interactive
`asp` invocations even though `asp`, `aspc`, and `aspc-facade` were installed.
Consequently, checked-in programmatic consumers—not presumed human convenience—
decide the PORT bucket.

### Positive call-site evidence

- `run`: taskboard and workboard each have four literal invocations across
  `ralph/pi_ralph_{build,plan}_loop.sh`. Their non-Pi equivalents execute
  `$ASP run` and hard-code
  `/Users/lherron/praesidium/agent-spaces/packages/cli/bin/asp.js` in `ASP`.
  Animata's `packages/animata-core/src/launch.ts` defaults the launcher to
  `asp` and constructs `<launcher> run ...` for tmux. This is independent
  evidence from three repositories.
- `lint`: Archagent's
  `agent-hygiene/assessments/judge-fleet-2026-07-04/_tools/sweep.py:40`
  executes `subprocess.run(["asp", "lint", "--judge", ...])`.
- `resolve-reminder`: the live
  `var/agents/spaces/praesidium-defaults/hooks/scripts/agent_motd.sh:24` startup
  hook executes it. `var/logs/motd-calls.log` recorded 14 hook starts through
  2026-08-19T00:04:27Z, so this is an exercised runtime path rather than dead
  sample code.

### HRC, ACP, and Taskboard boundary evidence

- HRC's `packages/hrc-server/src/option-resolvers.ts` launches
  `aspc-facade`, and `agent-spaces-adapter/aspc-facade-client.ts` calls
  `aspc.compileHarnessInvocation`. It does not shell out to `asp run` or any
  other `asp` CLI command.
- ACP has no `asp` CLI spawn. Its production source consumes HRC and
  `spaces-runtime`; the `sync:asp` script name concerns package-set deployment,
  not a CLI command.
- Taskboard uses `aspc-facade` and calls `aspc.catalogAgents` and
  `aspc.inspectAgent` in
  `apps/api/src/serverServices/agentInspectionService.js`. The `asp agents`
  wrappers are therefore not on the Taskboard execution path.

## PORT to `rasp` (3)

| Command | Evidence and migration requirement |
| --- | --- |
| `asp run` | Three checked-in consumers: taskboard, workboard, and Animata. Preserve target/path/space resolution and `--print-command` behavior used by the Ralph loops. Before cutover, remove the two repositories' hard-coded TypeScript entrypoint paths or provide a compatible PATH-based command. |
| `asp lint` | Archagent invokes `lint --judge` programmatically. `rasp lint` must preserve the called option/output/exit contract; migration may delegate the judge implementation, but the CLI contract cannot vanish. |
| `asp resolve-reminder` | A live SessionStart hook invokes the command and has current execution-log evidence. Port its bare-target inference, reminder-only stdout, and failure behavior before switching the shim default. |

## RETIRE (16)

Each retirement has command-specific evidence. “Zero callers” below means no
production invocation in the pinned repository set plus zero max3 interactive
history from C-14892.

| Command | Retirement evidence and replacement |
| --- | --- |
| `asp add` | Zero callers. It edits a target's compose list; edit `asp-targets.toml` and let `run`/the compiler resolve it. Do not recreate a manifest editor in Rust without a new consumer. |
| `asp remove` | Zero callers. It is the inverse manifest mutation of `add`; use the same direct manifest workflow. |
| `asp upgrade` | Zero callers. Its lock-pin update belongs to the legacy selector/install workflow; no deploy or runtime path invokes it. |
| `asp diff` | Zero callers. It previews the same unused lock-update workflow; tests alone are compatibility evidence, not adoption. |
| `asp agent` | Zero callers. Placement-driven execution is owned by HRC, which compiles through ASPC and dispatches through the broker. Keeping a second CLI spawn authority would violate the current boundary. |
| `asp agents catalog` | Zero CLI callers. Taskboard uses the equivalent `aspc.catalogAgents` RPC directly, proving the product path does not need this wrapper. |
| `asp agents inspect` | Zero CLI callers. Taskboard uses `aspc.inspectAgent` directly; ACP's prompt inspection uses `spaces-runtime`, not this wrapper. |
| `asp token-rent` | Zero callers. `packages/cli/src/commands/token-rent.ts:13-14` hard-codes Lance's HRC DB and agent roots, making the default non-portable. Recommendation: retire from the product CLI; if the analysis is still wanted, first fix path discovery and move it to an explicitly owned analysis script. |
| `asp repo init` | Zero callers. `docs/cli-reference.md` marks the whole `repo` group legacy; current spaces live under agents/project/agent roots rather than a git registry. |
| `asp repo new-space` | Zero callers. It scaffolds into the retired git-registry placement; new source spaces should be created in an owned agents/project root. |
| `asp repo status` | Zero callers and only reports the retired git-registry workflow. Normal Git tooling is the replacement. |
| `asp repo publish` | Zero callers. It creates version/dist tags for the retired git-registry model; current filesystem-owned `@dev` spaces do not require this command. |
| `asp repo tags` | Zero callers. It reads tags for the retired registry publishing model; use Git when historical inspection is needed. |
| `asp repo gc` | Zero callers. It garbage-collects the retired registry repository, distinct from the still-deferred local store/cache `asp gc`. |
| `asp spaces init` | Zero callers. Its implementation writes under `paths.repo`, refuses to run until `asp repo init`, and recommends `asp repo publish`; it is therefore coupled to the retired registry workflow. Create spaces in agents/project/agent roots instead. |
| `asp spaces list` | Zero callers. It lists the legacy registry; filesystem-owned spaces and compiler inputs are the current authority. |

## DEFER behind the TypeScript shim (25)

These commands have no evidence strong enough either to expand the Rust scope
or to delete the behavior. They remain callable through `asp` until an owner
supplies a port contract or a retirement replacement.

| Command | Why it stays in the shim for now |
| --- | --- |
| `asp init` | No external caller, but it creates the current project entry file. No replacement/retirement decision is recorded. |
| `asp install` | No external CLI caller, but its resolution/materialization behavior remains coupled to `run`; preserve explicit access during compiler migration. |
| `asp build` | No external caller. It is an explicit materialization/debug surface and should not enlarge the initial Rust port without demand. |
| `asp describe` | No external caller. It exposes TypeScript-specific hooks/skills/tools diagnostics with no agreed `rasp` output contract. |
| `asp explain` | No external caller. It remains useful for resolution diagnostics, but no checked-in automation depends on it. |
| `asp list` | No external caller and no approved replacement for its mixed targets/spaces/cache view. |
| `asp path` | No external caller. Retain as a small compatibility utility until filesystem ownership after the repository split is final. |
| `asp doctor` | Called only by `scripts/cli-smoke.sh`; that proves the command works, not product adoption. Its checks are TypeScript/Claude/registry-specific. |
| `asp gc` | No external caller. It mutates local stores/caches, so retirement needs an explicit lifecycle owner rather than an absence-only inference. |
| `asp gui` | No caller and no interactive history, but launching Codex.app is a distinct user surface with no approved replacement. Defer instead of guessing. |
| `asp harnesses` | No external caller. Its catalog is useful during the transition but is not part of compiler substitution. |
| `asp resources plan` | No checked-in invocation. Runtime-resource ownership after the split is unresolved; keep the existing planner available until that boundary is decided. |
| `asp self inspect` | Agent profiles explicitly tell agents to run it for live scope/orientation, although no actual invocation was found in the evidence window. Keep the instruction working through the shim. |
| `asp self paths` | Agent profiles pair it with `self inspect` for editable/derived path orientation; defer with that surface. |
| `asp self prompt` | No production call site. It introspects TypeScript launch artifacts and belongs with the cohesive `self` diagnostic surface. |
| `asp self explain` | No production call site. It diagnoses TypeScript prompt/reminder/launch assembly and has no Rust contract. |
| `asp self memory inspect` | No production call site. Memory paths and policy are agent-management concerns, not compiler migration scope. |
| `asp self memory read` | Same ownership boundary as `self memory inspect`; retain through the shim. |
| `asp self memory add` | Same boundary, and it performs guarded persistent writes; do not duplicate it in Rust without an owner. |
| `asp self memory replace` | Same boundary and guarded-write risk; retain through the shim. |
| `asp self memory remove` | Same boundary and destructive mutation risk; retain through the shim. |
| `asp self memory scan` | Same boundary; scanner policy remains in the TypeScript agent-management implementation. |
| `asp self memory snapshot` | Same boundary; it reads the current bundled reminder snapshot. |
| `asp self memory diff` | Same boundary; it compares the TypeScript bundle snapshot with recomputation. |
| `asp self memory paths` | Same boundary; it exposes memory zones/scopes rather than compiler behavior. |

## Open questions and migration gates

1. Should the `self` and `self memory` families eventually move to a dedicated
   agent-control CLI rather than `rasp`? Their current agent-profile references
   prevent immediate retirement, but they are not compiler commands.
2. Which repository owns `resources plan` after the split? Until that is
   answered, neither porting nor retiring it is evidence-based.
3. Is `gui` still an intended Codex.app entry point? Zero history supports
   retirement, but there is no approved replacement; it therefore remains
   deferred.
4. The taskboard and workboard non-Pi Ralph loops hard-code the TypeScript
   `asp.js` path. P4/P5 must either fix those four scripts to call the installed
   command or explicitly retire the loops before `rasp run` cutover.
5. `lint --judge` and `resolve-reminder` are PORT compatibility obligations.
   Their internals may remain in TypeScript or move behind an RPC during an
   intermediate phase, but the checked-in callers must stay green until they
   are deliberately migrated.

## Verification commands

The census denominator can be regenerated without executing a command action:

```sh
bun -e "import { Command } from 'commander'; import { registerAllCommands } from './packages/cli/src/command-registry.ts'; const p=new Command().name('asp'); registerAllCommands(p); const leaves=[]; function walk(c,parts){ if(c.commands.length===0){ leaves.push(parts.join(' ')); return } for(const child of c.commands) walk(child,[...parts,child.name()]) }; for(const c of p.commands) walk(c,['asp',c.name()]); console.log(leaves.join('\\n')); console.error('count='+leaves.length)"
```

Expected result: the 44 paths listed across the three bucket tables above and
`count=44`.
