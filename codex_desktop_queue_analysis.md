# Codex Desktop Queue Analysis

Date observed: 2026-09-08

Codex source checkout: `/Users/lherron/tools/codex` at `dfea985976`

Installed CLI: `codex-cli 0.153.4`

Desktop-bundled CLI/app-server: `codex-cli 0.153.3`

## Conclusion

`codex queue` does not need to attach to the Codex desktop app's private stdio
connection or call its `codex_app` MCP server. For a normal local invocation it
can start a short-lived embedded app-server, submit the experimental
`thread/queue/add` JSON-RPC request, and persist the message into the Codex
home's durable SQLite queue. The already-running desktop app-server observes
changes to that same queue database and starts the queued message when the
loaded thread becomes idle.

The important routing boundary is the Codex home, not the desktop PID. A queue
writer and the desktop process must resolve the same SQLite home.

This means an HRC-managed Cody session can queue to a desktop thread through the
supported CLI. It must unset the HRC-injected `CODEX_HOME` (or otherwise select
the desktop Codex home) so the CLI uses `/Users/lherron/.codex`:

```bash
env -u CODEX_HOME codex queue \
  --thread 01a08138-7d09-7e12-b8ba-d82b744d9a1e \
  --message 'Message text'
```

This is preferable to writing SQLite directly. The CLI/app-server route applies
thread lookup, archive and source restrictions, input validation, queue limits,
ID generation, serialization, and schema handling.

## Observed Runtime Topology

The desktop application was running as:

- GUI PID `66945`: `/Applications/ChatGPT.app/Contents/MacOS/ChatGPT`
- bundled app-server PID `67078`, parent PID `66945`
- bundle identifier `com.openai.codex`
- desktop application version `26.901.41123`

PID `67078` was launched as a stdio app-server by the desktop process. Its
command also configured the bundled `codex_app` MCP server and the
`send_message_to_thread` tool, but that MCP surface is private to the desktop
host and is not part of Cody's current tool inventory.

The desktop app-server had these relevant files open:

- `/Users/lherron/.codex/state_5.sqlite`
- `/Users/lherron/.codex/queue_1.sqlite`
- `/Users/lherron/.codex/queue_1.sqlite-wal`
- `/Users/lherron/.codex/queue_1.sqlite-shm`
- `/Users/lherron/.codex/thread-writer-locks/01a08138-7d09-7e12-b8ba-d82b744d9a1e.lock`
- `/Users/lherron/.codex/sessions/2026/09/08/rollout-2026-09-08T08-32-38-01a08138-7d09-7e12-b8ba-d82b744d9a1e.jsonl`

The target thread was present in the desktop state database with:

```text
id:     01a08138-7d09-7e12-b8ba-d82b744d9a1e
source: vscode
cwd:    /Users/lherron/praesidium/clients/hrc-ios
title:  Confirm you can see hrcmac and zed via computer use
```

No default app-server control socket was present at
`/Users/lherron/.codex/app-server-control/app-server-control.sock` during the
inspection. Therefore the successful ordinary-shell invocation was not a
direct socket call into PID `67078`; it used an embedded app-server and the
shared durable queue.

## End-to-End Source Trace

### 1. CLI command definition

