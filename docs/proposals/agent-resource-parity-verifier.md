# Agent Resource Parity Verifier

- **Status:** deployed baseline; direct-loader revision accepted in `hrcchat#20779`
- **Date:** 2026-08-24
- **Owner:** agent-spaces
- **Primary package:** `spaces-integration-tests`
- **Architecture authority:** `agent-spaces.agent-harness-runtime-boundary`

## Decision

Retain the deployed test-only verifier, but change its direct producer from the
compiler-materializing `agent-harness-sdk` to the custom `ResourceLoader` in
`agent-harness-runtime`. The verifier independently asks the compatibility
compiler and the direct loader to resolve the same agent placement, projects
their ASP-authored prompts and effective skills into a stable observation
format, and byte-compares the two projections.

Task mode is the product priority because ordinary `hrcchat dm` and `hrc run`
placements use `runMode: "task"`. The implementation must establish task-mode
parity first. Query, heartbeat, and maintenance use the same runner with a
different `RunMode` value and scope fixture, so they are included as table-driven
coverage rather than separate machinery.

The verifier belongs in the private `spaces-integration-tests` package. It must
not live in either producer: making the compiler depend on
`agent-harness-runtime`, or the runtime depend on the compiler, would weaken the
independent-producer test.

## Current evidence and reopened boundary

The deployed verifier passes all four modes for the current live fleet: 41
valid agents, one exact invalid-root exclusion, and 164 compared rows. That
evidence proved parity between the compiler and the initial SDK implementation,
but the SDK achieved its result by consuming the Pi adapter's generated merged
bundle.

The agent-harness rewrite intentionally removes that materialization. The gate
must therefore be preserved while changing only the direct observation seam:
the compatibility producer still observes real compiler output, while the
direct producer observes the reloaded `AgentSpacesResourceLoader` constructed
from ordered raw/snapshot ASP sources. There is no baseline or bless operation
that makes a regression acceptable.

## Goals

- Prove task-mode prompt, reminder, skill-catalog, and skill-package parity for
  every valid agent under `~/agents`.
- Cover query, heartbeat, and maintenance through the same parameterized code.
- Exercise the compiler and direct resource-loader integration seams
  independently.
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
      observe-direct-loader.ts
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

`integration-tests/package.json` carries an explicit workspace dependency on
`agent-harness-runtime` and a `verify:agent-resources` script. The root justfile
exposes:

```text
just verify-agent-resource-parity
```

The root recipe invokes the integration-test binary; it does not duplicate the
comparison logic in a shell script.

## Comparison matrix

The matrix key is `(agentId, runMode)`. A passing row cannot mask another row.

| Mode          | Scope fixture                                   | Priority             |
| ------------- | ----------------------------------------------- | -------------------- |
| `task`        | `agent:<id>:project:agent-spaces:task:T-PARITY` | Required first       |
| `query`       | `agent:<id>:project:agent-spaces`               | Same-runner coverage |
| `heartbeat`   | `agent:<id>:project:agent-spaces`               | Same-runner coverage |
| `maintenance` | `agent:<id>:project:agent-spaces`               | Same-runner coverage |

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

### Direct resource-loader observation

Construct `AgentSpacesResourceLoader` through the same inspectable runtime
factory used by `createAgentHarnessRuntime()`, with the identical placement and
replay context, and await `reload()`. Observe prompt mode/content, reminder
presence/content, diagnostics, and source attribution from that loader.

Skill evidence comes from `getSkills()` on that production loader. The verifier
must not carry a second implementation of ASP source resolution, Pi discovery,
precedence, frontmatter parsing, or duplicate handling. It must also assert that
the observed loader has no generated bundle root among its sources.

The parity scope is ASP-owned skill roots explicitly delivered by the runtime.
Vendor/user/project ambient Pi directories are outside this equivalence and are
disabled in production. The inspection helper identifies entries originating
from declared mutable or immutable-snapshot ASP roots without changing
production discovery behavior. A same-name collision that changes the selected
ASP entry is a parity failure rather than an ambient exception.

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
  name: string;
  description: string;
  disableModelInvocation: boolean;
  filePath: `skill://${string}/SKILL.md`;
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
  | { path: string; kind: "file"; mode: number; size: number; sha256: string }
  | { path: string; kind: "symlink"; target: string }
  | { path: string; kind: "directory" };
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

## Direct source-root seam

Do not infer a generated `outputPath/skills` in `agent-harness-runtime` or the
verifier.

The shared non-materializing source resolver returns the ordered raw `@dev` and
immutable-snapshot roots selected by the lock/closure plus agent-local inputs.
The direct loader consumes those exact roots. The compiler independently lowers
the same semantic closure into the external harness's required materialized
shape.

The package-level unit test must prove that a composed space skill and an
agent-local skill reach the reloaded Pi loader with the declared ASP precedence,
while no `bundle.json`, `.asp-materialized.json`, or merged Pi skill directory is
created by the direct observation.

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

`spaces-config`:

- the direct source resolver returns ordered raw/snapshot roots without calling
  a harness adapter or target materializer;
- immutable source acquisition and mutable `@dev` resolution follow the lock;
- agent-local and composed resources follow existing precedence.

`agent-harness-runtime`:

- task id and lane reach prompt interpolation;
- caller-supplied resolver context is used unchanged;
- the inspectable resource loader is the loader passed to every Pi session
  construction/replacement;
- composed and local skills appear in its effective catalog; and
- direct observation creates no generated harness bundle.

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

## Revision sequence

The original prompt/replay projection, fleet inventory, four-mode runner, and
negative controls remain in place. Revise only the direct producer:

1. Add the non-materializing source resolver and direct-loader inspection seam.
2. Replace the `agent-harness-sdk` observer with the production
   `AgentSpacesResourceLoader` observer.
3. Add a negative control that injects a generated bundle root and proves the
   direct observer rejects it.
4. Re-run the hermetic matrix and all existing mutation controls.
5. Re-run the complete live fleet gate against a clean ASP home and assert that
   direct rows leave no compiler-materialization residue.
6. After installation, smoke both the foreground TUI and HRC broker paths; each
   must report the same loader-backed resources.

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
9. The direct observer uses `AgentSpacesResourceLoader` and rejects/does not
   create compiler-generated bundle roots.

## Locked decisions

- The owning package is `spaces-integration-tests`.
- Task mode is implemented and debugged first.
- All four closed run modes are included through one parameterized runner.
- Producers are observed independently; shared helper self-comparison is not
  evidence.
- The projection is verifier-only and versioned `agent-resource-parity/v1`.
- ASP-authored prompt/reminder bytes and effective ASP skill catalog/package
  bytes are exact; vendor base prompts and producer-specific absolute source or
  materialization locations are excluded.
- The direct producer is Pi's production custom resource loader over ordered
  ASP sources, never compiler/adapter materialization.
- Differences are fixed in producers or reviewed as a contract change; they are
  never blessed locally.
