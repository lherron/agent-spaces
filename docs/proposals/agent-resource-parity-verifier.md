# Agent Resource Parity Verifier

- **Status:** accepted; implementation ready
- **Date:** 2026-08-24
- **Owner:** agent-spaces
- **Primary package:** `spaces-integration-tests`
- **Architecture authority:** `agent-spaces.agent-harness-runtime-boundary`

## Decision

Add a test-only verifier that independently asks the compiler and
`agent-harness-sdk` to resolve the same agent placement, projects their
ASP-authored prompts and effective skills into a stable observation format, and
byte-compares the two projections.

Task mode is the product priority because ordinary `hrcchat dm` and `hrc run`
placements use `runMode: "task"`. The implementation must establish task-mode
parity first. Query, heartbeat, and maintenance use the same runner with a
different `RunMode` value and scope fixture, so they are included as table-driven
coverage rather than separate machinery.

The verifier belongs in the private `spaces-integration-tests` package. It must
not live in either producer: making the compiler depend on `agent-harness-sdk`,
or the SDK depend on the compiler, would weaken the independent-producer test.

## Current evidence

A live Cody probe with equal placement inputs found:

| Resource | Compiler | `agent-harness-sdk` |
| --- | ---: | ---: |
| System prompt | 8,743 bytes | 8,743 bytes |
| Reminder | 8,671 bytes | 704 bytes |
| Effective skills | 24 | 2 |

The prompt happened to match, but the result is not general parity:

- The compiler derives `agentId`, `projectId`, `taskId`, and `lane` from the
  placement and resolves context with its launch environment.
- `loadAgent()` currently supplies agent/project/run-mode values but does not
  forward task or lane to prompt inspection, and it supplies a different exec
  environment.
- The Pi SDK adapter writes merged skills to its bundle `skillsDir`, but generic
  materialization currently retains only `pluginDirs`. `loadAgent()` therefore
  sees agent-local skills while losing composed space skills.

The verifier is expected to fail against the current implementation. There is
no baseline or bless operation that makes those differences acceptable.

## Goals

- Prove task-mode prompt, reminder, skill-catalog, and skill-package parity for
  every valid agent under `~/agents`.
- Cover query, heartbeat, and maintenance through the same parameterized code.
- Exercise the compiler and SDK integration seams independently.
- Compare authored bytes, not hashes or normalized prose.
- Produce a small, attributable failure showing the agent, mode, resource, and
  first differing byte.
- Run deterministically without wall-clock, service, command, mutable task, or
  temporary-path drift.
- Preserve a hermetic fixture suite for CI and a live fleet command for local
  source/install validation.

## Non-goals

- Comparing Codex, Claude, or Pi vendor-owned base/hidden prompts.
- Proving model behavior is equivalent after the resources are delivered.
- Comparing extensions, hooks, MCP configuration, tools, authentication, or
  session event behavior.
- Turning the verifier projection into a runtime protocol or public SDK model.
- Making compiler and Pi filesystem layouts identical.
- Blessing intentional prompt or skill differences inside this tool.

## Package and file layout

```text
integration-tests/
  bin/
    verify-agent-resource-parity.ts
  lib/
    agent-resource-parity/
      compare.ts
      inventory.ts
      observe-compiler.ts
      observe-sdk.ts
      projection.ts
      replay-context.ts
      types.ts
  tests/
    agent-resource-parity.test.ts
    fixtures/agent-resource-parity/
      agents/
      project/
      registry/
      replay.json
      exclusions.json
```

`integration-tests/package.json` gains an explicit workspace dependency on
`agent-harness-sdk` and a `verify:agent-resources` script. The root justfile
exposes:

```text
just verify-agent-resource-parity
```

The root recipe invokes the integration-test binary; it does not duplicate the
comparison logic in a shell script.

## Comparison matrix

The matrix key is `(agentId, runMode)`. A passing row cannot mask another row.

