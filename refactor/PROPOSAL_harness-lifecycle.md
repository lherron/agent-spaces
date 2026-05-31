# Proposal: harness lifecycle policy — idle self-retire + turn-stall recovery

**Status:** for offline review. No spec or impl files changed yet — everything gated on approval. No wrkq task filed yet.
**Authors:** clod + cody.

---

## TL;DR

Non-interactive broker harnesses (e.g. ariadne over Discord, redirected into the `claude-code-tmux` broker per T-01761) currently run forever once started and have no recovery when a turn hangs. This proposal adds two lifecycle policies to the **harness-broker contract** — **idle self-retire** and **turn-stall recovery** — set by HRC and implemented by the broker, plus the broker **event additions** needed to project both.

The governing boundary (Lance):

> Harness lifecycle **policy is set by HRC** but **implemented in the broker harness**. Keep-alive, TTL, and cleanup policy are part of the **broker harness contract**. HRC always owns the running processes for both broker and harness; the broker owns the logic for how to manage harnesses and their lifecycle.

Two policies, both carried in the hashed start spec:

1. **`spec.lifecycle`** — idle self-retire. After `idleTtlMs` with no turn, the broker gracefully exits the harness (`/quit` for `claude-code-tmux`, process terminate for `codex-app-server`); HRC reclaims the now-ownerless lease.
2. **`spec.turnPolicy.stall`** — turn-stall recovery. If a turn is `turn_active` for more than `maxSilentMs` with no emitted event, the broker assumes the harness died and **force-kills + respawns** the harness child *in the same pane* (bounded by `maxRetries`), then resumes via continuation.

A key code finding (§3) makes #2 cheap and keeps the ownership boundary intact: the leased tmux pane already runs a **persistent bun supervisor** (`tmux-launch-runner`) that `spawn`s the harness as a child — not an `exec` replacement. Making that runner **respawn-capable** gives the broker true in-pane hard recovery **without any tmux lifecycle authority** (no `kill-server`/`kill-session`/`respawn-pane`) and **without HRC reaping the lease**. §8.2 and §7.2 are untouched.

---

## 1. Motivation

Two gaps in the current broker-capable runtime lifecycle:

1. **No retirement.** After T-01761, a non-interactive Claude turn (ariadne/Discord) runs on an `interactive=true` `claude-code-tmux` harness in an HRC-leased pane. Once started it stays resident indefinitely. There is no idle reaper for broker-tmux runtimes — the existing `reconcileTmuxRuntimeLiveness` only marks a runtime stale lazily when something *touches* it and finds the pane already dead; there is no time-based retirement of a *healthy-but-idle* harness.

2. **No turn-stall recovery.** If the harness process hangs or dies mid-turn, the only existing backstop is the coarse HRC zombie-run sweep (`HRC_ZOMBIE_RUN_TIMEOUT_SECONDS = 1800`, "no events for 30 minutes → reap the run"). There is no fine, per-turn, bounded retry that kills a hung harness and resumes the session.

Both are **harness lifecycle management** — the broker's domain — parameterized by **policy** — HRC's domain.

---

## 2. Separation of duties

The boundary in one line: **the broker _monitors and controls_ the harness (live, soft); HRC _owns and reaps_ the processes/resources (durable, hard) and sets policy.**

| Concern | **HRC** — owns & reaps | **Broker** — monitors & controls |
| --- | --- | --- |
| Broker **process** (1 per runtime, §8.3) | spawn, supervise, reap/GC | runs in it |
| Harness **process** + tmux pane/lease + runner | allocate, **hard-reap, orphan-GC, final cleanup** | uses the handle; live soft-control only |
| Lifecycle **policy** (`spec.lifecycle`, `spec.turnPolicy`) | **sets** (in hashed spec) | **reads & honors** |
| Idle / stall **detection clocks** | — | **owns** |
| **Soft + recycle mechanics** (`/quit`, interrupt, force-kill-respawn child) | — | **owns** |
| **Hard reap** of an unresponsive/orphaned container | **owns** (backstop) | emits escalation intent only |
| Normalized **events** | persists/projects | **emits** |

