# Git hook timing telemetry

The installed Lefthook `pre-commit` and `pre-push` entrypoints record local timing telemetry for normal Git operations. The wrapper preserves hook stdin, output, and exit status; telemetry write failures print a warning but never change the hook result.

Records are append-only JSONL under the Git common directory:

```text
$(git rev-parse --git-common-dir)/praesidium/hook-timings.jsonl
```

Using the common directory keeps one history across linked worktrees without dirtying any checkout. Hook records contain total duration, result, change classification, Git identity, platform, and tool versions. Step records contain each Lefthook command's duration and pass, failure, or skip result. Records do not contain changed filenames, command output, or secrets.

Report the last 30 days:

```bash
bun run hook:stats
```

Choose a window or emit machine-readable output:

```bash
bun run hook:stats --since 7d
bun run hook:stats --since 4w --json
```

The report shows invocation counts, pass/failure/skip counts, p50, p95, maximum duration, and the slowest steps. Explicit hook bypasses such as `LEFTHOOK=0` do not execute and therefore cannot record telemetry.

Each completed hook run also starts a best-effort, detached `wrkp post agent-spaces --type hook.settled`. The fact uses the hook finish time and `hook:<run_id>` as its idempotency key. Step records stay local. If posting fails, the hook keeps its own exit status and the JSONL record remains available for replay.

Replay all local hook records, including any missed live posts:

```bash
bun run hook:backfill
```

The command reports created, existing, and failed counts. Repeating it reports the same facts as existing. Historical records do not store the node name, so replay attributes them to the host running the command.

## Optimized execution policy

Pre-commit checks run concurrently. Workspace builds use package-manifest dependencies to run
independent packages in bounded topological layers; set `ASP_BUILD_CONCURRENCY` to override the
default concurrency.

Pre-push receives the exact pushed change set from the timing/scope wrapper. The fast test runner
always executes the small contract suite, adds the changed workspace and its downstream consumers,
and fails safe to the full allowlist for ambiguous or repository-wide changes. Independent suites
run with bounded concurrency; set `ASP_TEST_CONCURRENCY` to override the default. Direct
`bun run test:fast` calls have no pushed change set and therefore run the full allowlist.

Public-surface validation runs only when a workspace package manifest, package source, baseline, or
the checker itself changes. Documentation-only and unrelated tooling changes are recorded as
skipped steps, so the timing history preserves those decisions.