| Mode | Scope fixture | Priority |
| --- | --- | --- |
| `task` | `agent:<id>:project:agent-spaces:task:T-PARITY` | Required first |
| `query` | `agent:<id>:project:agent-spaces` | Same-runner coverage |
| `heartbeat` | `agent:<id>:project:agent-spaces` | Same-runner coverage |
| `maintenance` | `agent:<id>:project:agent-spaces` | Same-runner coverage |

Every row uses lane `main`, project id `agent-spaces`, the repository root as
the project root/cwd, and the same explicit model and correlation values on both
sides. Task mode deliberately carries a task id so omission of task context is
observable.

The CLI accepts `--mode task` for focused debugging and `--mode all` for the
complete gate. `just verify-agent-resource-parity` runs `all`; task-mode-only
execution is a diagnostic convenience, not a weaker pass condition.

## Fleet inventory contract

Resolve `~/agents` to its real path, list its direct children in Unicode
code-point order, and consider every child containing `agent-profile.toml` a
candidate.

Each candidate must satisfy exactly one condition:

1. It passes the same agent-profile and agent-root validation used by runtime
   placement, or
2. It matches a checked-in exclusion containing the exact agent id and expected
   validation diagnostic.

The command fails when:

- a candidate becomes unexpectedly invalid;
- an exclusion becomes valid but remains listed;
- an exclusion's expected diagnostic changes;
- an exclusion names no candidate; or
- producer execution silently omits a valid agent.

At design time the inventory contains 41 valid agents. `arris` is the sole
expected exclusion because it has a profile but no `SOUL.md`. Counts are
reported, not hard-coded; inclusion is derived from validation.

## Producer observations

### Compiler observation

Call `preparePlacementCliRuntime()` through a deterministic
`AgentSpacesRuntimeDependencies` fixture using the production Codex adapter.
This is the lowest compiler integration seam that exposes all required evidence
together:

- `systemPrompt.content`
- `systemPrompt.mode`
- `systemPrompt.reminderContent`
- the final materialized bundle/runtime-home skill roots

Do not substitute `inspectAgentSystemPrompt()` for the compiler call. That would
compare a shared helper with itself and could pass while compiler wiring is
wrong.

The dependency fixture may pin harness detection and model lookup, but it must
delegate placement, composition, prompt resolution, materialization, and
adapter lowering to production implementations.

### SDK observation

Call `loadAgent()` with the identical placement and replay context. Observe its
prompt and reminder directly.

Skill evidence must come from the Pi resource-loader construction used by
`createSession()`, after `reload()`, via `getSkills()`. Extract that construction
into an inspectable helper and have both `createSession()` and the verifier use
it. The verifier must not carry a second implementation of Pi discovery,
precedence, frontmatter parsing, or duplicate handling.

The parity scope is ASP-owned skill roots explicitly delivered by the SDK.
Vendor/user/project ambient Pi directories are outside this equivalence. The
inspection helper must identify entries originating from the declared ASP roots
without changing production discovery behavior. A same-name ambient collision
that changes the selected ASP entry must be surfaced as a diagnostic rather
than silently filtered.

## `agent-resource-parity/v1` projection

The projection is an internal observation tree. It is never serialized onto an
HRC or harness wire.

```text
agent-resource-parity/v1/
  prompt/
    mode.txt
    content.bin
  reminder/
    presence.txt
    content.bin              # present only when reminder is present
  skills/
    catalog.json
    catalog.txt
    tree.json
    packages/
      <skill-name>/...
```

### Prompt and reminder

- Encode strings as UTF-8 exactly once with `Buffer.from(value, "utf8")`.
- `mode.txt` is exactly `append\n` or `replace\n`.
- `presence.txt` is exactly `present\n` or `absent\n`.
- An absent reminder and a present empty reminder are distinct.
- Do not trim, rewrap, normalize Unicode, normalize line endings, or add a
  trailing newline to content files.

### Skill catalog

For every effective skill, retain:

