# Codex desktop compatibility readback

2026-09-08; Astra; preparation for codex-desktop-driver.md revision 1.

## Real desktop queue round-trip

Executable: `/Applications/ChatGPT.app/Contents/Resources/codex`, `codex-cli 0.153.3`.
Explicit CODEX_HOME: `/Users/lherron/.codex`.
Target: already-open desktop thread `01a08138-7d09-7e12-b8ba-d82b744d9a1e`.
No desktop thread start/resume call was used; helper was an independent stdio app-server.

- initialize returned `userAgent`, `codexHome`, `platformFamily`, `platformOs`.
- thread/queue/list returned `data`, `nextCursor`; initial queue empty.
- thread/queue/add accepted chosen client ID `f239d0b1-20d3-41b2-ae76-c512180a5113`.
- Returned native queue ID: `01a081ae-542e-7cc2-af31-2fd1d13983ed`.
- Immediate queue/list retained the same client ID.
- Desktop rollout line 853: `event_msg/item_completed`, `UserMessage.client_id` equal to chosen ID, turn `01a081ae-5f3d-7f71-8594-14a7480ed494`, at 2026-09-08T15:41:23.737Z.
- Line 858: `task_complete` for that turn at 15:41:26.834Z; final output `DESKTOP_QUEUE_PROBE_OK`.
- Final queue/list no longer contained the submission. Its removal was not used as the landing proof.

Probe requested only the exact marker, with no tools, messages, files or task mutations. Result: PASS. Original structured readback: `~/praesidium/var/tmp/codex-desktop-contract/queue-probe.json`.

## Hook startup/resume check

The bundled server discovers SessionStart hooks through hooks/list and validates persisted trust hashes. Test uses an isolated Codex home and workspace, never changes desktop hooks/config, and records only hook identity/path fields. thread/start alone does not guarantee a persisted rollout; a subsequent thread/resume before any turn returned `no rollout found`. Registration must tolerate delayed first-turn materialization. Startup/resume results follow below.

Final hook result: PASS using the bundled 0.153.3 in the isolated home. Two bounded marker-only model turns produced SessionStart `source=startup` and `source=resume`, both carrying the same native thread ID and transcript_path/cwd. Resume discovery was observed on the first turn after resume, not on the resume RPC alone. A follow-up covering UserPromptSubmit also passed: both startup and resumed turns carried session_id, turn_id and transcript_path. Final native test thread: `01a081b4-d496-7870-8663-01c873d6562c`. No desktop conversation was created for these isolated hook tests. The temporary auth-file symlink was removed. Structured readback: `~/praesidium/var/tmp/codex-desktop-contract/hooks-probe.json`.

## Source inspection limits

Queue insertion generates a fresh native submission ID per call; stable client ID is correlation, not deduplication. Shared-home helper and desktop do not negotiate each other's versions. Use the same installed bundle and inspect its generated experimental schema; do not call a standalone CLI fallback. JSONL is persisted execution evidence, not the complete private app-server event stream.
