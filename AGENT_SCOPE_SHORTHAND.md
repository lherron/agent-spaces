I agree with the feedback. `ScopeRef` should stay canonical and machine-stable, but it is too noisy as the primary human input form. Your current split already makes `agent-scope` the owner of semantic addressing, ACP the owner of routing/continuity, and `agent-spaces` the owner of runtime materialization, so the clean move is: add a **human-facing shorthand alias grammar upstream in `agent-scope`**, not in ACP alone. ACP already treats semantic addressing as upstream, and the runtime-profile proposal already moves single-agent runtime construction upstream to `agent-spaces`.  [oai_citation:0‡ACP_CONCEPTS.md](sediment://file_00000000daec71fdba97996c26d7d818)  [oai_citation:1‡AGENT_RUNTIME_PROFILE.md](sediment://file_00000000ae1071fd8af894157c67df0e)

My recommendation is:

`ScopeRef` remains canonical:
- `agent:alice:project:demo:task:t1`

Humans type a `ScopeHandle`:
- `alice@demo:t1`

And when continuity matters, humans type a `SessionHandle`:
- `alice@demo:t1~repair`

That keeps the wire/storage identity unchanged while making CLI/chat/UI interactions tolerable. It also avoids contaminating `scopeRef` itself with multiple serialized forms. I would be strict that `scopeRef` still means canonical only; shorthand should go in a separate input field like `target` or `session`. ACP Concepts already wants semantic grammar to live upstream, so this fits that boundary better than making ACP-specific aliases.  [oai_citation:2‡ACP_CONCEPTS.md](sediment://file_00000000daec71fdba97996c26d7d818)

The other important point is how this fits with the runtime-placement seam. It actually clarifies it:

`human handle -> canonical SessionRef -> host routing/bundle selection -> RuntimePlacement -> agent-spaces`

So shorthand belongs **before** `RuntimePlacement`. `agent-spaces` should keep consuming canonical machine-oriented input, not raw human shorthand. That matches the runtime-profile direction you already have: `agent-spaces` owns single-agent materialization, while ACP or another host owns semantic resolution and control-plane policy. The current proposal still underspecifies concrete bundle choice because `projectRoot` alone does not select a target/bundle; I kept the `RuntimePlacement` fix and made it coexist cleanly with the shorthand layer.  [oai_citation:3‡AGENT_RUNTIME_PROFILE.md](sediment://file_00000000ae1071fd8af894157c67df0e)

I would also avoid one tempting extension for now: context-relative shorthands like `@demo:t1` or `:t1`. They are nice in a shell, but they make normalization depend on ambient context, which is a bad default for a first portable upstream contract. Start with fully explicit shorthand only:
- `alice`
- `alice@demo`
- `alice@demo:t1`
- `alice@demo/reviewer`
- `alice@demo:t1/reviewer`
- optional lane suffix `~lane`

I wrote a patched spec bundle that incorporates this and folds `RuntimePlacement` into the upstream runtime-profile contract:

[README](sandbox:/mnt/data/scope-handle-spec-update/README.md?_chatgptios_conversationID=69c57b7a-f2f0-832b-ae82-26b1b6cc7216&_chatgptios_messageID=5149c392-52e9-40a2-bd08-0d44e1b2544c)  
[`agent-scope` v1.1](sandbox:/mnt/data/scope-handle-spec-update/AGENT_SCOPE_v1.1.md?_chatgptios_conversationID=69c57b7a-f2f0-832b-ae82-26b1b6cc7216&_chatgptios_messageID=5149c392-52e9-40a2-bd08-0d44e1b2544c)  
[`agent-spaces` runtime-profile v0.3](sandbox:/mnt/data/scope-handle-spec-update/AGENT_RUNTIME_PROFILE_v0.3.md?_chatgptios_conversationID=69c57b7a-f2f0-832b-ae82-26b1b6cc7216&_chatgptios_messageID=5149c392-52e9-40a2-bd08-0d44e1b2544c)  
[ACP Concepts patch v0.92](sandbox:/mnt/data/scope-handle-spec-update/ACP_CONCEPTS_v0.92_patch.md?_chatgptios_conversationID=69c57b7a-f2f0-832b-ae82-26b1b6cc7216&_chatgptios_messageID=5149c392-52e9-40a2-bd08-0d44e1b2544c)  
[ACP Agent/Home patch v0.3](sandbox:/mnt/data/scope-handle-spec-update/ACP_AGENT_v0.3_patch.md?_chatgptios_conversationID=69c57b7a-f2f0-832b-ae82-26b1b6cc7216&_chatgptios_messageID=5149c392-52e9-40a2-bd08-0d44e1b2544c)  
[zip bundle](sandbox:/mnt/data/scope-handle-spec-update.zip?_chatgptios_conversationID=69c57b7a-f2f0-832b-ae82-26b1b6cc7216&_chatgptios_messageID=5149c392-52e9-40a2-bd08-0d44e1b2544c)

Net: I think your feedback is correct, and the right architectural response is **not** to weaken canonical `ScopeRef`, but to add an upstream `ScopeHandle` / `SessionHandle` layer and keep `agent-spaces` on canonical `SessionRef + RuntimePlacement`.
