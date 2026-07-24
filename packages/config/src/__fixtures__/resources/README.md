# Agent-Authored Runtime Resources Fixtures

These fixtures define the Phase A wire contract for `asp resources plan`.

The canonical plan envelope is:

- `schema`: `agent-authored-runtime-resources.plan/v1`
- `sourceOwnerScopeRef`: the owning agent scope
- `managedBy`: `agent-directory`
- `compiler`: the ASP resources compiler identity
- `resources`: `ManagedResourceProjection` records from the proposal's provenance contract

Each resource projection includes the canonical ACP desired projection in `desiredJson`.
`sourceHash` is computed from parsed TOML, not raw bytes. `desiredProjectionHash` is
computed from `desiredJson`. Both use `createCanonicalHasher()` with
`timestampMode: "omit-ephemeral"`.

The fixture root is `agents/smokey`, representing source owner
`agent:smokey:project:agent-spaces`.

Scheduled resources can request a new agent context on every run with top-level
`freshSession = true` and a non-empty `[input].content`:

```toml
freshSession = true

[input]
content = "Run this scheduled prompt in a fresh context."
```

The compiler preserves the normal top-level `input` projection and lowers this
sugar to `flow.sequence = [{ id = "run", fresh = true, input = content }]`.
When a flow is present, the flow owns dispatch semantics. Advanced or multi-step
jobs should omit `freshSession` and author the existing explicit form instead:

```toml
[[flow.sequence]]
id = "run"
fresh = true
input = "Run the first step in a fresh context."
```

`freshSession = true` cannot be combined with any authored `flow`.