```ts
interface ParitySkill {
  name: string
  description: string
  disableModelInvocation: boolean
  filePath: `skill://${string}/SKILL.md`
}
```

`catalog.json` uses a stable JSON encoder with fixed object-key order and one
trailing newline. Catalog entry order remains the effective producer/loader
order; sorting entries would hide a precedence difference.

`catalog.txt` is the exact output of Pi's `formatSkillsForPrompt()` after only
the non-semantic absolute `filePath` has been replaced with the logical skill
URI. This byte-compares the catalog text that the first-party harness supplies
to the model without making temporary materialization roots part of equality.

Do not compare Pi `sourceInfo` objects directly. Their absolute origins are
represented instead by the logical URI and the selected package bytes.

### Skill package tree

For each selected catalog entry, copy/project the package rooted at the parent
of its `SKILL.md`:

- regular-file contents are raw bytes;
- relative paths are `/`-separated and sorted by Unicode code point;
- symlinks are not followed in the projection and record their link target;
- executable bits are recorded;
- directory and file mtimes, owners, groups, inode numbers, and absolute roots
  are excluded.

`tree.json` contains stable entries:

```ts
type ParityTreeEntry =
  | { path: string; kind: 'file'; mode: number; size: number; sha256: string }
  | { path: string; kind: 'symlink'; target: string }
  | { path: string; kind: 'directory' }
