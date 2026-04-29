# gateway-discord Refactor Notes

## Purpose

`gateway-discord` is the Discord interface gateway for ACP. It logs in a Discord bot, maps Discord channels and threads to ACP interface bindings, posts inbound Discord messages and attachments to `/v1/interface/messages`, polls ACP gateway delivery requests, and renders ACP responses back into Discord messages with chunking, buttons, inline images, and fetched media files.

## Public surface

The package binary is `acp-gateway-discord`, pointing at `src/main.ts`. The package export in `src/index.ts` exposes `GatewayDiscordApp`, `startGateway`, `log`, `BindingIndex`, `conversationKey`, `toConversationRefs`, Discord/config helpers, attachment helpers, `renderToDiscord`, `classifyDiscordError`, render helpers, `SessionEventsManager`, `runStateToFrame`, callback/run-state types, and the public gateway/render/event types from `src/types.ts`.

The runtime HTTP surface is outbound client behavior rather than package-owned routes. `GatewayDiscordApp` reads bindings from `GET /v1/interface/bindings?gatewayId=...`, posts inbound Discord messages to `POST /v1/interface/messages`, polls `GET /v1/gateway/:gatewayId/deliveries/stream`, and acknowledges or fails deliveries through `POST /v1/gateway/deliveries/:deliveryRequestId/ack` and `POST /v1/gateway/deliveries/:deliveryRequestId/fail`.

The binary is configured through `ACP_BASE_URL`/`CP_URL`, `ACP_GATEWAY_ID`/`CP_GATEWAY_ID`, `DISCORD_TOKEN`/`DISCORD_BLASTER_TOKEN`, `ACP_DISCORD_MAX_CHARS`/`CP_DISCORD_MAX_CHARS`, `ACP_BINDINGS_REFRESH_MS`/`CP_BINDINGS_REFRESH_MS`, `ACP_DELIVERY_POLL_MS`/`CP_DELIVERY_POLL_MS`, `ACP_DELIVERY_IDLE_MS`/`CP_DELIVERY_IDLE_MS`, `ACP_DISCORD_USE_BLOCKQUOTES`, `ACP_DISCORD_LOG_LEVEL`, `DISCORD_VIRTU_BOT_ID`, and `CP_DISCORD_MEDIA_MAX_BYTES`.

## Internal structure

- `src/main.ts` is the executable entry point and converts fatal startup errors into structured logs plus process exit.
- `src/app.ts` owns the gateway lifecycle, Discord client setup, binding refresh timer, delivery polling loop, inbound `MessageCreate` handling, placeholder creation/cleanup, ACP HTTP calls, and outbound delivery rendering.
- `src/bindings.ts` indexes Discord interface bindings by `conversationRef`/`threadRef`, supports thread-to-channel fallback, and converts between Discord ids and ACP refs.
- `src/attachment-ingress.ts` normalizes Discord attachment collections into ACP `InterfaceMessageAttachment` records and creates image/document placeholder text for attachment-only messages.
- `src/attachments.ts` converts base64 render images and local/remote `media_ref` blocks into Discord `AttachmentBuilder` instances.
- `src/render.ts` converts `RenderFrame` blocks into Discord content, extracts image/media attachments, chunks content below Discord message limits, wraps prose as code blocks or block quotes, preserves fenced code blocks, and maps render actions to Discord custom ids.
- `src/discord-render.ts` applies a `RenderFrame` to an existing Discord message handle or sends replacement messages, including permission buttons and attachment payloads.
- `src/markdown.ts` pads and wraps markdown table cells before table chunks are placed in code blocks.
- `src/session-events-manager.ts` maintains per-project run state from session events and converts run state to render frames, although the current `GatewayDiscordApp` delivery path does not instantiate it.
- `src/config.ts`, `src/logger.ts`, `src/discord-errors.ts`, and `src/types.ts` provide environment/default helpers, JSON logging, Discord API error classification, and shared type contracts.

## Dependencies

Production dependencies are `acp-core` for interface binding, delivery, and attachment request types; `discord.js` for the Discord client, messages, buttons, and attachments; and `spaces-runtime` for unified session event typing. Test/development dependencies are `@types/bun` and `typescript`; the e2e tests also import `withWiredServer` from `packages/acp-server/test/fixtures/wired-server.js`.

## Test coverage

I counted 16 `test(...)` cases under `src/tests`: 10 local e2e tests for ingress, placeholder reuse, delivery acknowledgement, image/document attachment ingress, fresh replies, render-frame media files, delivery body attachments, and thrown ACP ingress failures; 5 renderer tests for frame rendering, custom ids, code-block chunking, block-quote chunking, and code fence preservation; and 1 `SessionEventsManager` test for internal run suppression.

Gaps: `BindingIndex` fallback behavior, `conversationRefToChannelId`, `threadRefToThreadId`, environment parsing in `config.ts`, `classifyDiscordError`, `padMarkdownTables`, failed/oversized media fetch behavior in `fetchMediaAttachments`, Discord API failures during placeholder edits/deletes, bot-message filtering, unbound-channel replies, and delivery fail posting are not covered by focused tests. The e2e tests use fake Discord objects and a local ACP fixture, so they validate integration flow without exercising a real Discord API session.

## Recommended Refactors and Reductions

1. Split `src/app.ts` by responsibility. `GatewayDiscordApp` currently combines process lifecycle (`start`, `stop`, timers), ACP transport (`fetchJson`, `postJson`), inbound Discord ingress (`handleMessageCreate`), outbound delivery processing (`pollDeliveriesOnce`, `processDelivery`, `deliverToDiscord`), and placeholder management (`createPlaceholder`, `deletePlaceholder`, `failPlaceholder`) in one 546-line class. Extracting an ACP gateway client plus ingress/delivery services would make the stateful Discord shell smaller and easier to test.

2. Consolidate duplicate attachment rendering between `src/app.ts` and `src/discord-render.ts`. `deliverToDiscord` and `renderToDiscord` both call `extractImagesFromFrame`, `extractMediaRefsFromFrame`, `fetchMediaAttachments`, `createDiscordAttachments`, build a `filesPayload`, and attach files only to the final chunk. A shared `buildDiscordFilesForFrame` helper would remove drift between fresh replies and placeholder edits.

3. Reduce or justify the unused binding helpers in `src/bindings.ts`. `BindingIndex.getProjectIdFor`, `BindingIndex.getBoundChannelIds`, and `BindingIndex.getChannelForProject` are exported through the class but have no non-test or production callers in this package or the repo-wide TypeScript sources I searched. If no external consumer depends on them, removing them would shrink the public API and the class surface.

4. Reconcile `src/session-events-manager.ts` with the active delivery-stream architecture. `SessionEventsManager` and `runStateToFrame` are exported from `src/index.ts`, but the current gateway app never instantiates them and repo-wide TypeScript search found only the package test importing `SessionEventsManager`. Either wire this path into the gateway intentionally or move/remove it as legacy session-event rendering code.

5. Centralize MIME-to-extension handling. `src/config.ts` defines `MEDIA_MIME_EXT` for media refs, while `src/render.ts` keeps a separate `getExtensionForMimeType` map for inline render images. Combining those mappings would avoid inconsistent filename extensions as new media types are added.

6. Inject media fetching instead of using global `fetch` directly in `src/attachments.ts`. `GatewayDiscordApp` accepts `fetchImpl` for ACP calls, but `fetchMediaAttachments` uses global `fetch` and reads `CP_DISCORD_MEDIA_MAX_BYTES` directly. Passing a fetcher and max-byte setting through the render/delivery path would align media retrieval with the rest of the app's testable configuration boundary.
