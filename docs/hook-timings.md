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
