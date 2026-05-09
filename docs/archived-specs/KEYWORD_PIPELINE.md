# Discord Keyword Pipeline

## Goal

Support lightweight Discord message keywords without slash commands. Keywords are parsed from normal message content before the gateway posts inbound content to ACP, so channel users can route work with short prefixes such as:

```text
nt implement a new feature XTZ
```

## V1 Behavior

`nt <prompt>` starts a new Discord thread from the triggering channel message, creates a dedicated ACP interface binding for that thread, and dispatches `<prompt>` into a separate session continuity for that thread.

The derived session should keep the parent binding's `scopeRef` and use a thread-specific lane:

```ts
{
  scopeRef: parentBinding.sessionRef.scopeRef,
  laneRef: `lane:discord-${threadId}`,
}
```

This keeps the same agent/project placement while isolating the thread's context. A `SessionRef` is already uniquely identified by `{ scopeRef, laneRef }`, so V1 does not need a new `scopeRef` grammar segment.

## Pipeline

1. Discord `messageCreate` arrives.
2. Gateway ignores bot/self messages as it does today.
3. Gateway resolves the current channel/thread binding.
4. Gateway parses the first content token against a keyword registry.
5. If no keyword matches, the existing message ingress path runs unchanged.
6. If a keyword matches, the handler may transform content and/or conversation routing.
7. Gateway creates the usual placeholder in the final target channel/thread.
8. Gateway posts `/v1/interface/messages` with the transformed content and source conversation.
9. Existing ACP delivery routing sends assistant output back to the bound conversation.

## Keyword Contract

```ts
type DiscordKeywordHandler = {
  keyword: string
  aliases?: string[]
  match: 'first-token'
  handle(input: KeywordContext): Promise<KeywordResult>
}

type KeywordResult =
  | { kind: 'continue'; content: string; conversation: DiscordConversationLookup }
  | { kind: 'handled' }
  | { kind: 'reject'; message: string }
```

The gateway owns Discord-specific actions such as thread creation. ACP remains responsible for interface binding resolution, input attempts, runs, and delivery.

## `nt` Handler

For `nt <prompt>`:

1. Require a bound parent channel message.
2. Reject usage from inside an existing Discord thread.
3. Strip the keyword and validate the remaining prompt is non-empty.
4. Create a Discord thread from the triggering message.
5. Upsert `/v1/interface/bindings` for:
   - `gatewayId`
   - `conversationRef: channel:<parentChannelId>`
   - `threadRef: thread:<newThreadId>`
   - `sessionRef` using parent `scopeRef` plus `lane:discord-<newThreadId>`
   - parent `projectId`, when present
6. Dispatch the stripped prompt to `/v1/interface/messages` with the new thread source.

Retries should use the Discord message id as the idempotency key. The gateway should avoid creating duplicate threads for the same message within a running process, and the binding upsert keeps the ACP side stable.

## Future Keywords

- `r <prompt>`: route to reviewer role or reviewer lane.
- `qa <prompt>`: route to tester/QA session.
- `task <title>`: create a wrkq task and dispatch to a task-scoped session.
- `dm <agent> <prompt>`: route through coordination messages instead of interface ingress.

Each keyword should live as a small handler with focused tests. Unknown first tokens must remain normal message text.

## Validation

Automated coverage should include:

- normal messages still post unchanged to `/v1/interface/messages`
- `nt` creates a thread, creates a thread binding, and sends stripped prompt content
- `nt` uses `lane:discord-<threadId>` with the parent binding's `scopeRef`
- `nt` in an existing thread is rejected without dispatching
- duplicate handling of the same Discord message does not create duplicate threads in the same gateway process