This sharpens §8.1's "child process supervision": it means **live logical supervision / soft-control** by the broker, **not** durable OS ownership. HRC remains the durable process/resource authority and the hard-reap backstop — including when the broker or runner itself dies.

The split is recursive on the tmux pane: HRC owns the **pane / lease / runner** as the durable *container*; the broker owns the **harness child** lifecycle (spawn / kill / respawn) *inside* that container. Killing or respawning the harness child is a **process** operation, not a tmux **lifecycle** operation — so it stays on the broker's side of §8.2 without amendment.

---

## 3. Grounding: what the leased pane actually runs today

Verified against `packages/harness-broker/src/runtime/tmux-launch-runner.ts` and `tmux-launch-exec.ts`:

```text
tmux pane → `exec bun <runner> --launch-file <json>`   # exec REPLACES the pane shell with the bun runner
         → runner spawn()s the harness as a CHILD       # node spawn(), stdio:'inherit'; NOT an exec-replace
```

So the pane's top process is the **runner**, and the harness (claude/codex) is the runner's **child** with the pane TTY inherited. The runner is already a supervisor. The only reason a harness kill leaves a bare/dead pane today is one design choice — the runner **mirrors** the child's exit:

```js
child.on('exit', (code, signal) => signal ? process.kill(process.pid, signal) : process.exit(code))
```

i.e. when the harness dies, the runner deliberately dies too. **That is a policy, not a constraint.** Making the runner **respawn-capable** (a `recycle` command: kill the child, respawn the harness in the same pane) unlocks broker-owned in-pane hard recovery with no tmux lifecycle command, no lease reallocation, and no HRC reap. `codex-cli-tmux` shares the same runner; `codex-app-server` spawns its harness as the broker's own direct child, so it is already trivially recyclable.

This is why turn-stall recovery (§5) can be a real **force-kill-respawn**, not a best-effort interrupt.

---

## 4. `spec.lifecycle` — idle self-retire

### 4.1 Policy shape (hashed start spec; §8.7, §7.4 step 11; FINAL_DATATYPES `HarnessInvocationSpec`)

A discriminated union, sibling of `spec.interaction` (interaction describes turn semantics; lifecycle describes retention/cleanup):

```text
spec.lifecycle =
  | { mode: 'keep-alive' }                                              // never idle-reaped
  | { mode: 'idle-ttl', idleTtlMs, cleanup:
        { mode: 'graceful-quit' | 'terminate-process', graceMs } }
  | { mode: 'none' }                                                    // explicit unmanaged/test only
```

HRC sets it per dispatch class — and this **is** the interactive/non-interactive discriminator (it replaces a separate marker): an attached `hrc run` gets `keep-alive`; a redirected non-interactive turn gets `idle-ttl`. Because it lives in the **hashed** spec it is durable, auditable, and re-sent verbatim after a broker restart. Contradictory states SHOULD be unrepresentable: `keep-alive` carries no TTL; `idle-ttl` requires `idleTtlMs > 0` and a cleanup mode.

### 4.2 Behavior (broker)

The broker MUST track an idle clock that **resets on `input.accepted` and on any turn terminal** (`turn.completed`, `turn.failed`, `turn.interrupted`), and is **evaluated only in `ready` with an empty input queue** (never `turn_active`, never with queued input). On `now − lastActivity > idleTtlMs` in that state:

- `claude-code-tmux`: a **driver-internal lifecycle send** of `/quit` to the leased pane (using the existing pane send capability) — this MUST NOT create a turn or emit `input.accepted`. Poll for the harness to leave the foreground up to `graceMs`.
- `codex-app-server`: driver `stop()` → `terminateProcess({ graceMs })`.

The runner mirror-exits when the harness leaves (idle wants teardown), so the pane goes bare and HRC reclaims the lease (§6.2 `retire` mode).

### 4.3 Terminal semantics