```

The raw package files remain the primary comparison. SHA-256 values are
diagnostics and manifest integrity, not a replacement for byte comparison.

## Deterministic replay context

Both producers receive one logical replay fixture per matrix row:

- fixed `now`;
- explicit agent/project/task/lane/run-mode identifiers;
- fixed cwd, predicate cwd, and exec cwd;
- fixed environment, predicate environment, and exec environment;
- recorded service-probe responses;
- recorded exec-section responses;
- fixed scaffold packets and correlation identifiers.

Extend `ContextResolverContext` with recorded exec results. A record identifies
the section name, command, occurrence, exit status, stdout, and stderr. When a
recorded-exec collection is present:

- no child process may be launched;
- every evaluated exec section must consume exactly one matching record;
- missing, duplicate, stale, or unused records fail the row;
- success and failure formatting must follow the same production code paths as
  live execution.

Likewise, the presence of recorded service-probe responses forbids live probes.
The verifier fails closed if any replayable dynamic section attempts ambient
I/O.

Thread the resolver context through both public producer paths. The compiler's
prompt materialization currently accepts only ordinary materialization inputs;
it must gain the same pinned resolver seam already available to prompt
inspection. `loadAgent()` must forward the full semantic identifiers, including
task id and lane derived from its scope.

## Materialized skill-root seam

Do not infer `outputPath/skills` in `agent-harness-sdk` or the verifier.

Preserve the adapter's effective skill roots when `materializeTarget()` loads a
`ComposedTargetBundle`. Thread those roots through
`TargetMaterializationResult` and `MaterializedAgentRuntimeResources`. The Pi
SDK adapter supplies its merged `bundle.piSdk.skillsDir`; adapters using plugin
directories retain their existing behavior.

The result must let `loadAgent()` construct its explicit Pi skill paths from the
actual composed bundle plus agent-local inputs. The package-level unit test must
prove that a composed space skill reaches `ResolvedAgent.skillPaths` and the
reloaded Pi resource loader.

## Comparison and diagnostics

Recursively compare the two projected trees. Equality requires the same entry
set, entry kinds, metadata, and regular-file bytes.

The first failure is printed as:

```text
agent-resource parity mismatch
agent: cody
mode: task
resource: reminder/content.bin
compiler: length=8671 sha256=<hex>
sdk:      length=704  sha256=<hex>
first differing byte: 693
compiler window: <escaped bytes>
sdk window:      <escaped bytes>
```

For missing entries, print which producer omitted the logical path. Continue
collecting failures for other rows up to a fixed diagnostic limit, then exit
nonzero. Output ordering is `(agentId, runMode, logicalPath)` in code-point
order.

No command option may update expected output, ignore a resource category, or
turn a mismatch into success.

## Tests

### Owning-package tests

`spaces-runtime`:

- recorded exec success produces the same section result as a matching live
  command fixture;
- recorded exec failure produces the same bounded diagnostic;
- missing/stale/unused records fail closed;
- replay mode launches no child process or service probe.

`spaces-config` and `spaces-harness-pi-sdk`:

- Pi SDK materialization exposes its actual merged skill root;
- target and direct-space materialization preserve it;
- agent-local and composed skills follow existing precedence.

`agent-harness-sdk`:

- task id and lane reach prompt interpolation;
- caller-supplied resolver context is used unchanged;
- the inspectable resource loader is the loader passed to session creation;
- composed and local skills appear in its effective catalog.

### Hermetic integration matrix

The committed fixture must cover:

- non-empty prompt and reminder;
- append and replace prompt modes;
- agent-local and composed skills;
- duplicate skill names with an asserted winner;
- nested skill assets;
- a symlink and an executable file;
- task interpolation;
- one section for each `when.runMode` value;
- a mode-specific composed space;
- recorded successful and failed exec sections;
- recorded service probes.

Run all four modes. Task mode is a separately named test so it remains visible
as the primary regression bar.

Negative controls must demonstrate that each of these changes fails:

- one prompt byte;
- reminder presence or one reminder byte;
- prompt mode;
- skill catalog order or metadata;
- missing/extra skill;
- one package-file byte;
- executable bit;
- symlink target;
- task-id omission; and
- omission of a mode-specific prompt or space.

### Live fleet gate

Run the installed/source-equivalent producers against every valid `~/agents`
candidate and all four modes. Before the run, hash all agent and registry input
files used by the matrix. Restore a clean temporary `ASP_HOME` before each
producer observation and verify the input hashes again afterward.

The live command prints a summary such as:

```text
agent-resource parity: PASS
valid agents: 41
excluded candidates: 1
modes: task, query, heartbeat, maintenance
rows compared: 164
```

## Implementation sequence

1. **Task prompt/reminder replay seam**
   - Add recorded exec replay.
   - Thread resolver context and task/lane through compiler and SDK.
   - Add the task-mode hermetic prompt/reminder comparison.

2. **Effective skill seam**
   - Preserve adapter skill roots through materialization.
   - Extract/observe the Pi loader used by `createSession()`.
   - Add catalog and package projection plus task-mode comparison.

3. **Fleet task gate**
   - Add candidate validation/exclusions and the live task-mode command.
   - Fix all current task-mode mismatches; do not bless them.

4. **Low-cost mode expansion**
   - Parameterize the same fixture and fleet runner over query, heartbeat, and
     maintenance.
   - Fix mode-specific differences and make `--mode all` the justfile gate.

5. **Negative controls and closeout**
   - Complete byte/metadata mutation tests.
   - Run the hermetic integration suite and live fleet gate.
   - Install only if production package changes require it, then smoke the real
     task-mode `hrcchat dm`/`hrc run` surface under the normal repository
     closeout doctrine.

## Acceptance criteria

Implementation is complete only when:

1. The task-mode hermetic comparison passes through both independent producer
   seams.
2. Every valid live agent passes task-mode prompt, reminder, catalog, and package
   byte parity.
3. Query, heartbeat, and maintenance use the same implementation and pass the
   hermetic and live matrices.
4. Fleet validation fails on unexpected invalid, stale-excluded, or omitted
   candidates.
5. No replay row executes a live command or service probe.
6. All negative controls fail for their intended reason.
7. Failure output identifies the exact `(agentId, runMode, logicalPath)` and
   first differing byte.
8. The verifier has no bless, normalization, or producer-specific exception
   path beyond logical absolute-path relocation and checked-in invalid-agent
   exclusions.

## Locked decisions

- The owning package is `spaces-integration-tests`.
- Task mode is implemented and debugged first.
- All four closed run modes are included through one parameterized runner.
- Producers are observed independently; shared helper self-comparison is not
  evidence.
- The projection is verifier-only and versioned `agent-resource-parity/v1`.
- ASP-authored prompt/reminder bytes and effective ASP skill catalog/package
  bytes are exact; vendor base prompts and absolute materialization locations
  are excluded.
- Differences are fixed in producers or reviewed as a contract change; they are
  never blessed locally.