The top-level CLI declares `queue` as “Queue a message for an existing
session” in
[`codex-rs/cli/src/main.rs`](</Users/lherron/tools/codex/codex-rs/cli/src/main.rs#L206>).

[`codex-rs/cli/src/queue_cmd.rs`](</Users/lherron/tools/codex/codex-rs/cli/src/queue_cmd.rs#L12>)
defines:

- required `--thread`, accepting a session UUID or exact name;
- required, non-empty `--message`;
- optional remote endpoint settings;
- config overrides shared with session-management commands.

`run_queue_command` rejects image attachments, resolves any explicit remote,
and delegates to the TUI library's session queue implementation:
[`queue_cmd.rs`](</Users/lherron/tools/codex/codex-rs/cli/src/queue_cmd.rs#L29>).

### 2. Codex-home and app-server selection

The queue implementation first resolves the Codex home and starts an app-server
session:
[`codex-rs/tui/src/session_queue_commands.rs`](</Users/lherron/tools/codex/codex-rs/tui/src/session_queue_commands.rs#L28>).

Codex-home resolution honors a non-empty `CODEX_HOME`; otherwise it defaults to
`~/.codex`:
[`codex-rs/utils/home-dir/src/lib.rs`](</Users/lherron/tools/codex/codex-rs/utils/home-dir/src/lib.rs#L5>).

The shared session-command startup code probes the default app-server daemon
socket only when the invocation has no explicit remote and its config can reuse
the daemon:
[`codex-rs/tui/src/session_archive_commands.rs`](</Users/lherron/tools/codex/codex-rs/tui/src/session_archive_commands.rs#L315>).

Target selection is:

- explicit `--remote`: connect to that endpoint;
- usable default control socket: connect to the local daemon;
- otherwise: run an embedded app-server in the CLI process.

See
[`codex-rs/tui/src/lib.rs`](</Users/lherron/tools/codex/codex-rs/tui/src/lib.rs#L891>).
The default socket is derived from the selected Codex home as
`app-server-control/app-server-control.sock`:
[`codex-rs/app-server-transport/src/transport/mod.rs`](</Users/lherron/tools/codex/codex-rs/app-server-transport/src/transport/mod.rs#L54>).

The supported app-server transports and socket framing are documented in the
source-tree app-server README:
[`codex-rs/app-server/README.md`](</Users/lherron/tools/codex/codex-rs/app-server/README.md#L20>).
The Unix socket uses a WebSocket upgrade and WebSocket frames; stdio uses JSONL.

### 3. `thread/queue/add` request construction

For a UUID target, the CLI parses the supplied value directly as a `ThreadId`.
For a name, it performs an exact active-session lookup, including
non-interactive sources. It then generates a UUIDv7 client message ID and sends
a typed `ClientRequest::ThreadQueueAdd` containing:

```text
thread_id
input = [{ type: text, text: message }]
client_user_message_id
```

See
[`codex-rs/tui/src/session_queue_commands.rs`](</Users/lherron/tools/codex/codex-rs/tui/src/session_queue_commands.rs#L80>).

The protocol registers `thread/queue/add` as an experimental method in
[`codex-rs/app-server-protocol/src/protocol/common.rs`](</Users/lherron/tools/codex/codex-rs/app-server-protocol/src/protocol/common.rs#L596>).
The client initializes app-server connections with experimental API support
enabled. The command also has explicit compatibility errors for remote or local
daemon versions that do not support this method.

The wire-level example and queue semantics are documented in
[`codex-rs/app-server/README.md`](</Users/lherron/tools/codex/codex-rs/app-server/README.md#L942>).

### 4. App-server validation and enqueue

The app-server dispatcher routes `ClientRequest::ThreadQueueAdd` to the queue
request processor:
[`codex-rs/app-server/src/message_processor.rs`](</Users/lherron/tools/codex/codex-rs/app-server/src/message_processor.rs#L1212>).

The processor:

1. validates image URLs;
2. parses and verifies the thread;
3. rejects missing, archived, ephemeral, or disallowed subagent targets;
4. converts the API input into internal `TurnInput`;
5. enqueues it through `QueuedItemService`;
6. returns the server-generated stable queue submission ID.

See
[`codex-rs/app-server/src/request_processors/thread_queue_processor.rs`](</Users/lherron/tools/codex/codex-rs/app-server/src/request_processors/thread_queue_processor.rs#L72>)
and the stored-thread checks at
[`thread_queue_processor.rs`](</Users/lherron/tools/codex/codex-rs/app-server/src/request_processors/thread_queue_processor.rs#L237>).

Queue support requires a local SQLite-backed thread store and state database.
The app-server builds `QueuedItemService` around `LocalQueueStore` in
[`codex-rs/app-server/src/message_processor.rs`](</Users/lherron/tools/codex/codex-rs/app-server/src/message_processor.rs#L290>).
`LocalQueueStore` delegates queue operations to the state runtime's
`SqliteQueueStore`:
[`codex-rs/thread-store/src/queue_store.rs`](</Users/lherron/tools/codex/codex-rs/thread-store/src/queue_store.rs#L55>).

### 5. Durable SQLite representation

The queue database filename is `queue_1.sqlite`, rooted in the configured
SQLite/Codex home:
[`codex-rs/state/src/sqlite.rs`](</Users/lherron/tools/codex/codex-rs/state/src/sqlite.rs#L29>)
and
[`sqlite.rs`](</Users/lherron/tools/codex/codex-rs/state/src/sqlite.rs#L153>).

`SqliteQueueStore::enqueue` inserts into `queued_items` with:

- a server-generated UUIDv7 submission ID;
- the thread ID;
- serialized `TurnInput` JSON;
- FIFO `queue_order` (`MAX(queue_order) + 1`);
- creation and update timestamps.

The insert is conditional on the thread having fewer than the configured
maximum queue entries. See
[`codex-rs/state/src/runtime/queued_items.rs`](</Users/lherron/tools/codex/codex-rs/state/src/runtime/queued_items.rs#L77>).

Queue mutations also maintain `queued_thread_revisions`, a durable index used
for efficient cross-process change discovery. The queue store reads that index
through `changes_since`:
[`queued_items.rs`](</Users/lherron/tools/codex/codex-rs/state/src/runtime/queued_items.rs#L49>).

### 6. Desktop cross-process discovery

Installing the queue extension registers it as a thread lifecycle contributor
and starts `watch_external_messages`:
[`codex-rs/ext/queue/src/lib.rs`](</Users/lherron/tools/codex/codex-rs/ext/queue/src/lib.rs#L13>).

The watcher checks SQLite's inexpensive `PRAGMA data_version` every ten seconds,
then queries the revision index only for threads loaded in its process:
[`codex-rs/ext/queue/src/service.rs`](</Users/lherron/tools/codex/codex-rs/ext/queue/src/service.rs#L89>).

For a changed loaded thread, it emits a queue-changed event and schedules an
independent dispatch task. If the thread is currently running, interrupted,
shutting down, or missing, the watcher does not start another turn immediately.
The durable queue entry remains available.

The same service is also a thread lifecycle contributor. When a non-interrupted
thread becomes idle, `on_thread_idle` calls `dispatch_if_idle`:
[`codex-rs/ext/queue/src/service.rs`](</Users/lherron/tools/codex/codex-rs/ext/queue/src/service.rs#L534>).

`dispatch_if_idle` reads the FIFO queue head and calls Core's
`start_turn_if_idle` with `turn_trigger = "queue"`. It removes the queue record
only after Core reports that the turn started successfully:
[`service.rs`](</Users/lherron/tools/codex/codex-rs/ext/queue/src/service.rs#L405>).

Consequently, a transient CLI process can write the queued submission and exit;
the long-running desktop process owns actual execution of its loaded thread.

## Why a Bare Command Differs Inside Cody

At inspection time, the HRC-managed seat had:

```text
CODEX_HOME=/Users/lherron/praesidium/var/spaces-repo/codex-homes/agent-spaces_cody
```

That home has its own `state_5.sqlite`, `queue_1.sqlite`, sessions, credentials,
and configuration. It intentionally isolates Cody's CLI runtime from the
desktop application's `/Users/lherron/.codex` state.

Therefore:

```bash
codex queue --thread 01a08138-7d09-7e12-b8ba-d82b744d9a1e --message '...'
```

when run unchanged from Cody resolves the HRC-specific home and cannot address
the desktop-only thread. By contrast:

```bash
env -u CODEX_HOME codex queue --thread 01a08138-7d09-7e12-b8ba-d82b744d9a1e --message '...'
```

falls back to `/Users/lherron/.codex`, finds the desktop thread and its rollout,
and writes into the queue database watched by PID `67078`.

This is a storage/routing distinction, not a permission or fundamental
capability limitation.

## Direct IPC and MCP Are Separate Surfaces

There are three mechanisms that should not be conflated:

1. **Desktop stdio app-server:** the Electron desktop process privately owns PID
   `67078`'s stdin/stdout JSONL connection.
2. **App-server control socket:** a separately enabled Unix-socket listener that
   accepts WebSocket-framed app-server JSON-RPC. `codex queue --remote` can use
   an explicit endpoint, and an ordinary command can auto-discover the default
   daemon socket when present.
3. **Durable queue database:** `queue_1.sqlite`, shared by Codex processes using
   the same SQLite home. This is the mechanism used in the observed successful
   desktop delivery when no default control socket was present.

The desktop's `codex_app.send_message_to_thread` MCP tool is a fourth,
desktop-hosted convenience surface. Cody did not have that dynamic MCP tool, but
it was unnecessary because the supported CLI exposes the durable queue path.

## Operational Notes

- `codex queue` queues only text; its CLI currently rejects image attachments.
- The message must be non-empty.
- Queue entries are FIFO and durable.
- Each thread can contain at most 100 queued submissions according to the
  app-server protocol documentation and store constant.
- A completed or failed turn permits automatic processing of the next queued
  item. An interrupted thread leaves its queue paused until explicitly resumed
  or started as described by the app-server contract.
- A queued entry is deleted only after Core accepts and starts the turn.
- Explicit `--remote` routes directly to the selected app-server instead of
  relying on a shared local SQLite home.
- The installed standalone CLI was one patch version newer than the desktop
  app-server during inspection (`0.153.4` versus `0.153.3`). The successful
  delivery demonstrates compatible queue schema and behavior for these builds,
  but future cross-version use should retain the CLI/app-server compatibility
  checks rather than bypassing them.

## Correction to the Initial Assessment

The initial assessment incorrectly treated the desktop's private stdio channel
and unavailable dynamic MCP tool as proof that an external queue operation was
impossible. That missed the dedicated `codex queue` CLI and its durable,
cross-process SQLite design. The corrected assessment is:

- direct access to the desktop's private stdio/MCP channel is unavailable from
  this seat;
- direct access is not required;
- Cody can use the supported `codex queue` command after selecting the desktop
  Codex home.