- success before `graceMs`: `invocation.stopping{reason:'idle-ttl'}` → `harness.exited{reason:'idle-ttl'}` → `invocation.exited{reason:'idle-ttl', droppedContinuation:false}`.
- grace-timeout: **not** a clean exit — `invocation.failed{reason:'idle-ttl-timeout'}` (HRC treats as stale/failure; force-reclaim is a later decision, out of scope here).

---

## 5. `spec.turnPolicy.stall` — turn-stall recovery

### 5.1 Policy shape (hashed start spec)

```text
spec.turnPolicy.stall = {
  maxSilentMs,                      // turn_active with no emitted event for longer than this ⇒ assume dead
  maxRetries,                       // bound on recovery attempts per turn
  action: 'force-kill-respawn',     // primary, for respawn-capable runners; 'interrupt-resubmit' fallback
  onUnresponsive: 'hard-reap-required',  // escalate to HRC when in-pane recovery cannot progress
  onExhaust: 'fail',
}
```

### 5.2 Two-tier recovery

- **Tier 1 — broker, in-pane (primary).** On stall in `turn_active`, the broker requests the runner to **recycle**: force-kill the harness child (process-group signal where practical), respawn the harness in the **same pane** with `--resume <continuation>` (not the launch priming), and re-drive the turn. Bounded by `maxRetries`. `action:'interrupt-resubmit'` (Ctrl-C → wait-ready → resubmit) is the degraded fallback for drivers/runners without respawn.
- **Tier 2 — HRC hard backstop (narrow).** Only when in-pane recovery cannot progress — the **runner itself** is gone/unresponsive, or `maxRetries` is exhausted — the broker emits `lifecycle.escalation{runtimeAction:'hard-reap'}`; HRC hard-reaps the container and the next dispatch cold-starts with continuation.

This **supersedes** the coarse HRC zombie sweep as the *fine, primary* path for live brokers; the HRC sweep remains the coarse backstop for broker-gone runtimes.

### 5.3 ⚠️ Mid-turn idempotency (normative caveat)

Idle-TTL is *between* turns and continuation-safe. **Stall recovery is mid-turn and is at-least-once.** `--resume` after a mid-turn kill is **not** guaranteed to land on an exact turn boundary (true for **both** Claude and Codex); a retry MAY duplicate user input, drop partial assistant output, or **replay tool side-effects**. Therefore the broker MUST:

- resubmit the same `inputId` **only** when the driver can prove the prior turn did not complete;
- dedupe late terminal events from the killed generation (§9 fencing);
- surface `attempt` on turn events;
- for **tool-use turns**, treat retry conservatively — it MAY be disabled, or require explicit idempotency, by policy.

Recycle improves recovery *mechanics*, not *semantic* exactly-once.

---

## 6. Respawn-capable runner + recycle control channel

### 6.1 Control channel

The broker drives the runner over an explicit **control channel** — a unix socket under the private runtime area (alongside the hook sockets), scoped to the invocation/runtime — **not pane text**. Narrow verbs: `recycle`, `retire`, `status`. The runner holds command state so it can distinguish:

- child exits while `mode = recycle` → **respawn** child, runner stays alive;
- child exits while `mode = retire` (idle/normal quit) → runner **mirror-exits**, HRC reaps the lease;
- child crashes unexpectedly → mirror-exit / report (default), unless policy says restart.

Default child-exit behavior remains mirror-exit so crash/idle teardown still reaches HRC and never leaves a zombie supervisor.

### 6.2 Two runner modes

- **recycle** (stall): kill child → wait → respawn harness in the same pane → preserve runner. No HRC reap.
- **retire** (idle): broker `/quit` (or driver cleanup) → child exits → runner mirror-exits → HRC reclaims pane/lease.

### 6.3 Implementation caveats (carry into impl)

1. **Recycle argv ≠ launch argv.** The original launch artifact carries launch priming; a post-stall recycle MUST respawn with `--resume <continuation>` and skip re-priming. The broker supplies replacement argv/env on recycle, or the launch artifact encodes a recycle strategy.
2. **Kill the process *tree*.** Claude/Codex spawn descendants — prefer process-group signaling, but only if it does not break the pane TTY; otherwise document the limitation and smoke it.
3. **Hook-socket attribution.** The respawned harness keeps the same invocation, so the killed child's late hooks MUST NOT leak. Recycle SHOULD mint/rotate the per-attempt hook socket (the same mechanism validated in T-01771 + the HRC `consumeEvents` guard). See §9 generation fencing.

