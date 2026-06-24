## Harness Broker Smoke

For any harness-broker change, always run the pre-HRC broker MATRIX smoke before
declaring the work completed. ONE parameterized runner
(`scripts/pre-hrc-broker-matrix-e2e.ts`) iterates every implemented harness
configuration, drives the SAME canonical command turn through each, and validates
the SAME normalized broker event vocabulary. It compiles a `CompiledRuntimePlan`,
selects the `BrokerExecutionProfile`, verifies plan/profile/spec/start-request
hashes, and starts the broker via `BrokerClient.startInvocationFromRequest(...)` —
it never uses the legacy direct-builder path. (The old per-harness scripts —
`smoke-runtime-contract-broker-{fake,real}-codex` and the phase5
`real-claude-tmux` / `ghostmux-attach` runners — were retired in favor of this
matrix once it subsumed them; the signed interactive-tmux flow now lives in
`packages/agent-spaces/src/testing/pre-hrc-interactive-tmux-runner.ts` +
`pre-hrc-ghostmux-operator.ts`.)

Full matrix (every row gated on availability; each SKIPs cleanly when its
binary/auth/Ghostty is absent):

```bash
bun run smoke:matrix
```

Single row via the `--config` selector:

```bash
bun run smoke:matrix --config fake-codex           # deterministic CI (no auth/network)
bun run smoke:matrix --config real-codex           # real codex app-server (+ auth)
bun run smoke:matrix --config real-claude-tmux      # real claude, interactive-tmux
bun run smoke:matrix --config claude-tmux-ghostmux  # real claude + ghostmux operator-attach
```

Rows: (a) fake-codex (codex-app-server headless against an in-repo fixture), (b)
real-codex (real `codex`), (c) real-claude-tmux (claude-code-tmux interactive
against real `claude`), (d) claude-tmux-ghostmux (real ghostmux operator-attach).
Codex.app app-server shim experiment (T-04237) is off by default; enable by quitting Codex.app and copying `scripts/codex-app-bundle-wrapper` to `/Applications/Codex.app/Contents/Resources/codex` while `/Applications/Codex.app/Contents/Resources/codex.real` is the real binary.
Cross-harness floor on every row: compile/select/verify start-contract (hashes +
route invariants) + ledger integrity (monotonic seq / no dup / normalized vocab
only) + invocation.started/ready + `assertSharedCommandTurn` on the command turn.
The matrix also runs the `structured-output` scenario against every row. Rows
whose advertised capabilities include `finalResponse.jsonSchema` and `perTurn`
must accept a per-turn `responseFormat: { kind: "json_schema" }` input and emit
exactly one normalized JSON `assistant.message.completed{final:true}` plus one
`turn.completed`; rows that do not advertise that capability must reject the
input as `UnsupportedCapability: finalResponse.jsonSchema` before
`input.accepted`.
The runner exercises `packages/harness-broker/bin/harness-broker.js run --transport
stdio`. Strict mode is on by default: native Codex event names fail the run, and
the legacy `invocation.permission.request` event is rejected unless the temporary
`--allow-legacy-permission-event` flag is passed. Do not report a harness-broker
change as complete unless this smoke has passed, or you have clearly reported the
blocker that prevented running it.