---

## 7. Capability contract additions (§8.6 hello, §9; FINAL_DATATYPES driver caps)

Drivers advertise lifecycle support in `broker.hello`:

```text
capabilities.lifecycle = {
  idleTtl: boolean,
  cleanupModes: ('graceful-quit' | 'terminate-process')[],
  turnRetry: boolean,
  recycle: 'in-pane-runner' | 'direct-child' | 'none',   // how the harness child is killed+respawned
}
```

`recycle` describes *how* the broker recycles the harness child, not whether a tmux runner exists:

- `claude-code-tmux`: `{ idleTtl:true, cleanupModes:['graceful-quit'], turnRetry:true, recycle:'in-pane-runner' }` — kills+respawns via the respawn-capable runner in the leased pane.
- `codex-app-server`: `{ idleTtl:true, cleanupModes:['terminate-process'], turnRetry:true, recycle:'direct-child' }` — no pane/runner; the broker owns the harness as its **own direct child** and recycles it by re-spawning the process. Validators MUST key off `turnRetry` + `recycle != 'none'`, **not** assume a tmux runner.
- `codex-cli-tmux`: `cleanupModes:[]` / `recycle:'none'` until a real `/quit` + in-pane recycle smoke proves it.

Per §9, HRC MUST reject (no silent degrade) any policy whose cleanup/recovery mode is not advertised by the selected driver.

---

## 8. Lifecycle state machine changes (§8.8)

Two additions to the invocation state machine, plus a new **harness-generation** inner lifecycle:

- **Broker-initiated idle stop:** `ready --idle-ttl--> stopping` MAY be initiated by the broker (today `ready -> stopping` is implicitly HRC-commanded). `stopping -> exited -> disposed` unchanged.
- **Turn-stall recycle (self-loop):** `turn_active --stall--> [harness recycle] --> turn_active`; after `maxRetries`, `turn_active --> failed`.
- **Harness generation:** the **invocation** is the durable container; a **harness generation** is one spawn of the harness child. A recycle ends one generation and starts the next *within the same invocation*. `invocation.*` stays container-level; `harness.*` (§9) covers the child-spawn lifecycle. `harnessGeneration` is **1-based** and **distinct** from HRC session/runtime `generation`.

---

## 9. Broker event additions (extends §8.10)

### 9.1 New event families

| Event | Payload | Meaning |
| --- | --- | --- |
| `harness.started` | `{ harnessGeneration, mode:'initial'\|'recycle', pid?, argvHash?, resumeKey? }` | Harness child spawned. Gen 1 = `initial`; recycles = `recycle`. Authoritative child-spawn event. |
| `harness.exited` | `{ harnessGeneration, reason:'quit'\|'crash'\|'recycle-kill'\|'idle-ttl', code?, signal? }` | Harness **child** ended — distinct from `invocation.exited`. |
| `turn.stalled` | `{ inputId, turnId, silentMs, thresholdMs, harnessGeneration }` | Stall clock tripped in `turn_active`. |
| `turn.retry` | `{ inputId, priorTurnId, newTurnId, attempt, action:'force-kill-respawn'\|'interrupt-resubmit', reason:'stall', fromHarnessGeneration, toHarnessGeneration? }` | Recovery attempt initiated. `fromHarnessGeneration` = the generation being retired; `toHarnessGeneration` (when known) = the respawned generation, also carried on the subsequent `harness.started`. |
| `lifecycle.escalation` | `{ reason:'stall-unrecoverable'\|'idle-quit-timeout'\|'runner-degraded', runtimeAction:'hard-reap', harnessGeneration, inputId?, turnId?, attempts? }` | Broker → HRC: cannot self-recover; HRC enacts hard-reap backstop. |

Optional diagnostics (non-normative): `harness.recycle_requested`, `harness.recycle_failed`, `turn.retry_exhausted`.

### 9.2 Extensions to existing §8.10 events

- `invocation.stopping` += `{ reason }` — normative enum `idle-ttl | operator-stop`. `invocation.stopping` is **only** for graceful/operator stops; failure reasons (`idle-ttl-timeout`, `stall-unrecoverable`, `runner-degraded`) go **straight to `invocation.failed`** without passing through `stopping`.
- `invocation.exited` += `{ reason, droppedContinuation }`
- `invocation.failed` += `{ reason }` — `idle-ttl-timeout | stall-unrecoverable | runner-degraded`
- `turn.failed` += `{ reason:'stall-max-retries', attempts }` — terminal semantic for exhausted retries
- `turn.started` += `{ attempt }`
- `invocation.started` += `{ lifecyclePolicy, harnessGeneration:1 }` — audit echo; `harness.started` remains authoritative
- `continuation.updated` += `{ harnessGeneration, reason:'initial'|'recycle'|'resume' }` — latest-wins, no special merge
- `usage.updated` += `{ harnessGeneration }` — aggregate by turn/attempt
- `permission.requested` / `permission.resolved` += `{ harnessGeneration }`
- `terminal.surface.reported` — re-emitted **idempotently** on `harness.started{mode:'recycle'}` (same surface ids, new `harnessGeneration`); not a new lease.

### 9.3 Generation fencing (normative)

Events whose `harnessGeneration` ≠ the invocation's current generation MUST be dropped or emitted only as stale diagnostics — **never projected into the active turn**. This is the contract-level form of the T-01771 leak fix. Generation SHOULD be paired with the per-attempt hook-socket / `hookAttemptId` internally.

On recycle, every outstanding permission request from the old generation MUST be cancelled: `permission.resolved{ decision:'cancelled', reason:'harness-recycled', harnessGeneration }`. HRC/ACP MUST fence permission responses by `invocationId + permissionRequestId + harnessGeneration`, so a late approval cannot land on the recycled harness.

### 9.4 Input disposition on retry

The broker MUST NOT emit a second `input.accepted` for a retried input — it was already accepted; retries are expressed via `turn.retry` + `attempt`. Queued inputs stay queued and MUST NOT be replayed until the active retry resolves or fails.

---

## 10. HRC projection + control-plane behavior

- `invocation.exited{reason:'idle-ttl'}` → **clean `runtime.terminated`** (`droppedContinuation:false`, **not** stale). *This is the one HRC projection-mapping change.*
- **Ordering requirement:** HRC MUST project this clean `idle-ttl` terminal from the explicit `invocation.exited` event **before** liveness reconcile (`reconcileTmuxRuntimeLiveness`) can observe the now-bare pane and classify it `broker_tmux_harness_not_live`. The explicit terminal-event path takes precedence over stale-liveness discovery, so a clean idle retire never surfaces as `stale`.
- `harness.exited{reason:'recycle-kill'}` followed by `harness.started{mode:'recycle'}` → runtime stays **live**, bump `harnessGeneration`, **no lease reap**.
- `harness.exited{reason:'crash'}` with no successful recycle per policy → existing stale/failure, or `lifecycle.escalation`.
- HRC MUST NOT treat `harness.exited` alone as runtime-terminal unless the invocation also terminates or an escalation requests hard-reap.
- `lifecycle.escalation{runtimeAction:'hard-reap'}` → HRC enacts hard-reap (existing dispose/sweep, §7.1, §7.13).
- HRC sets `spec.lifecycle` / `spec.turnPolicy.stall` per dispatch class, validates policy ⊆ capability (§9), and persists policy + generation transitions via the existing `broker_invocation_events` ledger.
- Broker-died / restart orphans fall to §7.13's conservative reconcile + "do not kill unrelated harness processes" — the orphan-GC backstop, unchanged.

---

## 11. What does NOT change

- **§8.2** — broker still forbidden from all tmux lifecycle commands (`kill-server`/`kill-session`/`respawn-pane`/…). Killing/​respawning the harness **child** is a process op via the runner, not a tmux op.
- **§7.2** — HRC still owns the concrete tmux pane lifecycle; the broker still receives a pane handle, not lease-allocation authority.
- No new `allowedOps.releaseLease`; no lease teardown moved into the broker.

The entire feature lands **without amending the HRC/broker pane-ownership boundary.**

---

## 12. Acceptance tests (real e2e via virtu)

1. **Idle self-retire + durable continuation.** Establish a codeword; let the runtime idle past `idleTtlMs`. Assert `invocation.exited{reason:'idle-ttl', droppedContinuation:false}`, HRC records **terminated (not stale)**, GC reclaims the socket without ever marking the runtime stale, and the next turn cold-starts `claude --resume <same key>` and recalls. Repeat once forcing the grace-timeout → honest-failure path.
2. **Turn-stall recycle.** Wedge a turn (no events) past `maxSilentMs`. Assert `turn.stalled` → `turn.retry{action:'force-kill-respawn'}` → `harness.exited{reason:'recycle-kill'}` → `harness.started{mode:'recycle'}` in the **same pane** (no new lease, runtime stays live), the resumed turn completes, and generation-fenced stale hooks from the killed child are dropped (no leak). Repeat to `maxRetries` and assert terminal `turn.failed{reason:'stall-max-retries'}` + `lifecycle.escalation` → HRC hard-reap.
3. **Concurrent isolation across recycle.** Run a second `claude-code-tmux` invocation concurrently while a recycle happens; assert no cross-generation / cross-invocation event leakage (extends the T-01771 concurrent-pane test).

---

## 13. Contract edit summary

| Section | Edit |
| --- | --- |
| §8.7, §7.4 | add hashed `spec.lifecycle` + `spec.turnPolicy.stall` to `HarnessInvocationSpec` |
| §8.6, §9 | add `capabilities.lifecycle{ idleTtl, cleanupModes, turnRetry, recycle }`; HRC validates policy ⊆ capability (key off `turnRetry` + `recycle != 'none'`, not a tmux runner) |
| §8.8 | broker-initiated `ready→stopping (idle-ttl)`; `turn_active` stall self-loop; harness-generation inner lifecycle |
| §8.10 | new `harness.*`, `turn.stalled`, `turn.retry`, `lifecycle.escalation`; `reason`/`harnessGeneration`/`attempt` field extensions; generation fencing + permission cancellation |
| §8.12 | driver honors `spec.lifecycle`/`spec.turnPolicy` autonomously; runner gains recycle/retire control channel |
| §7 (HRC) | set policy by dispatch class; `idle-ttl` exited → clean `runtime.terminated`; hard-reap on escalation; generation/permission fencing on the consuming side |

FINAL_DATATYPES.md: add `spec.lifecycle`, `spec.turnPolicy.stall`, `capabilities.lifecycle`, the `harness.*` event payloads, and the new `reason`/`harnessGeneration`/`attempt` fields.

No amendments to §8.2 or §7.2.

---

## 14. Open decisions

1. **Default `idleTtlMs`** for non-interactive Discord agents (suggest **30 min**); per-harness or one global value.
2. **Default `maxSilentMs` / `maxRetries`** for turn-stall (suggest e.g. **3–5 min** silent, **2** retries); whether tool-use turns default retry **off**.
3. **Scope of first cut:** `claude-code-tmux` + `codex-app-server`, with `codex-cli-tmux` gated on a recycle smoke.
4. **Generation numbering:** 1-based (recommended) vs 0-based — pick and state explicitly.

## 15. Implementation ownership (for a later wrkq task — not filed yet)

- **HRC half (clod):** `spec.lifecycle`/`spec.turnPolicy` plumbing through compile/dispatch, capability validation, the `idle-ttl → runtime.terminated` projection mapping, generation/permission fencing on the consume side, hard-reap backstop, policy-by-dispatch-class.
- **Broker/driver half (cody):** capability decls, idle self-retire, force-kill-respawn + the respawn-capable runner with the recycle/retire control channel, the new `harness.*`/`turn.*`/`lifecycle.*` events, generation tagging + stale-hook fencing.
